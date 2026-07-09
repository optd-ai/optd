import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import {
  query,
  type Queryable,
} from "../../adapters/outbound/postgres/client.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";
import type {
  DenoHookRunner,
  HookDefinition,
  HookRunResult,
} from "../../adapters/outbound/deno-hooks/hook_runner.ts";
import { loadHook, recordHookExecution } from "./run_action.ts";

type JsonRecord = Record<string, unknown>;

type OutboxStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "dead_letter";

type ClaimedOutboxRow = {
  id: string;
  event_id: string | null;
  hook: string;
  phase: string;
  attempts: number;
  payload_json: unknown;
  envelope_json: unknown;
};

export type OutboxListDto = {
  rows: Array<{
    id: string;
    event_id: string | null;
    hook: string;
    phase: string;
    status: OutboxStatus;
    attempts: number;
    available_at: string;
    locked_by: string | null;
    locked_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string | null;
  }>;
  totals: Record<OutboxStatus, number>;
};

export type OutboxDrainDto = {
  worker_id: string;
  claimed: number;
  succeeded: number;
  failed: number;
  dead_lettered: number;
  executions: Array<{
    outbox_id: string;
    hook_execution_id: string | null;
    status: "succeeded" | "failed" | "dead_letter";
    attempts: number;
    error: string | null;
  }>;
};

export type OutboxRetryDto = {
  id: string;
  status: OutboxStatus;
  attempts: number;
};

export function makeProcessOutboxService(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
  hookRunner: DenoHookRunner;
  maxAttempts?: number;
  claimLimitDefault?: number;
}) {
  const maxAttempts = deps.maxAttempts ?? 3;
  const claimLimitDefault = deps.claimLimitDefault ?? 25;
  return {
    async list(): Promise<Result<OutboxListDto>> {
      try {
        const rows = await query<OutboxListDto["rows"][number]>(
          deps.sql,
          `select id,event_id,hook,phase,status,attempts,available_at::text,locked_by,locked_at::text,last_error,created_at::text,updated_at::text
           from outbox order by created_at desc limit 200`,
        );
        const totalsRows = await query<{ status: OutboxStatus; count: string }>(
          deps.sql,
          "select status, count(*)::text as count from outbox group by status",
        );
        const totals: Record<OutboxStatus, number> = {
          pending: 0,
          running: 0,
          succeeded: 0,
          failed: 0,
          dead_letter: 0,
        };
        for (const row of totalsRows.rows) {
          totals[row.status] = Number(row.count);
        }
        return ok({ rows: rows.rows, totals });
      } catch (error) {
        return err(validationError("bad_outbox_list", message(error)));
      }
    },

    async drain(input: { limit?: number; worker_id?: string } = {}): Promise<
      Result<OutboxDrainDto>
    > {
      const workerId = input.worker_id ?? `worker-${crypto.randomUUID()}`;
      const limit = Math.max(
        1,
        Math.min(input.limit ?? claimLimitDefault, 100),
      );
      try {
        const claimed = await deps.tx.transaction((tx) =>
          claimOutbox(tx, workerId, limit)
        );
        const executions: OutboxDrainDto["executions"] = [];
        let succeeded = 0;
        let failed = 0;
        let deadLettered = 0;
        for (const row of claimed) {
          const result = await processOne(
            deps.sql,
            deps.hookRunner,
            row,
            maxAttempts,
          );
          executions.push(result);
          if (result.status === "succeeded") succeeded++;
          else if (result.status === "dead_letter") deadLettered++;
          else failed++;
        }
        return ok({
          worker_id: workerId,
          claimed: claimed.length,
          succeeded,
          failed,
          dead_lettered: deadLettered,
          executions,
        });
      } catch (error) {
        return err(validationError("bad_outbox_drain", message(error)));
      }
    },

    async retry(id: string): Promise<Result<OutboxRetryDto>> {
      try {
        const rows = await query<OutboxRetryDto>(
          deps.sql,
          `update outbox
           set status='pending', attempts=0, available_at=now(), locked_by=null, locked_at=null, last_error=null, updated_at=now()
           where id=$1 and status in ('failed','dead_letter')
           returning id,status,attempts`,
          [id],
        );
        const row = rows.rows[0];
        if (!row) {
          return err({
            code: "not_found",
            message: `retryable outbox row ${id} not found`,
            severity: "not_found",
          });
        }
        return ok(row);
      } catch (error) {
        return err(validationError("bad_outbox_retry", message(error)));
      }
    },
  };
}

