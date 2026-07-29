import type { AuthContext } from "../../domain/auth/model.ts";
import type { CanonicalOperation } from "../../domain/changesets/operations.ts";
import type { Result } from "../../domain/errors/result.ts";
import type {
  StageHookDeclaration,
  StageHookInput,
  StageHookResult,
} from "../../domain/changesets/stage.ts";
import type { ChangesetFactRepository } from "./repair/repositories.ts";

export type StageSource = Readonly<{
  kind: "direct" | "action" | "seed";
  identity: Readonly<Record<string, unknown>>;
  authority?: Readonly<{
    project_id: string;
    actions: readonly string[];
    revision_id: string;
    effects: readonly Readonly<
      { resource: string; ops: readonly string[]; authority_action?: string }
    >[];
    operation_authority: Readonly<Record<string, string>>;
    targeted?: Readonly<{
      action: string;
      targets: readonly Readonly<{
        project_id: string;
        resource: string;
        object_id?: string;
        object_version_id?: string;
        policy_digest: string;
        matched_rules: readonly Readonly<{
          policy: string;
          policy_version_id: string;
          policy_version: number;
          rule: string;
        }>[];
        role_assignment_ids: readonly string[];
        relationship_ids: readonly string[];
      }>[];
      canonical_target_digest: string;
      authority_facts_digest: string;
      cutoff: Readonly<{
        actor: Readonly<{
          id: string;
          principal_type: "human_user" | "agent_user" | "system";
          human_user_id: string | null;
        }>;
        auth_context_id: string;
        session_id: string;
        authorization_id: string | null;
        authorization_root_id: string;
        authorization_lineage_ids: readonly string[];
      }>;
    }>;
  }>;
  dependencies?: readonly Readonly<Record<string, unknown>>[];
  hook_executions?: readonly Readonly<Record<string, unknown>>[];
}>;

export type StageDto = {
  id: string;
  schema_version: 1;
  source: {
    kind: "direct" | "action" | "seed";
    identity: Record<string, unknown>;
  };
  status:
    | "ready"
    | "awaiting_approval"
    | "rejected"
    | "cancelled"
    | "committed";
  lifecycle_version: number;
  created_at: string;
  created_auth_context_id: string;
  operation_graph_digest: string;
  stage_digest: string;
  projects: unknown[];
  pack_revisions: unknown[];
  operations: CanonicalOperation[];
  dependencies: unknown[];
  hook_executions: unknown[];
  policy_decisions: unknown[];
  warnings: unknown[];
  approval_requirements: unknown[];
  approval_decisions: unknown[];
  planned_events: unknown[];
  planned_deliveries: unknown[];
  commit: unknown | null;
  cancellation: unknown | null;
};

export type StageCreateInput = {
  operations: CanonicalOperation[];
  operationGraphDigest: string;
  hookResult?: StageHookResult;
  hookDeclarations?: readonly StageHookDeclaration[];
  source?: StageSource;
};

export interface StageRepository extends
  ChangesetFactRepository<
    readonly [input: StageCreateInput, auth: AuthContext],
    readonly [id: string, auth: AuthContext],
    readonly [
      id: string,
      requirementId: string,
      input: { decision: "approve" | "reject"; reason: string | null },
      auth: AuthContext,
    ],
    readonly [id: string, reason: string | null, auth: AuthContext],
    Result<StageDto>
  > {
  hasHooks?(operations: CanonicalOperation[]): Promise<boolean>;
  hookInput?(
    operations: CanonicalOperation[],
    auth: AuthContext,
  ): Promise<Result<StageHookInput>>;
}
