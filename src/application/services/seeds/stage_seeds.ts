import type { AuthContext } from "../../../domain/auth/model.ts";
import type { Result } from "../../../domain/errors/result.ts";
import type { StageDto } from "../../ports/stage_repository.ts";

export type SeedStageDto = {
  status: "staged" | "unchanged";
  project_id: string;
  revision_id: string;
  seed_names: string[];
  stage: StageDto | null;
};

export interface SeedStagePort {
  stage(
    publisher: string,
    pack: string,
    raw: unknown,
    auth: AuthContext,
  ): Promise<Result<SeedStageDto>>;
}

/** Application use-case boundary; active-only lookup and SQL remain in the port. */
export function makeStageSeedsService(port: SeedStagePort) {
  return Object.freeze({
    stage: (publisher: string, pack: string, raw: unknown, auth: AuthContext) =>
      port.stage(publisher, pack, raw, auth),
  });
}
