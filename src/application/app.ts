import { SystemClock } from "./ports/clock.ts";
import { BootstrapMetadataRepository } from "./ports/metadata_repository.ts";
import { makeInspectMetadataService } from "./services/inspect_metadata.ts";
import { OPERANT_VERSION } from "../config/runtime.ts";

export function makeApplication() {
  const clock = new SystemClock();
  const metadata = new BootstrapMetadataRepository(OPERANT_VERSION);
  return {
    metadata: makeInspectMetadataService({ metadata, clock }),
  };
}
