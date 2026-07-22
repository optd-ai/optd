import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import { uuidV7 } from "../../domain/ids/uuid_v7.ts";
import { canonicalSha256 } from "../../domain/ids/canonical_json.ts";
import {
  type DeliveryOutcome,
  parseDeliveryOutput,
  retryDelayMs,
} from "../../domain/outbox/delivery.ts";
import { OutboxCursorSigner } from "../../domain/outbox/cursor.ts";
import { attemptDto, deliveryDto } from "../../domain/outbox/dto.ts";
import {
  DenoHookRunner,
  type DenoHookRunnerOptions,
  type HookDefinition,
} from "../../adapters/outbound/deno-hooks/hook_runner.ts";
import {
  type ClaimedDelivery,
  PostgresOutboxRepository,
} from "../../adapters/outbound/postgres/outbox_repository.ts";
import type { PostgresHookSecretRepository } from "../../adapters/outbound/postgres/hook_secret_repository.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import {
  query,
  type Queryable,
} from "../../adapters/outbound/postgres/client.ts";

export type OutboxConfig = ReturnType<typeof loadOutboxConfig>;

export function loadOutboxConfig(env = Deno.env.toObject()) {
  return {
    pollIntervalMs: integer(
      env.OPERANT_OUTBOX_POLL_INTERVAL_MS,
      1_000,
      10,
      60_000,
    ),
    batchSize: integer(env.OPERANT_OUTBOX_BATCH_SIZE, 25, 1, 100),
    leaseMarginMs: integer(
      env.OPERANT_OUTBOX_LEASE_MARGIN_MS,
      30_000,
      1_000,
      600_000,
    ),
    initialBackoffMs: integer(
      env.OPERANT_OUTBOX_INITIAL_BACKOFF_MS,
      5_000,
      1,
      3_600_000,
    ),
    maximumBackoffMs: integer(
      env.OPERANT_OUTBOX_MAX_BACKOFF_MS,
      3_600_000,
      1,
      86_400_000,
    ),
    maximumRetryAfterMs: integer(
      env.OPERANT_OUTBOX_MAX_RETRY_AFTER_MS,
      3_600_000,
      1,
      86_400_000,
    ),
    shutdownGraceMs: integer(
      env.OPERANT_OUTBOX_SHUTDOWN_GRACE_MS,
      30_000,
      1,
      600_000,
    ),
  };
}

