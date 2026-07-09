import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../adapters/outbound/yaml/pack_loader.ts";
import {
  applyMigrationSafe,
  confirmMigration,
  createPackMigrationPlan,
  getActivePackSnapshot,
  getMigrationPlan,
  stageMigrationDestructive,
} from "../../adapters/outbound/postgres/pack_migration_repository.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";

export function makeMigrationServices(
  deps: { sql: Queryable; tx: TransactionManager<Queryable> },
) {
  return {
    async preview(files: UploadedPackFile[]): Promise<Result<unknown>> {
      try {
        const pack = await loadPackFromFiles(files);
        const active = await getActivePackSnapshot(
          deps.sql,
          pack.namespace,
          pack.name,
        );
        if (!active) return ok({ migration: false });
        const plan = await createPackMigrationPlan(deps.sql, pack);
        return ok({ migration: true, plan });
      } catch (error) {
        return err(validationError("bad_migration", message(error)));
      }
    },
    async inspect(id: string): Promise<Result<unknown>> {
      const plan = await getMigrationPlan(deps.sql, id);
      if (!plan) {
        return err({
          code: "not_found",
          message: `migration ${id} not found`,
          severity: "not_found",
        });
      }
      return ok(plan);
    },
    async apply(
      id: string,
      mode: "safe" | "stage" = "safe",
    ): Promise<Result<unknown>> {
      try {
        const plan = await deps.tx.transaction((tx) =>
          mode === "stage"
            ? stageMigrationDestructive(tx, id)
            : applyMigrationSafe(tx, id)
        );
        return ok(plan);
      } catch (error) {
        return err(validationError("bad_migration_apply", message(error)));
      }
    },
    async confirm(id: string, token: string): Promise<Result<unknown>> {
      try {
        const plan = await deps.tx.transaction((tx) =>
          confirmMigration(tx, id, token)
        );
        return ok(plan);
      } catch (error) {
        return err(validationError("bad_migration_confirm", message(error)));
      }
    },
  };
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
