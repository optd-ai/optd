import type { AuthContext } from "../../../domain/auth/model.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { DeliveryOutcome } from "../../../domain/outbox/delivery.ts";
import { boundedEvidence } from "../../../domain/outbox/delivery.ts";
import { query, type Queryable, type Sql } from "./client.ts";

export type ClaimedDelivery = {
  id: string;
  attempt_id: string;
  retry_generation: number;
  attempt_number: number;
  total_attempt_number: number;
  lease_expires_at: string;
  hook_revision_id: string;
  attachment_id: string;
  candidate_revision_id: string;
  hook_identity: string;
  script_digest: string;
  security_digest: string;
  attachment_digest: string;
  config_digest: string;
  output_schema: string;
  envelope_json: unknown;
  attachment_spec_json: unknown;
  hook_config_json: unknown;
  capabilities_json: unknown;
  pinned_grants_json: unknown;
  timeout_ms: number;
  max_attempts: number;
};

export type ExecutionEvidence = {
  duration_ms: number;
  exit_code: number | null;
  logs: string;
  logs_truncated: boolean;
  secrets_redacted: boolean;
  grants: unknown[];
};

export class PostgresOutboxRepository {
  constructor(
    private readonly sql: Sql,
    private readonly authorizeMutation?: (
      tx: Queryable,
      auth: AuthContext,
      action: "outbox.retry" | "outbox.cancel",
    ) => Promise<boolean>,
    private readonly observer?: {
      afterClaimRowsLocked?(ids: readonly string[]): Promise<void>;
      afterMutationRowLocked?(
        id: string,
        operation: "retry" | "cancel",
      ): Promise<void>;
    },
  ) {}

  async claim(
    workerId: string,
    limit: number,
    leaseMarginMs: number,
    now = new Date(),
  ): Promise<ClaimedDelivery[]> {
    return await this.sql.begin(async (tx) => {
      await expireLeases(tx, now);
      const rows = (await query<
        Omit<
          ClaimedDelivery,
          | "attempt_id"
          | "attempt_number"
          | "total_attempt_number"
          | "lease_expires_at"
        > & {
          attempts_in_generation: number;
          total_attempts: number;
        }
      >(
        tx,
        `select * from outbox_deliveries
        where status in ('pending','retry_wait') and available_at <= $1
        order by available_at,id limit $2 for update skip locked`,
        [now, limit],
      )).rows;
      await this.observer?.afterClaimRowsLocked?.(rows.map((row) => row.id));
      const claims: ClaimedDelivery[] = [];
      for (const row of rows) {
        const attemptId = uuidV7();
        const attemptNumber = Number(row.attempts_in_generation) + 1;
        const totalAttemptNumber = Number(row.total_attempts) + 1;
        const leaseExpires = new Date(
          now.getTime() + Number(row.timeout_ms) + leaseMarginMs,
        );
        await query(
          tx,
          `update outbox_deliveries set status='running',
          attempts_in_generation=$2,total_attempts=$3,lease_owner=$4,
          lease_attempt_id=$5,lease_expires_at=$6,updated_at=$1 where id=$7`,
          [
            now,
            attemptNumber,
            totalAttemptNumber,
            workerId,
            attemptId,
            leaseExpires,
            row.id,
          ],
        );
        await query(
          tx,
          `insert into outbox_attempts(id,delivery_id,retry_generation,
          attempt_number,total_attempt_number,worker_instance_id,hook_revision_id,
          idempotency_key,started_at,lease_expires_at,outcome)
          values($1,$2,$3,$4,$5,$6,$7,$2,$8,$9,'running')`,
          [
            attemptId,
            row.id,
            row.retry_generation,
            attemptNumber,
            totalAttemptNumber,
            workerId,
            row.hook_revision_id,
            now,
            leaseExpires,
          ],
        );
        claims.push({
          ...row,
          attempt_id: attemptId,
          attempt_number: attemptNumber,
          total_attempt_number: totalAttemptNumber,
          lease_expires_at: leaseExpires.toISOString(),
        });
      }
      return claims;
    }) as ClaimedDelivery[];
  }

