import type { TransactionManager } from "../../../../application/ports/transaction_manager.ts";
import {
  MigrationPersistenceError,
  type MigrationPersistencePort,
} from "../../../../application/services/migration_services.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { MigrationApplyRequest } from "../../../../domain/migrations/pack_migration.ts";
import {
  applyMigrationPlan,
  getMigrationPlan,
  getMigrationSql,
  MigrationApplyError,
  recordMigrationAttempt,
  validateMigrationPlan,
} from "../pack_migration_repository.ts";
import type { Queryable } from "../client.ts";

/** PostgreSQL implementation of migration persistence only. */
export function makePostgresMigrationPersistence(deps: {
  sql: Queryable;
  tx: TransactionManager<Queryable>;
  authorizeApplyInTransaction: (
    sql: Queryable,
    auth: AuthContext,
  ) => Promise<{ ok: boolean }>;
  beforeApplyAttempt?: (sql: Queryable, attempt: number) => Promise<void>;
  applyTestFault?: "after_sql" | "after_application";
}): MigrationPersistencePort {
  return {
    inspect: (id) => getMigrationPlan(deps.sql, id),
    async violations(id) {
      const plan = await getMigrationPlan(deps.sql, id);
      return plan
        ? {
          migration_id: id,
          blockers: plan.last_validation?.blockers ?? plan.blockers,
          hazards: plan.hazards.filter((hazard) =>
            hazard.severity === "blocking"
          ),
        }
        : null;
    },
    async validate(id, authContextId) {
      try {
        return await deps.tx.transaction((sql) =>
          validateMigrationPlan(sql, id, authContextId)
        );
      } catch (error) {
        if (error instanceof MigrationApplyError) {
          throw new MigrationPersistenceError(error.code, error.message);
        }
        throw error;
      }
    },
    async applyOnce(id, input, auth, attempt) {
      try {
        return await deps.tx.transaction(async (sql) => {
          await deps.beforeApplyAttempt?.(sql, attempt);
          return await applyMigrationPlan(
            sql,
            id,
            input as MigrationApplyRequest,
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
      } catch (error) {
        if (error instanceof MigrationApplyError) {
          throw new MigrationPersistenceError(error.code, error.message);
        }
        throw error;
      }
    },
    generatedSql: (id) => getMigrationSql(deps.sql, id),
    async recordFailedAttempt(id, authContextId, outcome) {
      try {
        if (await getMigrationPlan(deps.sql, id)) {
          await deps.tx.transaction((sql) =>
            recordMigrationAttempt(sql, id, authContextId, outcome)
          );
        }
      } catch {
        // Recording cannot replace the authoritative apply outcome.
      }
    },
  };
}
