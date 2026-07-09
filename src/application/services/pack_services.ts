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
  applyLoadedPack,
  countPackRevisions,
  type PackSummary,
  summarizePack,
} from "../../adapters/outbound/postgres/pack_repository.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";

export type PackPreviewDto = {
  mutating: false;
  before: { revision_count: number };
  after: { revision_count: number };
  plan: {
    operation: "first_install" | "replace_active_revision";
    summary: PackSummary;
    creates: Record<string, number>;
    ddl_deferred: true;
  };
};

export type PackApplyDto = {
  applied: true;
  summary: PackSummary;
  ddl_deferred: true;
};

export function makePackServices(
  deps: { sql: Queryable; tx: TransactionManager<Queryable> },
) {
  return {
    async preview(files: UploadedPackFile[]): Promise<Result<PackPreviewDto>> {
      try {
        const before = await countPackRevisions(deps.sql);
        const pack = await loadPackFromFiles(files);
        const summary = summarizePack(pack);
        const after = await countPackRevisions(deps.sql);
        return ok({
          mutating: false,
          before: { revision_count: before },
          after: { revision_count: after },
          plan: {
            operation: before === 0
              ? "first_install"
              : "replace_active_revision",
            summary,
            creates: {
              resources: summary.resources.length,
              relationships: summary.relationships.length,
              lifecycles: summary.lifecycles.length,
              actions: summary.actions.length,
              hooks: summary.hooks.length,
              policies: summary.policies.length,
              seeds: summary.seeds.length,
            },
            ddl_deferred: true,
          },
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
    async apply(files: UploadedPackFile[]): Promise<Result<PackApplyDto>> {
      try {
        const pack = await loadPackFromFiles(files);
        const summary = await deps.tx.transaction((tx) =>
          applyLoadedPack(tx, pack)
        );
        return ok({ applied: true, summary, ddl_deferred: true });
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
