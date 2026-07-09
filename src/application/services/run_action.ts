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
import type {
  DenoHookRunner,
  HookDefinition,
} from "../../adapters/outbound/deno-hooks/hook_runner.ts";
import type {
  ChangesetCommitDto,
  ChangesetPreviewDto,
  ChangesetRequest,
} from "./changeset_services.ts";
import {
  assertPolicyAllowed,
  authorizeObjectRuntime,
  normalizeActor,
  PolicyDeniedError,
} from "../../domain/policies/policy_engine.ts";

type JsonRecord = Record<string, unknown>;

export type ActionRequest = {
  actor?: string | JsonRecord;
  actor_id?: string;
  actor_context?: JsonRecord;
  input?: JsonRecord;
  idempotency_key?: string;
};
export type ActionDto = {
  action: string;
  hook: string;
  generated_operations: unknown[];
  changeset: ChangesetPreviewDto | ChangesetCommitDto;
};

export function makeRunActionService(deps: {
  sql: Queryable;
  hookRunner: DenoHookRunner;
  changesets: {
    preview(input: ChangesetRequest): Promise<Result<ChangesetPreviewDto>>;
    commit(input: ChangesetRequest): Promise<Result<ChangesetCommitDto>>;
  };
}) {
  return {
    async preview(
      namespace: string,
      action: string,
      input: ActionRequest,
    ): Promise<Result<ActionDto>> {
      return runAction(deps, namespace, action, input, "preview");
    },
    async commit(
      namespace: string,
      action: string,
      input: ActionRequest,
    ): Promise<Result<ActionDto>> {
      return runAction(deps, namespace, action, input, "commit");
    },
  };
}

