import { canonicalSha256 } from "../ids/canonical_json.ts";
import type { CanonicalOperation } from "./operations.ts";
import type { AuthoredOperation } from "../../schemas/changesets/operations.ts";
import type { PatchOutput } from "../../schemas/changesets/patch.ts";

export type ValidationMessage = Readonly<{
  path: string;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;
export type StageHookDeclaration = Readonly<{
  attachment_id: string;
  hook_revision_id: string;
  pack_revision_id: string;
  hook: string;
  phase: "changeset.before_stage" | "changeset.validate";
  resource: string | null;
  operation_key: string | null;
  order: number;
  script_digest: string;
  security_digest: string;
  script_content: string;
  timeout_ms: number;
  output_schema: "patch.v1" | "validation.v1";
  permissions: Readonly<{
    net: readonly string[];
    env: readonly string[];
  }>;
  secret_slots: readonly Readonly<{ slot: string; env: string }>[];
  input_mapping: Readonly<Record<string, unknown>>;
  condition: string | null;
  effects: readonly unknown[];
  declaration_digest: string;
}>;
export type HookSecretGrantEvidence = Readonly<{
  grant_id: string;
  secret_id: string;
  value_version: number;
  slot: string;
  env: string;
}>;
export type HookGrantSnapshot = Readonly<{
  grants: readonly HookSecretGrantEvidence[];
}>;
export type StageHookOutput = Readonly<{
  added_operations: readonly AuthoredOperation[];
  patch_outputs: readonly Readonly<{
    operation_key: string;
    output: PatchOutput;
  }>[];
  read_dependencies: readonly StageReadDependency[];
  warnings: readonly ValidationMessage[];
  approval_requirements: readonly ApprovalRequirement[];
  required_capabilities: readonly string[];
  effects: readonly string[];
  planned_events: readonly PlannedIdentity[];
  planned_deliveries: readonly PlannedIdentity[];
}>;
export type StageHookExecution = Readonly<{
  id: string;
  attachment_id: string;
  hook_revision_id: string;
  pack_revision_id: string;
  phase: "changeset.before_stage" | "changeset.validate";
  input_digest: string;
  output_digest: string;
  output: StageHookOutput;
  script_digest: string;
  security_digest: string;
  stderr: string;
  logs_truncated: boolean;
  secrets_redacted: boolean;
  duration_ms: number;
  grant_snapshot: HookGrantSnapshot;
}>;
export type StageReadDependency = Readonly<{
  kind:
    | "object_version"
    | "relationship"
    | "policy"
    | "assignment"
    | "uniqueness";
  project_id?: string;
  object_id?: string;
  expected_version_id?: string;
  definition?: string;
  digest?: string;
  query_digest?: string;
}>;
export type ApprovalRequirement = Readonly<{
  id: string;
  capability: string;
  project_id?: string;
}>;
export type PlannedIdentity = Readonly<{
  id: string;
  kind?: string;
}>;

export type StageEvidence = {
  operation_graph_digest: string;
  projects: readonly unknown[];
  pack_revisions: readonly unknown[];
  operations: readonly CanonicalOperation[];
  dependencies: readonly unknown[];
  hook_executions: readonly unknown[];
  policy_decisions: readonly unknown[];
  approval_requirements: readonly unknown[];
  required_capabilities: string[];
  effects: string[];
  planned_events: readonly unknown[];
  planned_deliveries: readonly unknown[];
};

/** Digest input intentionally excludes stage/auth/request IDs, clocks, warnings, and lifecycle facts. */
export async function stageDigest(evidence: StageEvidence): Promise<string> {
  return `sha256:${await canonicalSha256({
    schema: "changeset.stage-evidence.v1",
    operation_graph_digest: evidence.operation_graph_digest,
    projects: evidence.projects,
    pack_revisions: evidence.pack_revisions,
    operations: evidence.operations,
    dependencies: evidence.dependencies,
    hook_executions: evidence.hook_executions,
    policy_decisions: evidence.policy_decisions,
    approval_requirements: evidence.approval_requirements,
    required_capabilities: evidence.required_capabilities,
    effects: evidence.effects,
    planned_events: evidence.planned_events,
    planned_deliveries: evidence.planned_deliveries,
  })}`;
}

export type StageHookInput = Readonly<{
  operations: readonly CanonicalOperation[];
  projects: readonly unknown[];
  pack_revisions: readonly unknown[];
  hook_declarations: readonly StageHookDeclaration[];
  proposed_states: Readonly<Record<string, Record<string, unknown>>>;
  base_states: Readonly<Record<string, Record<string, unknown> | null>>;
}>;
export type StageHookResult =
  & StageHookOutput
  & Readonly<{
    hook_executions: readonly StageHookExecution[];
  }>;
export type StageHookCoordinatorResult = Readonly<{
  hook_executions: readonly StageHookExecution[];
}>;
/** Implemented by trusted hook coordination; absence must fail closed for matching attachments. */
export interface StageHookCoordinator {
  coordinate(input: StageHookInput): Promise<StageHookCoordinatorResult>;
}
