import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../../domain/errors/result.ts";
import { loadPackFromFiles } from "../../yaml/pack_loader.ts";
import type { UploadedPackFile } from "../../../../domain/packs/loaded_pack.ts";
import { countPackRevisions, summarizePack } from "../pack_repository.ts";
import { createPackMigrationPlan } from "../pack_migration_repository.ts";
import type { Queryable } from "../client.ts";
import type { MigrationPlan } from "../../../../domain/migrations/pack_migration.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { TransactionManager } from "../../../../application/ports/transaction_manager.ts";

export type PackPreviewDto = {
  candidate: {
    reused: boolean;
    revision_count_before: number;
    revision_count_after: number;
  };
  pack: ReturnType<typeof summarizePack>;
  plan: MigrationPlan;
  active: false;
};

export function makePostgresPackRepository(
  deps: {
    sql: Queryable;
    tx: TransactionManager<Queryable>;
  },
) {
  return {
    async preview(
      files: UploadedPackFile[],
      auth: AuthContext,
    ): Promise<Result<PackPreviewDto>> {
      try {
        const pack = await loadPackFromFiles(files);
        const { before, after, plan, candidate_reused } = await deps.tx
          .transaction(async (sql) => {
            const before = await countPackRevisions(sql);
            const created = await createPackMigrationPlan(sql, pack, auth.id);
            const after = await countPackRevisions(sql);
            return { before, after, ...created };
          });
        return ok({
          candidate: {
            reused: candidate_reused,
            revision_count_before: before,
            revision_count_after: after,
          },
          pack: summarizePack(pack, plan.to_pack_revision_id),
          plan,
          active: false,
        });
      } catch (error) {
        return err(
          validationError(
            "bad_pack",
            error instanceof Error ? error.message : String(error),
          ),
        );
      }
    },
  };
}