async function claimOutbox(
  sql: Queryable,
  workerId: string,
  limit: number,
): Promise<ClaimedOutboxRow[]> {
  const rows = await query<ClaimedOutboxRow>(
    sql,
    `with claimable as (
       select id from outbox
       where status in ('pending','failed') and available_at <= now()
       order by created_at, id
       limit $1
       for update skip locked
     )
     update outbox o
     set status='running', attempts=o.attempts + 1, locked_by=$2, locked_at=now(), updated_at=now()
     from claimable
     where o.id = claimable.id
     returning o.id,o.event_id,o.hook,o.phase,o.attempts,o.payload_json,o.envelope_json`,
    [limit, workerId],
  );
  return rows.rows;
}

async function processOne(
  sql: Queryable,
  hookRunner: DenoHookRunner,
  row: ClaimedOutboxRow,
  maxAttempts: number,
): Promise<OutboxDrainDto["executions"][number]> {
  const hook = await loadHook(sql, row.hook);
  if (!hook) {
    const error = `hook ${row.hook} not found`;
    await markFailure(sql, row, maxAttempts, error);
    return {
      outbox_id: row.id,
      hook_execution_id: null,
      status: row.attempts >= maxAttempts ? "dead_letter" : "failed",
      attempts: row.attempts,
      error,
    };
  }

  const envelope = envelopeOf(row, hook);
  const result = await hookRunner.run(hook, envelope);
  const executionId = await recordHookExecution(
    sql,
    hook,
    result,
    actorIdOf(envelope.input),
    row.phase,
  );
  if (result.ok) {
    await query(
      sql,
      `update outbox
       set status='succeeded', locked_by=null, locked_at=null, last_error=null, updated_at=now()
       where id=$1`,
      [row.id],
    );
    return {
      outbox_id: row.id,
      hook_execution_id: executionId,
      status: "succeeded",
      attempts: row.attempts,
      error: null,
    };
  }

  const error = result.error?.message ?? (result.logs || "hook failed");
  const status = await markFailure(sql, row, maxAttempts, error, result);
  return {
    outbox_id: row.id,
    hook_execution_id: executionId,
    status,
    attempts: row.attempts,
    error,
  };
}

function envelopeOf(row: ClaimedOutboxRow, hook: HookDefinition) {
  const stored = asRecord(row.envelope_json);
  const payload = asRecord(row.payload_json);
  const input = asRecord(stored.input);
  return {
    hook: typeof stored.hook === "string" ? stored.hook : hook.name,
    phase: typeof stored.phase === "string" ? stored.phase : row.phase,
    input: {
      ...payload,
      ...input,
      outbox_id: row.id,
      event_id: row.event_id ?? input.event_id ?? payload.event_id,
      event: asRecord(input.event ?? payload.event ?? { id: row.event_id }),
    },
    metadata: {
      ...asRecord(stored.metadata),
      pack_revision: hook.revision,
      script_digest: hook.scriptDigest,
      outbox_id: row.id,
      event_id: row.event_id,
    },
  };
}

async function markFailure(
  sql: Queryable,
  row: ClaimedOutboxRow,
  maxAttempts: number,
  error: string,
  result?: HookRunResult,
): Promise<"failed" | "dead_letter"> {
  const dead = row.attempts >= maxAttempts;
  const status = dead ? "dead_letter" : "failed";
  await query(
    sql,
    `update outbox
     set status=$2, locked_by=null, locked_at=null, last_error=$3,
         available_at=case when $2='failed' then now() + ($4::text || ' seconds')::interval else available_at end,
         updated_at=now()
     where id=$1`,
    [
      row.id,
      status,
      result?.error?.message ?? error,
      String(backoffSeconds(row.attempts)),
    ],
  );
  return status;
}

function backoffSeconds(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.max(0, attempts - 1)));
}

function actorIdOf(input: JsonRecord): string {
  const actor = input.actor;
  if (typeof input.actor_id === "string") return input.actor_id;
  if (actor && typeof actor === "object" && !Array.isArray(actor)) {
    const id = (actor as JsonRecord).id;
    if (typeof id === "string") return id;
  }
  return "system:outbox";
}

function asRecord(value: unknown): JsonRecord {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
