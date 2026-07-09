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
  getPack,
  type PackSummary,
  summarizePack,
} from "../../adapters/outbound/postgres/pack_repository.ts";
import { createPackMigrationPlan } from "../../adapters/outbound/postgres/pack_migration_repository.ts";
import { compilePackDdl } from "../../adapters/outbound/postgres/resource_ddl.ts";
import { applySeedDefinitionsThroughChangesets } from "./changeset_services.ts";
import type { TransactionManager } from "../ports/transaction_manager.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";

export type PackPreviewDto = {
  mutating: false;
  before: { revision_count: number };
  after: { revision_count: number };
  plan: {
    operation: "first_install" | "migration";
    summary: PackSummary;
    creates?: Record<string, number>;
    ddl_deferred: false;
    generated_tables?: Array<
      { kind: string; name: string; table_name: string }
    >;
    migration?: unknown;
  };
};

export type PackApplyDto =
  | {
    applied: true;
    summary: PackSummary;
    ddl_deferred: false;
    seeds: { planned: number; committed: number; skipped: number };
  }
  | {
    applied: false;
    migration_required: true;
    migration: unknown;
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
        const active = await getPack(deps.sql, pack.namespace, pack.name);
        if (active) {
          const migration = await createPackMigrationPlan(deps.sql, pack);
          const after = await countPackRevisions(deps.sql);
          return ok({
            mutating: false,
            before: { revision_count: before },
            after: { revision_count: after },
            plan: {
              operation: "migration",
              summary,
              ddl_deferred: false,
              migration,
            },
          });
        }
        const ddlObjects = compilePackDdl(pack);
        const after = await countPackRevisions(deps.sql);
        return ok({
          mutating: false,
          before: { revision_count: before },
          after: { revision_count: after },
          plan: {
            operation: "first_install",
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
        const active = await getPack(deps.sql, pack.namespace, pack.name);
        if (active) {
          const migration = await createPackMigrationPlan(deps.sql, pack);
          return ok({
            applied: false,
            migration_required: true,
            migration,
          });
        }
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
