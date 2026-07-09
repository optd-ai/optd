import type { Clock } from "../ports/clock.ts";
import type {
  HomeMetadata,
  MetadataRepository,
} from "../ports/metadata_repository.ts";
import { ok, type Result } from "../../domain/errors/result.ts";

export type HomeDto = HomeMetadata & {
  generated_at: string;
};

export function makeInspectMetadataService(
  deps: { metadata: MetadataRepository; clock: Clock },
) {
  return {
    async home(): Promise<Result<HomeDto>> {
      const home = await deps.metadata.getHome();
      return ok({ ...home, generated_at: deps.clock.now().toISOString() });
    },
  };
}
