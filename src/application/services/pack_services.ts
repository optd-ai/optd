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
import { compilePackDdl } from "../../adapters/outbound/postgres/resource_ddl.ts";
import { applySeedDefinitionsThroughChangesets } from "./changeset_services.ts";
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
    ddl_deferred: false;
    generated_tables: Array<{ kind: string; name: string; table_name: string }>;
  };
};

export type PackApplyDto = {
  applied: true;
  summary: PackSummary;
  ddl_deferred: false;
  seeds: { planned: number; committed: number; skipped: number };
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
        const ddlObjects = compilePackDdl(pack);
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
            ddl_deferred: false,
            generated_tables: ddlObjects.map((object) => ({
              kind: object.kind,
              name: `${object.namespace}.${object.name}`,
              table_name: object.tableName,
            })),
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
        const result = await deps.tx.transaction(async (tx) => {
          const summary = await applyLoadedPack(tx, pack);
          const seeds = await applySeedDefinitionsThroughChangesets(tx);
          return { summary, seeds };
        });
        return ok({
          applied: true,
          summary: result.summary,
          ddl_deferred: false,
          seeds: result.seeds,
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
