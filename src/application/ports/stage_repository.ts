import type { AuthContext } from "../../domain/auth/model.ts";
import type { CanonicalOperation } from "../../domain/changesets/operations.ts";
import type { Result } from "../../domain/errors/result.ts";
import type {
  StageHookDeclaration,
  StageHookInput,
  StageHookResult,
} from "../../domain/changesets/stage.ts";

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

export interface StageRepository {
  hasHooks?(operations: CanonicalOperation[]): Promise<boolean>;
  hookInput?(
    operations: CanonicalOperation[],
    auth: AuthContext,
  ): Promise<Result<StageHookInput>>;
  create(
    input: {
      operations: CanonicalOperation[];
      operationGraphDigest: string;
      hookResult?: StageHookResult;
      hookDeclarations?: readonly StageHookDeclaration[];
      source?: StageSource;
    },
    auth: AuthContext,
  ): Promise<Result<StageDto>>;
  inspect(id: string, auth: AuthContext): Promise<Result<StageDto>>;
  approvals(id: string, auth: AuthContext): Promise<Result<StageDto>>;
  decideApproval(
    id: string,
    requirementId: string,
    input: { decision: "approve" | "reject"; reason: string | null },
    auth: AuthContext,
  ): Promise<Result<StageDto>>;
  cancel(
    id: string,
    reason: string | null,
    auth: AuthContext,
  ): Promise<Result<StageDto>>;
}