export function makeProcessOutboxService(deps: {
  sql: Queryable;
  repository: PostgresOutboxRepository;
  authorization: AuthorizationRepository;
  secrets: PostgresHookSecretRepository;
  hookRunnerOptions?: DenoHookRunnerOptions;
  config?: OutboxConfig;
  random?: () => number;
  now?: () => Date;
  workerId?: string;
  runnerFactory?: (
    options: DenoHookRunnerOptions,
  ) => Pick<DenoHookRunner, "run">;
}) {
  const config = deps.config ?? loadOutboxConfig();
  if (config.maximumBackoffMs < config.initialBackoffMs) {
    throw new Error(
      "OPERANT_OUTBOX_MAX_BACKOFF_MS must not be below initial backoff",
    );
  }
  const workerId = deps.workerId ?? uuidV7();
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const runnerFactory = deps.runnerFactory ??
    ((options: DenoHookRunnerOptions) => new DenoHookRunner(options));
  let cursors: OutboxCursorSigner | undefined;

  async function processBatch(limit = config.batchSize) {
    const claims = await deps.repository.claim(
      workerId,
      Math.max(1, Math.min(limit, config.batchSize)),
      config.leaseMarginMs,
      now(),
    );
    const executions = await Promise.all(claims.map(processOne));
    return { worker_id: workerId, claimed: claims.length, executions };
  }

  async function processOne(claim: ClaimedDelivery) {
    let outcome: DeliveryOutcome;
    let evidence: ReturnType<typeof emptyEvidence> = emptyEvidence();
    try {
      const loaded = await loadPinned(deps.sql, claim);
      const grants = await deps.secrets.resolve(
        claim.hook_revision_id,
        claim.security_digest,
        pinnedGrants(claim.pinned_grants_json),
      );
      const secretValues: Record<string, string> = {};
      for (const [env, value] of Object.entries(grants.values)) {
        secretValues[env] = value;
      }
      const hook = hookDefinition(claim, loaded.config, loaded.source);
      hook.secrets = pinnedGrants(claim.pinned_grants_json).map((slot) => ({
        name: slot.env,
        env: slot.env,
        slot: slot.slot,
      }));
      const runner = runnerFactory({
        ...deps.hookRunnerOptions,
        secretValues,
      });
      const envelope = record(claim.envelope_json);
      const metadata = record(envelope.metadata);
      envelope.metadata = {
        ...metadata,
        delivery: {
          delivery_id: claim.id,
          idempotency_key: claim.id,
          attempt_id: claim.attempt_id,
          retry_generation: Number(claim.retry_generation),
          attempt_number: claim.attempt_number,
          total_attempt_number: claim.total_attempt_number,
        },
      };
      const result = await runner.run(hook, envelope as never);
      evidence = {
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        logs: result.logs,
        logs_truncated: result.logsTruncated ?? false,
        secrets_redacted: result.secretsRedacted ?? false,
        grants: grants.evidence,
      };
      if (!result.ok) {
        const runnerCode = result.error?.code ?? "hook_execution_failed";
        const permanentRunnerCode = [
          "hook_capability_denied",
          "hook_import_denied",
          "hook_env_unavailable",
          "hook_secret_unavailable",
          "hook_invalid_output",
          "hook_stdout_limit",
        ].includes(runnerCode);
        outcome = permanentRunnerCode
          ? {
            outcome: "dead_letter",
            code: runnerCode === "hook_invalid_output" ||
                runnerCode === "hook_stdout_limit"
              ? "delivery_output_invalid"
              : runnerCode === "hook_capability_denied"
              ? "capability_unavailable"
              : runnerCode,
            message: result.error?.message ?? "pinned hook cannot execute",
          }
          : {
            outcome: "retry",
            code: runnerCode,
            message: result.error?.message ?? "hook execution was interrupted",
          };
      } else {
        outcome = parseDeliveryOutput(result.output) ?? {
          outcome: "dead_letter",
          code: "delivery_output_invalid",
          message: "hook returned invalid delivery.v1 output",
        };
      }
    } catch (error) {
      outcome = permanentFailure(error);
    }
    const delay = outcome.outcome === "retry"
      ? retryDelayMs(
        claim.attempt_number,
        outcome.retry_after_ms,
        config.maximumRetryAfterMs,
        random,
        config.initialBackoffMs,
        config.maximumBackoffMs,
      )
      : 0;
    const status = await deps.repository.complete(
      claim,
      outcome,
      evidence,
      delay,
      now(),
    );
    return { delivery_id: claim.id, attempt_id: claim.attempt_id, status };
  }

  async function authorize(
    auth: AuthContext,
    action: string,
  ): Promise<Result<unknown>> {
    return await deps.authorization.authorize({
      auth,
      boundary: { type: "system" },
      action,
      resource: "system:outbox",
    });
  }

  return {
    workerId,
    config,
    processBatch,
    async list(
      input: Record<string, unknown>,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.inspect");
      if (!allowed.ok) return allowed;
      const limit = optionalInteger(input.limit, 50, 1, 100);
      if (limit === null) {
        return err(validationError("bad_request", "limit is invalid"));
      }
      const filters = {
        status: input.status,
        hook: input.hook,
        event: input.event,
        since: input.since,
        until: input.until,
      };
      if (
        typeof filters.status === "string" &&
        ![
          "pending",
          "running",
          "retry_wait",
          "succeeded",
          "dead_letter",
          "cancelled",
        ].includes(filters.status)
      ) {
        return err(validationError("bad_request", "status is invalid"));
      }
      let cursor: { created_at: string; id: string } | undefined;
      if (typeof input.cursor === "string") {
        try {
          cursors ??= OutboxCursorSigner.fromEnvironment();
          cursor = await cursors.decode(input.cursor, filters);
        } catch {
          return err(
            validationError(
              "invalid_cursor",
              "outbox cursor is invalid for these filters",
            ),
          );
        }
      }
      const rows = await deps.repository.list(
        filters,
        limit,
        cursor ?? undefined,
      );
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(deliveryDto);
      const last = items.at(-1) as
        | { created_at?: string; id?: string }
        | undefined;
      const nextCursor = hasMore && last?.created_at && last.id
        ? await (cursors ??= OutboxCursorSigner.fromEnvironment()).encode(
          { created_at: last.created_at, id: last.id },
          filters,
        )
        : null;
      return ok({ items, page: { limit, next_cursor: nextCursor } });
    },
    async inspect(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.inspect");
      if (!allowed.ok) return allowed;
      const row = await deps.repository.inspect(id);
      return row
        ? ok(deliveryDto(row))
        : deliveryError("delivery_not_found", "not_found");
    },
    async attempts(
      id: string,
      input: Record<string, unknown>,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.inspect");
      if (!allowed.ok) return allowed;
      const limit = optionalInteger(input.limit, 50, 1, 100);
      const after = optionalInteger(input.after, 0, 0, Number.MAX_SAFE_INTEGER);
      if (limit === null || after === null) {
        return err(
          validationError("bad_request", "attempt pagination is invalid"),
        );
      }
      if (!await deps.repository.inspect(id)) {
        return deliveryError("delivery_not_found", "not_found");
      }
      const rows = await deps.repository.attempts(id, limit + 1, after);
      return ok({
        items: rows.slice(0, limit).map(attemptDto),
        page: {
          limit,
          next_after: rows.length > limit
            ? (rows[limit - 1] as { total_attempt_number: number })
              .total_attempt_number
            : null,
        },
      });
    },
    async retry(
      id: string,
      _reason: string | undefined,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.retry");
      if (!allowed.ok) return allowed;
      const status = await deps.repository.retry(id, {
        authContextId: auth.id,
        auth,
        ...(_reason === undefined ? {} : { reason: _reason }),
      });
      if (status !== "pending") {
        if (status === "authorization_changed") {
          return err({
            code: "authorization_changed",
            message: "outbox authority changed before mutation",
            severity: "authorization",
          });
        }
        return deliveryError(
          status,
          status === "delivery_not_found" ? "not_found" : "conflict",
        );
      }
      return ok(deliveryDto(await deps.repository.inspect(id)));
    },
    async cancel(
      id: string,
      _reason: string | undefined,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.cancel");
      if (!allowed.ok) return allowed;
      const status = await deps.repository.cancel(id, {
        authContextId: auth.id,
        auth,
        ...(_reason === undefined ? {} : { reason: _reason }),
      });
      if (status === "authorization_changed") {
        return err({
          code: "authorization_changed",
          message: "outbox authority changed before mutation",
          severity: "authorization",
        });
      }
      if (
        status === "delivery_not_found" || status === "delivery_in_progress"
      ) {
        return deliveryError(
          status,
          status === "delivery_not_found" ? "not_found" : "conflict",
        );
      }
      return ok(deliveryDto(await deps.repository.inspect(id)));
    },
    async drain(
      limit: number | undefined,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const allowed = await authorize(auth, "outbox.drain");
      if (!allowed.ok) return allowed;
      if (
        limit !== undefined &&
        (!Number.isSafeInteger(limit) || limit < 1 || limit > config.batchSize)
      ) {
        return err(validationError("bad_request", "drain limit is invalid"));
      }
      await deps.repository.auditDrain(auth.id, limit ?? config.batchSize);
      return ok(await processBatch(limit));
    },
  };
}

