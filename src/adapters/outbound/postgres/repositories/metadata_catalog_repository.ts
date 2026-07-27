import type { MetadataFactsCatalog } from "../../../../application/services/inspect_metadata.ts";
import { query, type Queryable } from "../client.ts";
import { getActivePack, getDefinition, listPacks } from "../pack_repository.ts";

/** Physical metadata facts; projection, authorization, DTOs, and errors stay inward. */
export function makePostgresMetadataRepository(
  sql: Queryable,
): MetadataFactsCatalog {
  return {
    async home() {
      return (await query<Record<string, unknown>>(
        sql,
        `select ar.publisher, ar.pack_name as name, cr.version, cr.manifest, cr.normalized
           from pack_active_revisions ar
           join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
          order by ar.publisher, ar.pack_name`,
      )).rows;
    },
    async listPacks() {
      return await listPacks(sql) as unknown as readonly Record<
        string,
        unknown
      >[];
    },
    async pack(request) {
      if (!("publisher" in request) || !("pack" in request)) return null;
      return await getActivePack(
        sql,
        String(request.publisher),
        String(request.pack),
      ) as unknown as Record<string, unknown> | null;
    },
    async definition(request) {
      if (
        !("section" in request) || !("publisher" in request) ||
        !("pack" in request) || !("name" in request)
      ) return null;
      return await getDefinition(
        sql,
        String(request.section),
        String(request.publisher),
        String(request.pack),
        String(request.name),
      ) as unknown as Record<string, unknown> | null;
    },
    async hookScriptDigest(request) {
      if (
        !("publisher" in request) || !("pack" in request) ||
        !("name" in request)
      ) return null;
      const result = await query<{ digest: string | null }>(
        sql,
        `select jsonb_extract_path_text(cr.normalized,'scripts',$3) digest
           from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
          where ar.publisher=$1 and ar.pack_name=$2`,
        [
          String(request.publisher),
          String(request.pack),
          `hooks/${String(request.name)}.ts`,
        ],
      );
      return result.rows[0]?.digest ?? null;
    },
  };
}
