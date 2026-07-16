import type {
  AuthContext,
  AuthorizationBoundary,
} from "../../domain/auth/model.ts";
import type {
  BoundaryAuthority,
  PolicyAssignmentRecord,
  RoleAssignmentRecord,
  RoleDefinition,
} from "../../domain/authorization/model.ts";
import type { Result } from "../../domain/errors/result.ts";

export interface AuthorizationRepository {
  authority(
    auth: AuthContext,
    boundary: AuthorizationBoundary,
    includeSecurity?: boolean,
  ): Promise<Result<BoundaryAuthority>>;
  authorize(input: {
    auth: AuthContext;
    boundary: AuthorizationBoundary;
    action: string;
    resource: string;
  }): Promise<Result<BoundaryAuthority>>;
  listRoleDefinitions(
    boundary: AuthorizationBoundary,
    auth: AuthContext,
  ): Promise<Result<Array<RoleDefinition & { assigned: boolean }>>>;
  listRoleAssignments(
    auth: AuthContext,
    userId: string,
  ): Promise<Result<RoleAssignmentRecord[]>>;
  createRoleAssignment(
    auth: AuthContext,
    userId: string,
    role: string,
    boundary: AuthorizationBoundary,
  ): Promise<Result<RoleAssignmentRecord>>;
  disableRoleAssignment(
    auth: AuthContext,
    userId: string,
    assignmentId: string,
    expectedVersion: number,
  ): Promise<Result<RoleAssignmentRecord>>;
  listPolicyAssignments(
    auth: AuthContext,
    active?: boolean,
  ): Promise<Result<PolicyAssignmentRecord[]>>;
  createPolicyAssignment(
    auth: AuthContext,
    policyRevisionId: string,
    boundary: AuthorizationBoundary,
  ): Promise<Result<PolicyAssignmentRecord>>;
  disablePolicyAssignment(
    auth: AuthContext,
    assignmentId: string,
    expectedVersion: number,
  ): Promise<Result<PolicyAssignmentRecord>>;
}
