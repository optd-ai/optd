import { err, ok, type Result } from "../../../domain/errors/result.ts";
import {
  applyMigrationPlan,
  getMigrationPlan,
  getMigrationSql,
  MigrationApplyError,
  recordMigrationAttempt,
  validateMigrationPlan,
} from "../postgres/pack_migration_repository.ts";
import type { MigrationApplyRequest } from "../../../domain/migrations/pack_migration.ts";
import type { Queryable } from "../postgres/client.ts";
import type { AuthorizationRepository } from "../../../application/ports/authorization.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { TransactionManager } from "../../../application/ports/transaction_manager.ts";

export function makeMigrationServices(
  deps: {
    sql: Queryable;
    authorization: AuthorizationRepository;
    tx: TransactionManager<Queryable>;
    authorizeApplyInTransaction: (
      sql: Queryable,
      auth: AuthContext,
    ) => Promise<Result<unknown>>;
    /** Test-only dependency seams. Production composition never supplies them. */
    beforeApplyAttempt?: (sql: Queryable, attempt: number) => Promise<void>;
    applyTestFault?: "after_sql" | "after_application";
  },
) {
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
  const recordFailedAttempt = async (
    planId: string,
    authContextId: string,
    outcome: string,
  ) => {
    try {
      if (await getMigrationPlan(deps.sql, planId)) {
        await deps.tx.transaction((sql) =>
          recordMigrationAttempt(sql, planId, authContextId, outcome)
        );
      }
    } catch { /* preserve the authoritative apply outcome */ }
  };
  return {
    async inspect(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const plan = await getMigrationPlan(deps.sql, id);
      return plan ? ok(plan) : missing(id);
    },
    async violations(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const plan = await getMigrationPlan(deps.sql, id);
      return plan
        ? ok({
          migration_id: id,
          blockers: plan.last_validation?.blockers ?? plan.blockers,
          hazards: plan.hazards.filter((hazard) =>
            hazard.severity === "blocking"
          ),
        })
        : missing(id);
    },
    async validate(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await deps.authorization.authorize({
        auth,
        boundary: { type: "system" },
        action: "migration.validate",
        resource: "system:migration",
      });
      if (!authorized.ok) return err(authorized.error);
      try {
        const validation = await deps.tx.transaction((sql) =>
          validateMigrationPlan(sql, id, auth.id)
        );
        return validation ? ok(validation) : missing(id);
      } catch (error) {
        if (error instanceof MigrationApplyError) {
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
        throw error;
      }
    },
    async apply(
      id: string,
      input: MigrationApplyRequest,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.apply");
      if (!authorized.ok) {
        await recordFailedAttempt(id, auth.id, authorized.error.code);
        return err(authorized.error);
      }
      let transientFailures = 0;
      const maximumRetries = boundedEnvironmentInteger(
        "OPERANT_PACK_APPLY_MAX_RETRIES",
        2,
        0,
        10,
      );
      const jitterMinimum = boundedEnvironmentInteger(
        "OPERANT_PACK_APPLY_RETRY_JITTER_MIN_MS",
        1,
        0,
        1_000,
      );
      const jitterMaximum = boundedEnvironmentInteger(
        "OPERANT_PACK_APPLY_RETRY_JITTER_MAX_MS",
        25,
        jitterMinimum,
        5_000,
      );
      while (true) {
        const attempt = transientFailures + 1;
        try {
          const application = await deps.tx.transaction(async (sql) => {
            await deps.beforeApplyAttempt?.(sql, attempt);
            return await applyMigrationPlan(
              sql,
              id,
              input,
              auth.id,
              deps.applyTestFault,
              async (lockedSql) => {
                const current = await deps.authorizeApplyInTransaction(
                  lockedSql,
                  auth,
                );
                if (!current.ok) {
                  throw new MigrationApplyError(
                    "authorization_changed",
                    "migration.apply authority changed while waiting for pack locks",
                  );
                }
              },
            );
          });
          return application ? ok(application) : missing(id);
        } catch (error) {
          const sqlState = typeof error === "object" && error !== null &&
              "code" in error
            ? String((error as { code: unknown }).code)
            : "";
          if (
            (sqlState === "40P01" || sqlState === "40001") &&
            transientFailures < maximumRetries
          ) {
            transientFailures++;
            await recordFailedAttempt(id, auth.id, sqlState);
            await retryJitter(
              transientFailures,
              jitterMinimum,
              jitterMaximum,
            );
            continue;
          }
          const code = error instanceof MigrationApplyError
            ? error.code
            : sqlState === "55P03"
            ? "pack_install_busy"
            : sqlState === "40P01" || sqlState === "40001"
            ? "migration_retry_exhausted"
            : "migration_apply_failed";
          await recordFailedAttempt(id, auth.id, code);
          return err({
            code,
            message: error instanceof Error
              ? error.message
              : "migration apply failed",
            severity: code === "pack_install_busy"
              ? "locked"
              : code.includes("invalid") || code === "migration_blocked"
              ? "validation"
              : code === "migration_stale"
              ? "conflict"
              : "internal",
          });
        }
      }
    },
    async sql(id: string, auth: AuthContext): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.inspect");
      if (!authorized.ok) return err(authorized.error);
      const statements = await getMigrationSql(deps.sql, id);
      return statements ? ok({ migration_id: id, statements }) : missing(id);
    },
  };
}

function boundedEnvironmentInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(Deno.env.get(name) ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

async function retryJitter(
  attempt: number,
  minimum: number,
  maximum: number,
): Promise<void> {
  const ceiling = Math.min(maximum, Math.max(minimum, minimum * attempt));
  const span = ceiling - minimum + 1;
  const delay = minimum +
    (span > 1 ? crypto.getRandomValues(new Uint32Array(1))[0] % span : 0);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