  async complete(
    claim: ClaimedDelivery,
    outcome: DeliveryOutcome,
    evidence: ExecutionEvidence,
    retryDelayMs: number,
    now = new Date(),
  ): Promise<"succeeded" | "retry_wait" | "dead_letter" | "late"> {
    return await this.sql.begin(async (tx) => {
      const current = (await query<{
        status: string;
        lease_attempt_id: string | null;
        lease_expires_at: string | null;
      }>(
        tx,
        "select status,lease_attempt_id,lease_expires_at from outbox_deliveries where id=$1 for update",
        [claim.id],
      )).rows[0];
      const owns = current?.status === "running" &&
        current.lease_attempt_id === claim.attempt_id &&
        current.lease_expires_at !== null &&
        new Date(current.lease_expires_at).getTime() > now.getTime();
      const executionId = await recordExecution(tx, claim, evidence);
      if (!owns) {
        await query(
          tx,
          `update outbox_attempts set outcome=$2,completed_at=$3,
          error_code=$4,error_message=$5,hook_execution_id=$6,
          grant_evidence_json=$7::jsonb
          where id=$1 and outcome in ('running','lease_expired')`,
          [
            claim.attempt_id,
            outcome.outcome === "succeeded" ? "late_succeeded" : "late_failed",
            now,
            outcome.outcome === "succeeded" ? null : outcome.code,
            outcome.outcome === "succeeded"
              ? null
              : boundedEvidence(outcome.message),
            executionId,
            evidence.grants,
          ],
        );
        return "late" as const;
      }
      if (outcome.outcome === "succeeded") {
        await query(
          tx,
          `update outbox_attempts set outcome='succeeded',completed_at=$2,
          external_id=$3,hook_execution_id=$4,grant_evidence_json=$5::jsonb where id=$1`,
          [
            claim.attempt_id,
            now,
            outcome.external_id ?? null,
            executionId,
            evidence.grants,
          ],
        );
        await clearLease(tx, claim.id, "succeeded", now, null, null, now);
        return "succeeded" as const;
      }
      const exhausted = claim.attempt_number >= Number(claim.max_attempts);
      const dead = outcome.outcome === "dead_letter" || exhausted;
      const code = exhausted && outcome.outcome === "retry"
        ? "delivery_retry_exhausted"
        : outcome.code;
      const message = exhausted && outcome.outcome === "retry"
        ? "delivery exhausted its automatic retry generation"
        : outcome.message;
      await query(
        tx,
        `update outbox_attempts set outcome=$2,completed_at=$3,
        error_code=$4,error_message=$5,hook_execution_id=$6,
        grant_evidence_json=$7::jsonb where id=$1`,
        [
          claim.attempt_id,
          dead ? "dead_letter" : "retry",
          now,
          code,
          boundedEvidence(message),
          executionId,
          evidence.grants,
        ],
      );
      const availableAt = new Date(now.getTime() + Math.max(0, retryDelayMs));
      await clearLease(
        tx,
        claim.id,
        dead ? "dead_letter" : "retry_wait",
        now,
        code,
        boundedEvidence(message),
        availableAt,
      );
      return dead ? "dead_letter" as const : "retry_wait" as const;
    });
  }

  async list(
    filters: Record<string, unknown>,
    limit: number,
    cursor?: { created_at: string; id: string },
  ) {
    const values: unknown[] = [];
    const clauses: string[] = [];
    for (
      const [column, key] of [["status", "status"], ["hook_identity", "hook"], [
        "event_id",
        "event",
      ]] as const
    ) {
      if (typeof filters[key] === "string" && filters[key] !== "") {
        values.push(filters[key]);
        clauses.push(`${column}=$${values.length}`);
      }
    }
    if (typeof filters.from === "string") {
      values.push(filters.from);
      clauses.push(`created_at >= $${values.length}::timestamptz`);
    }
    if (typeof filters.to === "string") {
      values.push(filters.to);
      clauses.push(`created_at <= $${values.length}::timestamptz`);
    }
    if (cursor) {
      values.push(cursor.created_at, cursor.id);
      clauses.push(
        `(created_at,id) < ($${
          values.length - 1
        }::timestamptz,$${values.length}::uuid)`,
      );
    }
    values.push(limit + 1);
    return (await query(
      this.sql,
      `select id,event_id,hook_identity,status,
      retry_generation,attempts_in_generation,total_attempts,max_attempts,
      available_at::text,last_error_code,last_error_message,created_at::text,updated_at::text
      from outbox_deliveries ${
        clauses.length ? `where ${clauses.join(" and ")}` : ""
      }
      order by created_at desc,id desc limit $${values.length}`,
      values,
    )).rows;
  }

