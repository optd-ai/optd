import type { AuthContext } from "../../domain/auth/model.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { MigrationPlan } from "../../domain/migrations/pack_migration.ts";
import type {
  LoadedPack,
  UploadedPackFile,
} from "../../domain/packs/loaded_pack.ts";
import type { PackCatalog, PackParser } from "../ports/repair/repositories.ts";

export type PackPreviewDto = {
  candidate: {
    reused: boolean;
    revision_count_before: number;
    revision_count_after: number;
  };
  pack: unknown;
  plan: MigrationPlan;
  active: false;
};

export type PackPreviewPlan = {
  before: number;
  after: number;
  plan: MigrationPlan;
  candidate_reused: boolean;
};

export interface PackPreviewPersistence extends
  PackCatalog<
    readonly [pack: LoadedPack, authContextId: string],
    PackPreviewPlan,
    readonly [pack: LoadedPack, revisionId: string],
    unknown
  > {}

/** Owns preview authorization, parser error mapping, and migration-preview orchestration. */
export function makePackServices(
  parser: PackParser<UploadedPackFile[], LoadedPack>,
  persistence: PackPreviewPersistence,
  authorization: AuthorizationRepository,
) {
  return Object.freeze({
    async preview(
      files: UploadedPackFile[],
      auth: AuthContext,
    ): Promise<Result<PackPreviewDto>> {
      const authorized = await authorization.authorize({
        auth,
        boundary: { type: "system" },
        action: "pack.preview",
        resource: "system:pack",
      });
      if (!authorized.ok) return err(authorized.error);
      try {
        const pack = await parser.parse(files);
        const { before, after, plan, candidate_reused } = await persistence
          .plan(pack, auth.id);
        return ok({
          candidate: {
            reused: candidate_reused,
            revision_count_before: before,
            revision_count_after: after,
          },
          pack: persistence.summarize(pack, plan.to_pack_revision_id),
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
  });
}