async function loadPinned(sql: Queryable, claim: ClaimedDelivery) {
  const row = (await query<{
    hook_script_content: string;
    hook_script_digest: string;
    hook_security_digest: string;
    hook_normalized_config: unknown;
    declaration_digest: string;
    declaration_spec: unknown;
    enabled: boolean;
  }>(
    sql,
    `select hook.hook_script_content,hook.hook_script_digest,
    hook.hook_security_digest,hook.hook_normalized_config,
    attachment.declaration_digest,attachment.declaration_spec,
    coalesce(control.enabled,true) enabled
    from pack_component_revisions hook
    join pack_hook_attachment_revisions attachment on attachment.id=$2
      and attachment.hook_revision_id=hook.id and attachment.candidate_revision_id=$3
    left join hook_revision_delivery_controls control on control.hook_revision_id=hook.id
    where hook.id=$1`,
    [claim.hook_revision_id, claim.attachment_id, claim.candidate_revision_id],
  )).rows[0];
  if (!row) {
    throw permanent("pinned_hook_missing", "pinned hook revision is missing");
  }
  if (!row.enabled) {
    throw permanent("pinned_hook_disabled", "pinned hook revision is disabled");
  }
  const config = record(row.hook_normalized_config);
  const configSpec = record(config.spec);
  const output = record(configSpec.output);
  if (
    row.hook_script_digest !== claim.script_digest ||
    row.hook_security_digest !== claim.security_digest ||
    row.declaration_digest !== claim.attachment_digest ||
    `sha256:${await canonicalSha256(row.declaration_spec)}` !==
      row.declaration_digest ||
    await canonicalSha256(row.declaration_spec) !==
      await canonicalSha256(claim.attachment_spec_json) ||
    `sha256:${await canonicalSha256(config)}` !== claim.config_digest ||
    claim.output_schema !== "delivery.v1" || output.schema !== "delivery.v1"
  ) {
    throw permanent(
      "pinned_hook_digest_mismatch",
      "pinned hook evidence does not match",
    );
  }
  return {
    source: row.hook_script_content,
    config,
  };
}

