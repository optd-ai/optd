import { err, ok, type Result } from "../../domain/errors/result.ts";
import {
  applyMigrationPlan,
  getMigrationPlan,
  getMigrationSql,
  MigrationApplyError,
  recordMigrationAttempt,
  validateMigrationPlan,
} from "../../adapters/outbound/postgres/pack_migration_repository.ts";
import type { MigrationApplyRequest } from "../../domain/migrations/pack_migration.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";

export function makeMigrationServices(
  deps: {
    sql: Queryable;
    authorization: AuthorizationRepository;
    tx: TransactionManager<Queryable>;
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
      const validation = await deps.tx.transaction((sql) =>
        validateMigrationPlan(sql, id, auth.id)
      );
      return validation ? ok(validation) : missing(id);
    },
    async apply(
      id: string,
      input: MigrationApplyRequest,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      const authorized = await authorize(auth, "migration.apply");
      if (!authorized.ok) return err(authorized.error);
      let transientFailures = 0;
      while (true) {
        try {
          const application = await deps.tx.transaction((sql) =>
            applyMigrationPlan(sql, id, input, auth.id)
          );
          return application ? ok(application) : missing(id);
        } catch (error) {
          const sqlState = typeof error === "object" && error !== null &&
              "code" in error
            ? String((error as { code: unknown }).code)
            : "";
          if (
            (sqlState === "40P01" || sqlState === "40001") &&
            transientFailures < 2
          ) {
            transientFailures++;
            continue;
          }
          const code = error instanceof MigrationApplyError
            ? error.code
            : sqlState === "55P03"
            ? "pack_install_busy"
            : sqlState === "40P01" || sqlState === "40001"
            ? "migration_retry_exhausted"
            : "migration_apply_failed";
          try {
            if (await getMigrationPlan(deps.sql, id)) {
              await deps.tx.transaction((sql) =>
                recordMigrationAttempt(sql, id, auth.id, code)
              );
            }
          } catch { /* preserve the authoritative apply error */ }
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
