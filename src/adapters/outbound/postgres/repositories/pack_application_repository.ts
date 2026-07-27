import { loadPackFromFiles } from "../../yaml/pack_loader.ts";
import type {
  LoadedPack,
  UploadedPackFile,
} from "../../../../domain/packs/loaded_pack.ts";
import { countPackRevisions, summarizePack } from "../pack_repository.ts";
import { createPackMigrationPlan } from "../pack_migration_repository.ts";
import type { Queryable } from "../client.ts";
import type { TransactionManager } from "../../../../application/ports/transaction_manager.ts";
import type { PackParser } from "../../../../application/ports/repair/repositories.ts";
import type { PackPreviewPersistence } from "../../../../application/services/pack_services.ts";

export const yamlPackParser: PackParser<UploadedPackFile[], LoadedPack> = Object
  .freeze({
    parse: loadPackFromFiles,
  });

/** Atomic physical catalog/migration-plan primitive used by application preview orchestration. */
export function makePostgresPackRepository(
  deps: { sql: Queryable; tx: TransactionManager<Queryable> },
): PackPreviewPersistence {
  return {
    async plan(pack, authContextId) {
      return await deps.tx.transaction(async (sql) => {
        const before = await countPackRevisions(sql);
        const created = await createPackMigrationPlan(sql, pack, authContextId);
        const after = await countPackRevisions(sql);
        return { before, after, ...created };
      });
    },
    summarize: summarizePack,
  };
}