function hookDefinition(
  claim: ClaimedDelivery,
  config: Record<string, unknown>,
  source: string,
): HookDefinition {
  const spec = record(config.spec);
  return {
    namespace: claim.hook_identity.split(":")[0],
    name: claim.hook_identity,
    revision: claim.hook_revision_id,
    scriptPath: "pinned.ts",
    scriptDigest: claim.script_digest,
    securityDigest: claim.security_digest,
    scriptContent: source,
    outputSchema: "delivery.v1",
    timeoutMs: claim.timeout_ms,
    permissions: record(spec.permissions),
  } as HookDefinition;
}

function pinnedGrants(
  value: unknown,
): Array<
  {
    slot: string;
    env: string;
    grant_id: string | null;
    secret_id: string | null;
  }
> {
  if (!Array.isArray(value)) {
    throw permanent(
      "hook_secret_grant_unavailable",
      "pinned grants are invalid",
    );
  }
  return value.map((item) => {
    const row = record(item);
    if (
      typeof row.slot !== "string" || typeof row.env !== "string" ||
      typeof row.grant_id !== "string" || typeof row.secret_id !== "string"
    ) {
      throw permanent(
        "hook_secret_grant_unavailable",
        "pinned hook-secret grant is unavailable",
      );
    }
    return {
      slot: row.slot,
      env: row.env,
      grant_id: row.grant_id,
      secret_id: row.secret_id,
    };
  });
}

function permanent(code: string, message: string) {
  return Object.assign(new Error(message), { outboxCode: code });
}
function permanentFailure(error: unknown): DeliveryOutcome {
  const code = error && typeof error === "object" && "outboxCode" in error
    ? String((error as { outboxCode: unknown }).outboxCode)
    : error && typeof error === "object" && "code" in error &&
        ["hook_secret_unavailable", "hook_secret_grant_unavailable"].includes(
          String((error as { code: unknown }).code),
        )
    ? String((error as { code: unknown }).code)
    : "pinned_hook_missing";
  return {
    outcome: "dead_letter",
    code,
    message: error instanceof Error
      ? error.message
      : "pinned execution is unavailable",
  };
}
function emptyEvidence() {
  return {
    duration_ms: 0,
    exit_code: null as number | null,
    logs: "",
    logs_truncated: false,
    secrets_redacted: false,
    grants: [] as unknown[],
  };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") value = JSON.parse(value);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function integer(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error("invalid outbox operator configuration");
  }
  return number;
}
function optionalInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) return fallback;
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) &&
      number >= minimum && number <= maximum
    ? number
    : null;
}
function deliveryError(
  code: string,
  severity: "not_found" | "conflict",
): Result<never> {
  return err({
    code,
    message: code === "delivery_in_progress"
      ? "delivery is already running and cannot be cancelled"
      : "delivery operation is unavailable",
    severity,
  });
}
