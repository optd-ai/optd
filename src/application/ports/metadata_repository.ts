export type BootstrapStatus = "ready";

export type HomeMetadata = {
  version: string;
  status: BootstrapStatus;
  active_packs: string[];
  capabilities: string[];
  help: string[];
};

export interface MetadataRepository {
  getHome(): Promise<HomeMetadata>;
}

export class BootstrapMetadataRepository implements MetadataRepository {
  constructor(private readonly version: string) {}

  async getHome(): Promise<HomeMetadata> {
    return {
      version: this.version,
      status: "ready",
      active_packs: [],
      capabilities: ["health", "metadata.home"],
      help: [
        "optctl home",
        "optctl pack preview prototypes/crm-default-pack --json",
      ],
    };
  }
}
