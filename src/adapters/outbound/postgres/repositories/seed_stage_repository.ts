import type { Sql } from "../client.ts";
import { query, quoteIdentifier } from "../client.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import type { Result } from "../../../../domain/errors/result.ts";
import type {
  StageDto,
  StageSource,
} from "../../../../application/ports/stage_repository.ts";
import type { SeedStagePort } from "../../../../application/services/seeds/stage_seeds.ts";
import { PostgresAuthorizationRepository } from "../authorization_repository.ts";

/** Implements only physical seed catalog, active-row, authority, and persistence capabilities. */
export function makePostgresSeedStageRepository(
  sql: Sql,
  common: {
    stageSource(
      input: unknown,
      source: StageSource,
      auth: AuthContext,
    ): Promise<Result<StageDto | null>>;
  },
): SeedStagePort {
  const authorization = new PostgresAuthorizationRepository(sql);
  return {
    async loadActiveRevision(publisher, pack) {
      return (await query<{ id: string; normalized: unknown }>(
        sql,
        `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
         where ar.publisher=$1 and ar.pack_name=$2`,
        [publisher, pack],
      )).rows[0] ?? null;
    },
    async authorize(auth, projectId, action): Promise<Result<void>> {
      const result = await authorization.authorize({
        auth,
        boundary: { type: "project", projectId },
        action,
        resource: action,
      });
      return result.ok ? { ok: true, value: undefined } : result;
    },
    async findActiveRow(input) {
      const table = (await query<{ table_name: string }>(
        sql,
        `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
        [input.publisher, input.pack, input.resourceName],
      )).rows[0]?.table_name;
      if (!table) throw new Error("seed resource is unavailable");
      return (await query<Record<string, unknown>>(
        sql,
        `select * from ${quoteIdentifier(table)} where project_id=$1 and ${
          quoteIdentifier(input.key)
        }=$2 and archived_at is null for share`,
        [input.projectId, input.value],
      )).rows[0];
    },
    stageSource: common.stageSource,
  };
}
