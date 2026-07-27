import type { AuthContext } from "../../domain/auth/model.ts";

export type HomeDto = {
  version: string;
  generated_at: string;
  system: { active_packs: string[] };
  resources: string[];
  actions: string[];
  status: "ready";
  capabilities: string[];
  capability_projection: Record<string, unknown>;
  axi_readiness: { ready: boolean; missing_guidance: string[] };
  help: string[];
};

export type MetadataOptions = Readonly<{
  auth: AuthContext;
  projectId?: string;
  includeSecurity?: boolean;
}>;
