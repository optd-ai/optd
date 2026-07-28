import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { MigrationRepository } from "../ports/repair/repositories.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import type { MigrationApplyRequest } from "../../domain/migrations/pack_migration.ts";
import { err, ok, type Result } from "../../domain/errors/result.ts";

export type MigrationRetryConfig = Readonly<{
  maximumRetries: number;
  jitterMinimumMs: number;
  jitterMaximumMs: number;
}>;

/** Physical migration persistence. Authorization, retries and API errors stay in application. */
export type MigrationPersistencePort = MigrationRepository<
  unknown,
  unknown,
  unknown,
  MigrationApplyRequest,
  AuthContext,
  unknown
>;

export class MigrationPersistenceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export function makeMigrationServices(deps: {
  persistence: MigrationPersistencePort;
  authorization: AuthorizationRepository;
  retry: MigrationRetryConfig;
  random: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}) {
  const missing = (id: string) =>
    err({
      code: "not_found",
      message: `migration ${id} not found`,
      severity: "not_found" as const,
    });
  const authorize = (auth: AuthContext, action: string) =>
    deps.authorization.authorize({
      auth,
      boundary: { type: "system" },
      action,
      resource: "system:migration",
    });

  return Object.freeze({
    async inspect(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const plan = await deps.persistence.inspect(id);
      return plan === null ? missing(id) : ok(plan);
    },
    async violations(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const result = await deps.persistence.violations(id);
      return result === null ? missing(id) : ok(result);
    },
    async validate(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.validate");
      if (!authorized.ok) return err(authorized.error);
      try {
        const validation = await deps.persistence.validate(id, auth.id);
        return validation === null ? missing(id) : ok(validation);
      } catch (error) {
        return migrationError(error, id);
      }
    },
    async apply(
      id: string,
      input: MigrationApplyRequest,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.apply");
      if (!authorized.ok) {
        await deps.persistence.recordFailedAttempt(
          id,
          auth.id,
          authorized.error.code,
        );
        return err(authorized.error);
      }
      let transientFailures = 0;
      while (true) {
        const attempt = transientFailures + 1;
        try {
          const applied = await deps.persistence.applyOnce(
            id,
            input,
            auth,
            attempt,
          );
          return applied === null ? missing(id) : ok(applied);
        } catch (error) {
          const code = persistenceCode(error);
          if (
            (code === "40P01" || code === "40001") &&
            transientFailures < deps.retry.maximumRetries
          ) {
            transientFailures++;
            await deps.persistence.recordFailedAttempt(id, auth.id, code);
            await retryJitter(
              transientFailures,
              deps.retry.jitterMinimumMs,
              deps.retry.jitterMaximumMs,
              deps.random,
              deps.sleep,
            );
            continue;
          }
          const stableCode = error instanceof MigrationPersistenceError
            ? error.code
            : code === "55P03"
            ? "pack_install_busy"
            : code === "40P01" || code === "40001"
            ? "migration_retry_exhausted"
            : "migration_apply_failed";
          await deps.persistence.recordFailedAttempt(id, auth.id, stableCode);
          return err({
            code: stableCode,
            message: error instanceof Error
              ? error.message
              : "migration apply failed",
            severity: stableCode === "pack_install_busy"
              ? "locked"
              : stableCode.includes("invalid") ||
                  stableCode === "migration_blocked"
              ? "validation"
              : stableCode === "migration_stale"
              ? "conflict"
              : "internal",
          });
        }
      }
    },
    async sql(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const statements = await deps.persistence.generatedSql(id);
      return statements === null
        ? missing(id)
        : ok({ migration_id: id, statements });
    },
  });
}

function migrationError(error: unknown, _id: string): Result<never> {
  if (!(error instanceof MigrationPersistenceError)) throw error;
  const stale = error.code === "migration_stale";
  return err({
    code: error.code,
    message: stale
      ? "migration plan no longer matches the active pack revision"
      : "migration plan validation failed",
    severity: stale ? "conflict" : "validation",
    details: {
      reason: stale
        ? "active_pack_revision_changed"
        : "persisted_migration_invalid",
    },
  });
}

function persistenceCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

async function retryJitter(
  attempt: number,
  minimum: number,
  maximum: number,
  random: () => number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const cap = Math.min(maximum, minimum * 2 ** Math.max(0, attempt - 1));
  await sleep(
    Math.floor(random() * (Math.max(minimum, cap) - minimum + 1)) + minimum,
  );
}