  async inspect(id: string) {
    return (await query(
      this.sql,
      `select delivery.id,delivery.event_id,event.object_version_id,
      delivery.attachment_id,delivery.hook_identity,delivery.hook_revision_id,
      delivery.candidate_revision_id,delivery.script_digest,delivery.security_digest,
      delivery.attachment_digest,delivery.config_digest,delivery.envelope_schema,
      delivery.output_schema,delivery.auth_context_id,delivery.changeset_commit_id,
      delivery.status,delivery.retry_generation,delivery.attempts_in_generation,
      delivery.total_attempts,delivery.max_attempts,delivery.available_at::text,
      delivery.last_error_code,delivery.last_error_message,
      delivery.created_at::text,delivery.updated_at::text,
      coalesce(summary.by_outcome,'{}'::jsonb) attempts_by_outcome,
      summary.latest_attempt_id,summary.latest_outcome,summary.latest_completed_at::text
      from outbox_deliveries delivery
      join events event on event.id=delivery.event_id
      left join lateral (
        select jsonb_object_agg(outcome,count) by_outcome,
          (array_agg(id order by total_attempt_number desc))[1] latest_attempt_id,
          (array_agg(outcome order by total_attempt_number desc))[1] latest_outcome,
          (array_agg(completed_at order by total_attempt_number desc))[1] latest_completed_at
        from (select id,outcome,completed_at,total_attempt_number,
          count(*) over(partition by outcome) count
          from outbox_attempts where delivery_id=delivery.id) attempts
      ) summary on true
      where delivery.id=$1`,
      [id],
    )).rows[0] ?? null;
  }

  async attempts(id: string, limit: number, after = 0) {
    return (await query(
      this.sql,
      `select id,retry_generation,attempt_number,total_attempt_number,
      worker_instance_id,hook_revision_id,idempotency_key,
      started_at::text,lease_expires_at::text,completed_at::text,
      outcome,error_code,error_message,external_id,hook_execution_id,
      grant_evidence_json
      from outbox_attempts
      where delivery_id=$1 and total_attempt_number>$2
      order by total_attempt_number,id limit $3`,
      [id, after, limit],
    )).rows;
  }

  async auditDrain(authContextId: string, limit: number): Promise<void> {
    await this.sql.begin(async (tx) => {
      await adminAudit(tx, "outbox.drain", "batch", {
        authContextId,
        reason: `limit=${limit}`,
      });
    });
  }

  async retry(
    id: string,
    audit?: { authContextId: string; auth?: AuthContext; reason?: string },
    now = new Date(),
  ) {
    return await this.sql.begin(async (tx) => {
      const row = (await query<{ status: string }>(
        tx,
        "select status from outbox_deliveries where id=$1 for update",
        [id],
      )).rows[0];
      if (!row) return "delivery_not_found" as const;
      await this.observer?.afterMutationRowLocked?.(id, "retry");
      if (
        audit?.auth && this.authorizeMutation &&
        !await this.authorizeMutation(tx, audit.auth, "outbox.retry")
      ) return "authorization_changed" as const;
      if (row.status !== "dead_letter") {
        return "delivery_not_retryable" as const;
      }
      await query(
        tx,
        `update outbox_deliveries set status='pending',
        retry_generation=retry_generation+1,attempts_in_generation=0,
        available_at=$2,lease_owner=null,lease_attempt_id=null,lease_expires_at=null,
        last_error_code=null,last_error_message=null,updated_at=$2 where id=$1`,
        [id, now],
      );
      if (audit) await adminAudit(tx, "outbox.retry", id, audit);
      return "pending" as const;
    });
  }

