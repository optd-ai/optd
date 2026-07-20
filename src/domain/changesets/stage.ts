import { canonicalSha256 } from "../ids/canonical_json.ts";
import type { CanonicalOperation } from "./operations.ts";

export type StageEvidence = {
  operation_graph_digest: string;
  projects: unknown[];
  pack_revisions: unknown[];
  operations: CanonicalOperation[];
  dependencies: unknown[];
  hook_executions: unknown[];
  policy_decisions: unknown[];
  approval_requirements: unknown[];
  planned_events: unknown[];
  planned_deliveries: unknown[];
};

/** Digest input intentionally excludes stage/auth/request IDs, clocks, warnings, and lifecycle facts. */
export async function stageDigest(evidence: StageEvidence): Promise<string> {
  return `sha256:${await canonicalSha256({
    schema: "changeset.stage-evidence.v1",
    ...evidence,
  })}`;
}

export type StageHookInput = {
  operations: readonly CanonicalOperation[];
  projects: readonly unknown[];
  pack_revisions: readonly unknown[];
};
export type StageHookResult = {
  operations: CanonicalOperation[];
  dependencies: unknown[];
  hook_executions: unknown[];
  warnings: unknown[];
  approval_requirements: unknown[];
  required_capabilities: string[];
  effects: string[];
  planned_events: unknown[];
  planned_deliveries: unknown[];
};
/** Implemented by trusted hook coordination; absence must fail closed for matching attachments. */
export interface StageHookCoordinator {
  coordinate(input: StageHookInput): Promise<StageHookResult>;
}