async function runAction(
  deps: Parameters<typeof makeRunActionService>[0],
  namespace: string,
  name: string,
  request: ActionRequest,
  mode: "preview" | "commit",
): Promise<Result<ActionDto>> {
  try {
    const action = await loadAction(deps.sql, namespace, name);
    if (!action) {
      return err({
        code: "not_found",
        message: `action ${namespace}.${name} not found`,
        severity: "not_found",
      });
    }
    const hookRef = String(action.spec.hook ?? "");
    if (!hookRef) {
      return err(
        validationError(
          "action_missing_hook",
          `action ${namespace}.${name} has no hook`,
        ),
      );
    }
    const hookId = hookRef.includes(".") ? hookRef : `${namespace}.${hookRef}`;
    const hook = await loadHook(deps.sql, hookId);
    if (!hook) {
      return err(
        validationError("unknown_hook", `action hook ${hookId} not found`),
      );
    }

    const actor = actorOf(request);
    const leadId = typeof request.input?.lead_id === "string"
      ? request.input.lead_id
      : undefined;
    const lead = leadId
      ? await readActionLead(deps.sql, namespace, leadId)
      : null;
    const decision = await authorizeObjectRuntime(deps.sql, {
      actor,
      resource: lead ? `${namespace}.lead` : `${namespace}.${name}`,
      action: "action",
      fields: {},
      object: lead ?? request.input ?? {},
    });
    await assertPolicyAllowed(deps.sql, decision, {
      actor,
      resource: lead ? `${namespace}.lead` : `${namespace}.${name}`,
      action: "action",
      object_id: leadId,
    });

    const hookResult = await deps.hookRunner.run(hook, {
      hook: hook.name,
      phase: mode === "preview" ? "action.preview" : "action.commit",
      input: {
        ...(request.input ?? {}),
        lead,
        action_input: request.input ?? {},
      },
      metadata: {
        pack_revision: hook.revision,
        script_digest: hook.scriptDigest,
        action: `${namespace}.${name}`,
      },
    });
    await recordHookExecution(
      deps.sql,
      hook,
      hookResult,
      actor.id,
      `action.${mode}`,
    );
    if (!hookResult.ok) {
      return err(
        validationError(
          hookResult.error?.code ?? "hook_failed",
          hookResult.error?.message ?? "hook failed",
          hookResult.error?.details,
        ),
      );
    }
    const output = hookResult.output ?? {};
    const hookErrors = Array.isArray(output.errors) ? output.errors : [];
    if (hookErrors.length) {
      return err(
        validationError(
          "action_hook_validation",
          "action hook returned validation errors",
          { errors: hookErrors },
        ),
      );
    }
    const operations =
      (Array.isArray(output.operations) ? output.operations : [])
        .filter(isRecord)
        .map((op) => normalizeGeneratedOperation(op, namespace));
    const changesetInput: ChangesetRequest = {
      actor,
      idempotency_key: request.idempotency_key,
      source: `action:${namespace}.${name}`,
      operations: operations as ChangesetRequest["operations"],
    };
    const changeset = mode === "preview"
      ? await deps.changesets.preview(changesetInput)
      : await deps.changesets.commit(changesetInput);
    if (!changeset.ok) return changeset as Result<ActionDto>;
    return ok({
      action: `${namespace}.${name}`,
      hook: hookId,
      generated_operations: operations,
      changeset: changeset.value,
    });
  } catch (error) {
    if (error instanceof PolicyDeniedError) {
      return err(validationError(error.code, error.message, error.details));
    }
    return err(
      validationError(
        "bad_action",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
}

async function loadAction(
  sql: Queryable,
  namespace: string,
  name: string,
): Promise<{ spec: JsonRecord } | null> {
  const rows = await query<{ spec: unknown }>(
    sql,
    `select spec from action_definitions where namespace=$1 and name=$2 and revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  return rows.rows[0] ? { spec: asRecord(rows.rows[0].spec) } : null;
}

export async function loadHook(
  sql: Queryable,
  id: string,
): Promise<HookDefinition | null> {
  const [namespace, name] = splitId(id);
  if (!namespace || !name) return null;
  const rows = await query<
    {
      revision: string;
      namespace: string;
      name: string;
      script_path: string;
      script_digest: string;
      spec: unknown;
      content: string;
    }
  >(
    sql,
    `select h.revision,h.namespace,h.name,h.script_path,h.script_digest,h.spec,s.content
     from hook_definitions h join pack_source_files s on s.revision=h.revision and s.path=h.script_path
     where h.namespace=$1 and h.name=$2 and h.revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const spec = asRecord(row.spec);
  const permissions = asRecord(spec.permissions ?? {});
  const output = asRecord(spec.output ?? {});
  return {
    namespace: row.namespace,
    name: row.name,
    revision: row.revision,
    scriptPath: row.script_path,
    scriptDigest: row.script_digest,
    scriptContent: row.content,
    outputSchema: (output.schema === "patch.v1" ||
        output.schema === "changeset.operations.v1")
      ? output.schema
      : "validation.v1",
    timeoutMs: parseTimeoutMs(spec.timeout),
    permissions: {
      net: permissions.net === true,
      read: permissions.read === true,
      write: permissions.write === true,
      env: permissions.env === true,
      run: permissions.run === true,
    },
    secrets: Array.isArray(spec.secrets)
      ? spec.secrets.filter(isRecord).map((s) => ({
        name: String(s.name),
        env: String(s.env),
      }))
      : [],
  };
}

export async function recordHookExecution(
  sql: Queryable,
  hook: HookDefinition,
  result: {
    ok: boolean;
    logs: string;
    durationMs: number;
    exitCode: number | null;
    output?: JsonRecord;
    error?: { code: string; message: string; details: JsonRecord };
  },
  actorId: string,
  phase: string,
): Promise<string> {
  const id = crypto.randomUUID();
  await query(
    sql,
    `insert into hook_executions(id,hook,phase,revision,script_digest,actor_id,status,duration_ms,exit_code,logs,result_json,error_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb)`,
    [
      id,
      `${hook.namespace}.${hook.name}`,
      phase,
      hook.revision,
      hook.scriptDigest,
      actorId,
      result.ok ? "succeeded" : "failed",
      result.durationMs,
      result.exitCode,
      result.logs,
      JSON.stringify(result.output ?? null),
      JSON.stringify(result.error ?? null),
    ],
  );
  return id;
}

async function readActionLead(
  sql: Queryable,
  namespace: string,
  id: string,
): Promise<JsonRecord | null> {
  const rows = await query<{ table_name: string }>(
    sql,
    `select table_name from generated_sql_objects where kind='resource_table' and namespace=$1 and name='lead' and revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace],
  );
  const table = rows.rows[0]?.table_name;
  if (!table) return null;
  const lead = await query<JsonRecord>(
    sql,
    `select * from ${quoteIdent(table)} where id=$1 and archived_at is null`,
    [id],
  );
  return lead.rows[0] ?? null;
}

function normalizeGeneratedOperation(
  op: JsonRecord,
  namespace: string,
): JsonRecord {
  const out: JsonRecord = { ...op };
  if (typeof out.resource === "string" && !out.resource.includes(".")) {
    out.resource = `${namespace}.${out.resource}`;
  }
  if (typeof out.relationship === "string" && !out.relationship.includes(".")) {
    out.relationship = `${namespace}.${out.relationship}`;
  }
  if (out.expectedVersion !== undefined && out.expected_version === undefined) {
    out.expected_version = out.expectedVersion;
  }
  delete out.expectedVersion;
  return out;
}
function actorOf(input: ActionRequest) {
  if (input.actor_context) return normalizeActor(input.actor_context);
  if (input.actor && typeof input.actor === "object") {
    return normalizeActor(input.actor);
  }
  if (input.actor_id) return normalizeActor(input.actor_id);
  return normalizeActor(input.actor ?? "anonymous");
}
function parseTimeoutMs(value: unknown): number {
  if (typeof value !== "string") return 1_000;
  const match = value.match(/^(\d+)(ms|s)?$/);
  if (!match) return 1_000;
  const n = Number(match[1]);
  return match[2] === "ms" ? n : n * 1_000;
}
function splitId(id: string): [string | null, string | null] {
  const parts = id.split(".");
  return parts.length === 2 ? [parts[0], parts[1]] : [null, null];
}
function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
function quoteIdent(identifier: string): string {
  return '"' + identifier.replaceAll('"', '""') + '"';
}