  async cancel(
    id: string,
    audit?: { authContextId: string; auth?: AuthContext; reason?: string },
    now = new Date(),
  ) {
    return await this.sql.begin(async (tx) => {
      const row = (await query<{ status: string }>(
        tx,
        "select status from outbox_deliveries where id=$1 for update",
        [id],
      )).rows[0];
      if (!row) return "delivery_not_found" as const;
      await this.observer?.afterMutationRowLocked?.(id, "cancel");
      if (
        audit?.auth && this.authorizeMutation &&
        !await this.authorizeMutation(tx, audit.auth, "outbox.cancel")
      ) return "authorization_changed" as const;
      if (row.status === "running") return "delivery_in_progress" as const;
      if (["succeeded", "dead_letter", "cancelled"].includes(row.status)) {
        return row.status;
      }
      await query(
        tx,
        `update outbox_deliveries set status='cancelled',updated_at=$2,
        lease_owner=null,lease_attempt_id=null,lease_expires_at=null where id=$1`,
        [id, now],
      );
      if (audit) await adminAudit(tx, "outbox.cancel", id, audit);
      return "cancelled" as const;
    });
  }
}

async function recordExecution(
  tx: Queryable,
  claim: ClaimedDelivery,
  evidence: ExecutionEvidence,
): Promise<string> {
  const executionId = uuidV7();
  const inserted = await query<{ id: string }>(
    tx,
    `insert into outbox_hook_executions(id,delivery_id,attempt_id,
      hook_revision_id,attachment_id,script_digest,security_digest,attachment_digest,
      config_digest,duration_ms,exit_code,logs,logs_truncated,secrets_redacted,
      grant_evidence_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      $13,$14,$15::jsonb) on conflict(attempt_id) do nothing returning id`,
    [
      executionId,
      claim.id,
      claim.attempt_id,
      claim.hook_revision_id,
      claim.attachment_id,
      claim.script_digest,
      claim.security_digest,
      claim.attachment_digest,
      claim.config_digest,
      Math.max(0, Math.floor(evidence.duration_ms)),
      evidence.exit_code,
      boundedEvidence(evidence.logs, 1_000_000),
      evidence.logs_truncated,
      evidence.secrets_redacted,
      evidence.grants,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0].id;
  const existing = (await query<{ id: string }>(
    tx,
    "select id from outbox_hook_executions where attempt_id=$1",
    [claim.attempt_id],
  )).rows[0];
  if (!existing) throw new Error("outbox execution evidence is unavailable");
  return existing.id;
}

async function expireLeases(tx: Queryable, now: Date): Promise<void> {
  const expired = (await query<{ id: string; lease_attempt_id: string }>(
    tx,
    `select id,lease_attempt_id from outbox_deliveries where status='running'
     and lease_expires_at <= $1 order by lease_expires_at,id for update skip locked`,
    [now],
  )).rows;
  for (const row of expired) {
    await query(
      tx,
      `update outbox_attempts set outcome='lease_expired',completed_at=$2,
      error_code='lease_expired',error_message='worker fixed lease expired'
      where id=$1 and outcome='running'`,
      [row.lease_attempt_id, now],
    );
    await clearLease(
      tx,
      row.id,
      "pending",
      now,
      "lease_expired",
      "worker fixed lease expired",
      now,
    );
  }
}

async function adminAudit(
  tx: Queryable,
  action: string,
  deliveryId: string,
  audit: { authContextId: string; reason?: string },
) {
  await query(
    tx,
    `insert into audit_events(id,auth_context_id,event_type,action,decision,
      policy_summary_json,request_metadata_json)
     values($1,$2,$3,$3,'committed',$4::jsonb,$5::jsonb)`,
    [
      uuidV7(),
      audit.authContextId,
      action,
      { resource: "system:outbox", delivery_id: deliveryId },
      audit.reason === undefined
        ? {}
        : { reason: boundedEvidence(audit.reason) },
    ],
  );
}

async function clearLease(
  tx: Queryable,
  id: string,
  status: string,
  now: Date,
  code: string | null,
  message: string | null,
  availableAt: Date,
) {
  await query(
    tx,
    `update outbox_deliveries set status=$2,available_at=$3,
    lease_owner=null,lease_attempt_id=null,lease_expires_at=null,
    last_error_code=$4,last_error_message=$5,updated_at=$6 where id=$1`,
    [id, status, availableAt, code, message, now],
  );
}
