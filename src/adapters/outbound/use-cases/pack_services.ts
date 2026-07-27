import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../yaml/pack_loader.ts";
import {
  countPackRevisions,
  summarizePack,
} from "../postgres/pack_repository.ts";
import { createPackMigrationPlan } from "../postgres/pack_migration_repository.ts";
import type { Queryable } from "../postgres/client.ts";
import type { MigrationPlan } from "../../../domain/migrations/pack_migration.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { AuthorizationRepository } from "../../../application/ports/authorization.ts";
import type { TransactionManager } from "../../../application/ports/transaction_manager.ts";

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

export function makePackServices(
  deps: {
    sql: Queryable;
    authorization: AuthorizationRepository;
    tx: TransactionManager<Queryable>;
  },
) {
  return {
    async preview(
      files: UploadedPackFile[],
      auth: AuthContext,
    ): Promise<Result<PackPreviewDto>> {
      try {
        const authorized = await deps.authorization.authorize({
          auth,
          boundary: { type: "system" },
          action: "pack.preview",
          resource: "system:pack",
        });
        if (!authorized.ok) return err(authorized.error);
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
