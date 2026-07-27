import type { AuthContext } from "../../domain/auth/model.ts";
import { isUuidV7 } from "../../domain/ids/uuid_v7.ts";
import {
  type DeliveryOutcome,
  parseDeliveryOutput,
  retryDelayMs,
} from "../../domain/outbox/delivery.ts";
import { normalizeFilters } from "../../domain/outbox/cursor.ts";
import { attemptDto, deliveryDto } from "../../domain/outbox/dto.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type {
  DeliveryHookExecutor,
  DeliverySecretResolver,
  OutboxAuthorizationPort,
  OutboxClaim,
  OutboxCursorPort,
  OutboxLifecyclePort,
  PinnedDeliveryHookCatalog,
} from "../ports/outbox_processing.ts";

export type OutboxConfig = Readonly<{
  pollIntervalMs: number;
  batchSize: number;
  leaseMarginMs: number;
  initialBackoffMs: number;
  maximumBackoffMs: number;
  maximumRetryAfterMs: number;
  shutdownGraceMs: number;
}>;

export function makeProcessOutboxService(deps: {
  repository: OutboxLifecyclePort;
  authorization: OutboxAuthorizationPort;
  catalog: PinnedDeliveryHookCatalog;
  secrets: DeliverySecretResolver;
  hooks: DeliveryHookExecutor;
  cursors: OutboxCursorPort;
  config: OutboxConfig;
  random: () => number;
  now: () => Date;
  workerId: string;
}) {
  const config = deps.config;
  if (config.maximumBackoffMs < config.initialBackoffMs) {
    throw new Error(
      "OPERANT_OUTBOX_MAX_BACKOFF_MS must not be below initial backoff",
    );
  }
  const workerId = deps.workerId;
  const random = deps.random;
  const now = deps.now;

  async function processBatch(limit = config.batchSize) {
    const claims = await deps.repository.claim({
      workerId,
      limit: Math.max(1, Math.min(limit, config.batchSize)),
      leaseMarginMs: config.leaseMarginMs,
      now: now(),
    });
    const executions = await Promise.all(claims.map(processOne));
    return { worker_id: workerId, claimed: claims.length, executions };
  }

  async function processOne(claim: OutboxClaim) {
    let outcome: DeliveryOutcome;
    let evidence: ReturnType<typeof emptyEvidence> = emptyEvidence();
    try {
      const loaded = await deps.catalog.load(claim);
      validatePinnedGrantEvidence(claim.pinned_grants_json);
      const grants = await deps.secrets.resolve(claim);
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
      const result = await deps.hooks.run({
        claim,
        program: loaded,
        secretValues: grants.values,
        envelope,
      });
      evidence = {
        duration_ms: result.durationMs,
        exit_code: result.exitCode,
        logs: result.logs,
        logs_truncated: result.logsTruncated ?? false,
        secrets_redacted: result.secretsRedacted ?? false,
        grants: [...grants.evidence],
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
    const status = await deps.repository.complete({
      claim,
      outcome,
      evidence,
      delayMs: delay,
      now: now(),
    });
    return { delivery_id: claim.id, attempt_id: claim.attempt_id, status };
  }

  async function authorize(
    auth: AuthContext,
    action: string,
  ): Promise<Result<unknown>> {
    const result = await deps.authorization.authorize({
      auth,
      boundary: { type: "system" },
      action,
      resource: "system:outbox",
    });
    return sanitizeOutboxAuthorizationResult(result);
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
        from: canonicalInstant(input.from),
        to: canonicalInstant(input.to),
      };
      if (
        (input.from !== undefined && filters.from === null) ||
        (input.to !== undefined && filters.to === null) ||
        (typeof input.hook === "string" &&
          !/^[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$/
            .test(
              input.hook,
            )) ||
        (typeof input.event === "string" && !isUuidV7(input.event))
      ) return err(validationError("bad_request", "outbox filter is invalid"));
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
          cursor = await deps.cursors.decode(input.cursor, filters);
        } catch {
          return err(
            validationError(
              "invalid_cursor",
              "outbox cursor is invalid for these filters",
            ),
          );
        }
      }
      const rows = await deps.repository.list({
        filters,
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit).map(deliveryDto);
      const last = items.at(-1) as
        | { created_at?: string; id?: string }
        | undefined;
      const nextCursor = hasMore && last?.created_at && last.id
        ? await deps.cursors.encode(
          { created_at: last.created_at, id: last.id },
          filters,
        )
        : null;
      return ok({
        items,
        filters: normalizeFilters(filters),
        page: { limit, next_cursor: nextCursor },
      });
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
      if (limit === null) {
        return err(
          validationError("bad_request", "attempt pagination is invalid"),
        );
      }
      if (!await deps.repository.inspect(id)) {
        return deliveryError("delivery_not_found", "not_found");
      }
      let after = 0;
      if (typeof input.cursor === "string") {
        try {
          after = await deps.cursors.decodeAttempt(input.cursor, id);
        } catch {
          return err(
            validationError(
              "invalid_cursor",
              "attempt cursor is invalid for this delivery",
            ),
          );
        }
      }
      const rows = await deps.repository.attempts({
        deliveryId: id,
        limit: limit + 1,
        after,
      });
      const items = rows.slice(0, limit).map(attemptDto);
      const last = rows.slice(0, limit).at(-1) as
        | { total_attempt_number?: number }
        | undefined;
      return ok({
        items,
        page: {
          limit,
          next_cursor: rows.length > limit && last?.total_attempt_number
            ? await deps.cursors.encodeAttempt(id, last.total_attempt_number)
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
      const status = await deps.repository.retry({
        deliveryId: id,
        auth,
        authContextId: auth.id,
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
      const status = await deps.repository.cancel({
        deliveryId: id,
        auth,
        authContextId: auth.id,
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
      await deps.repository.auditDrain({
        authContextId: auth.id,
        limit: limit ?? config.batchSize,
      });
      const batch = await processBatch(limit);
      const statuses = batch.executions.map((execution) => execution.status);
      return ok({
        ...batch,
        processed: batch.executions.length,
        succeeded: statuses.filter((status) => status === "succeeded").length,
        retried: statuses.filter((status) => status === "retry_wait").length,
        dead_lettered: statuses.filter((status) => status === "dead_letter")
          .length,
      });
    },
  };
}

export function sanitizeOutboxAuthorizationResult<T>(
  result: Result<T>,
): Result<T> {
  if (result.ok || result.error.severity !== "authorization") return result;
  const details = record(result.error.details);
  return err({
    ...result.error,
    details: Object.fromEntries(
      [
        "action",
        "boundary",
        "checked_policies",
        "effective_roles",
        "resource",
      ].filter((key) => Object.hasOwn(details, key)).map((key) => [
        key,
        details[key],
      ]),
    ),
  });
}

function validatePinnedGrantEvidence(value: unknown): void {
  if (!Array.isArray(value)) {
    throw permanent(
      "hook_secret_grant_unavailable",
      "pinned grants are invalid",
    );
  }
  for (const item of value) {
    const grant = record(item);
    if (
      typeof grant.slot !== "string" || typeof grant.env !== "string" ||
      typeof grant.grant_id !== "string" ||
      typeof grant.secret_id !== "string"
    ) {
      throw permanent(
        "hook_secret_grant_unavailable",
        "pinned hook-secret grant is unavailable",
      );
    }
  }
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
function canonicalInstant(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
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
