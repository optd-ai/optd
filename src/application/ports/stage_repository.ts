import type { AuthContext } from "../../domain/auth/model.ts";
import type { CanonicalOperation } from "../../domain/changesets/operations.ts";
import type { Result } from "../../domain/errors/result.ts";

export type StageDto = {
  id: string;
  schema_version: 1;
  source: { kind: "direct"; identity: Record<string, never> };
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
  create(
    input: { operations: CanonicalOperation[]; operationGraphDigest: string },
    auth: AuthContext,
  ): Promise<Result<StageDto>>;
  inspect(id: string, auth: AuthContext): Promise<Result<StageDto>>;
  cancel(
    id: string,
    reason: string | null,
    auth: AuthContext,
  ): Promise<Result<StageDto>>;
}
