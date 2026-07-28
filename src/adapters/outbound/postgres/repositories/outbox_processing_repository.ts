import { canonicalSha256 } from "../../../../domain/ids/canonical_json.ts";
import { OutboxCursorSigner } from "../../../../domain/outbox/cursor.ts";
import type {
  DeliveryHookExecutor,
  DeliverySecretResolver,
  OutboxClaim,
  OutboxCursorPort,
  OutboxLifecyclePort,
  PinnedDeliveryHookCatalog,
} from "../../../../application/ports/outbox_processing.ts";
import type { OutboxConfig } from "../../../../application/services/process_outbox.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { DeliveryOutcome } from "../../../../domain/outbox/delivery.ts";
import type { ClaimedDelivery } from "../outbox_repository.ts";
import { query, type Queryable } from "../client.ts";

export type { OutboxConfig } from "../../../../application/services/process_outbox.ts";

export function loadOutboxConfig(env = Deno.env.toObject()): OutboxConfig {
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

type PhysicalOutboxLifecycle = Readonly<{
  claim(
    workerId: string,
    limit: number,
    leaseMarginMs: number,
    now: Date,
  ): Promise<ClaimedDelivery[]>;
  complete(
    claim: ClaimedDelivery,
    outcome: DeliveryOutcome,
    evidence: Readonly<{
      duration_ms: number;
      exit_code: number | null;
      logs: string;
      logs_truncated: boolean;
      secrets_redacted: boolean;
      grants: unknown[];
    }>,
    delayMs: number,
    now: Date,
  ): Promise<"succeeded" | "retry_wait" | "dead_letter" | "late">;
  list(
    filters: Parameters<OutboxLifecyclePort["list"]>[0]["filters"],
    limit: number,
    cursor: Parameters<OutboxLifecyclePort["list"]>[0]["cursor"],
  ): Promise<unknown[]>;
  inspect(id: string): Promise<unknown | null>;
  attempts(
    deliveryId: string,
    limit: number,
    after?: number,
  ): Promise<unknown[]>;
  retry(
    deliveryId: string,
    request?: Readonly<{
      authContextId: string;
      auth?: AuthContext;
      reason?: string;
    }>,
  ): Promise<
    | "pending"
    | "authorization_changed"
    | "delivery_not_found"
    | "delivery_not_retryable"
  >;
  cancel(
    deliveryId: string,
    request?: Readonly<{
      authContextId: string;
      auth?: AuthContext;
      reason?: string;
    }>,
  ): Promise<string>;
  auditDrain(authContextId: string, limit: number): Promise<void>;
}>;

export function makePostgresOutboxLifecyclePort(
  repository: PhysicalOutboxLifecycle,
): OutboxLifecyclePort {
  return {
    claim: (request) =>
      repository.claim(
        request.workerId,
        request.limit,
        request.leaseMarginMs,
        request.now,
      ),
    complete: (request) =>
      repository.complete(
        request.claim as ClaimedDelivery,
        request.outcome,
        { ...request.evidence, grants: [...request.evidence.grants] },
        request.delayMs,
        request.now,
      ),
    list: (request) =>
      repository.list(
        request.filters,
        request.limit,
        request.cursor,
      ) as Promise<Record<string, unknown>[]>,
    inspect: (id) =>
      repository.inspect(id) as Promise<Record<string, unknown> | null>,
    attempts: (request) =>
      repository.attempts(
        request.deliveryId,
        request.limit,
        request.after,
      ) as Promise<Record<string, unknown>[]>,
    retry: (request) =>
      repository.retry(
        request.deliveryId,
        {
          authContextId: request.authContextId,
          auth: request.auth,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      ),
    cancel: async (request) =>
      await repository.cancel(
        request.deliveryId,
        {
          authContextId: request.authContextId,
          auth: request.auth,
          ...(request.reason === undefined ? {} : { reason: request.reason }),
        },
      ) as Awaited<ReturnType<OutboxLifecyclePort["cancel"]>>,
    auditDrain: (audit) =>
      repository.auditDrain(audit.authContextId, audit.limit),
  };
}

export function makePostgresPinnedDeliveryHookCatalog(
  sql: Queryable,
): PinnedDeliveryHookCatalog {
  return { load: (claim) => loadPinned(sql, claim) };
}

type DeliverySecretStore = Readonly<{
  resolve(
    hookRevisionId: string,
    securityDigest: string,
    grants: ReturnType<typeof pinnedGrants>,
  ): Promise<
    Readonly<{
      values: Readonly<Record<string, string>>;
      evidence: readonly unknown[];
    }>
  >;
}>;

export function makePostgresDeliverySecretResolver(
  secrets: DeliverySecretStore,
): DeliverySecretResolver {
  return {
    async resolve(claim) {
      const resolved = await secrets.resolve(
        claim.hook_revision_id,
        claim.security_digest,
        pinnedGrants(claim.pinned_grants_json),
      );
      return {
        values: Object.freeze({ ...resolved.values }),
        evidence: Object.freeze([...resolved.evidence]),
      };
    },
  };
}

export type RawDeliveryHook = Readonly<{
  namespace: string;
  name: string;
  revision: string;
  scriptPath: string;
  scriptDigest: string;
  securityDigest: string;
  scriptContent: string;
  outputSchema: string;
  timeoutMs: number;
  permissions: Record<string, unknown>;
  secrets?: Array<{ name: string; env: string; slot: string }>;
}>;

export type RawDeliveryHookResult = Readonly<{
  ok: boolean;
  output?: Record<string, unknown>;
  durationMs: number;
  exitCode: number | null;
  logs: string;
  logsTruncated?: boolean;
  secretsRedacted?: boolean;
  error?: Readonly<{ code: string; message: string; details?: unknown }>;
}>;

export type RawDeliveryHookRunnerFactory = (
  secretValues: Readonly<Record<string, string>>,
) => Readonly<{
  run(hook: RawDeliveryHook, input: unknown): Promise<RawDeliveryHookResult>;
}>;

export function makeDeliveryHookExecutor(
  runnerFactory: RawDeliveryHookRunnerFactory,
): DeliveryHookExecutor {
  return {
    async run(request) {
      const hook = hookDefinition(
        request.claim,
        request.program.config,
        request.program.source,
      );
      hook.secrets = pinnedGrants(request.claim.pinned_grants_json).map((
        slot,
      ) => ({
        name: slot.env,
        env: slot.env,
        slot: slot.slot,
      }));
      const result = await runnerFactory({ ...request.secretValues }).run(
        hook,
        request.envelope,
      );
      return {
        ok: result.ok,
        output: result.output ?? null,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        logs: result.logs,
        logsTruncated: result.logsTruncated ?? false,
        secretsRedacted: result.secretsRedacted ?? false,
        ...(result.error === undefined ? {} : {
          error: { code: result.error.code, message: result.error.message },
        }),
      };
    },
  };
}

export function makeOutboxCursorPort(): OutboxCursorPort {
  let signer: OutboxCursorSigner | undefined;
  const cursors = () => signer ??= OutboxCursorSigner.fromEnvironment();
  return {
    decode: (cursor, filters) => cursors().decode(cursor, filters),
    encode: (value, filters) => cursors().encode(value, filters),
    decodeAttempt: (cursor, deliveryId) =>
      cursors().decodeAttempt(cursor, deliveryId),
    encodeAttempt: (deliveryId, attempt) =>
      cursors().encodeAttempt(deliveryId, attempt),
  };
}

async function loadPinned(sql: Queryable, claim: OutboxClaim) {
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
  const nestedConfigSpec = record(config.spec);
  const configSpec = Object.keys(nestedConfigSpec).length > 0
    ? nestedConfigSpec
    : config;
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
  return { source: row.hook_script_content, config };
}

function hookDefinition(
  claim: OutboxClaim,
  config: Record<string, unknown>,
  source: string,
): RawDeliveryHook & {
  secrets?: Array<{ name: string; env: string; slot: string }>;
} {
  const nestedSpec = record(config.spec);
  const spec = Object.keys(nestedSpec).length > 0 ? nestedSpec : config;
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
  };
}

function pinnedGrants(value: unknown): Array<{
  slot: string;
  env: string;
  grant_id: string | null;
  secret_id: string | null;
}> {
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
