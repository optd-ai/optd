import type { AuthContext } from "../../domain/auth/model.ts";
import { err, type Result } from "../../domain/errors/result.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { MigrationPlan } from "../../domain/migrations/pack_migration.ts";
import type { UploadedPackFile } from "../../domain/packs/loaded_pack.ts";

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

export interface PackApplicationPort {
  preview(
    files: UploadedPackFile[],
    auth: AuthContext,
  ): Promise<Result<PackPreviewDto>>;
}

/** Application use-case boundary over pack parsing/catalog/migration persistence. */
export function makePackServices(
  port: PackApplicationPort,
  authorization: AuthorizationRepository,
) {
  return Object.freeze({
    async preview(files: UploadedPackFile[], auth: AuthContext) {
      const authorized = await authorization.authorize({
        auth,
        boundary: { type: "system" },
        action: "pack.preview",
        resource: "system:pack",
      });
      return authorized.ok
        ? await port.preview(files, auth)
        : err(authorized.error);
    },
  });
}
