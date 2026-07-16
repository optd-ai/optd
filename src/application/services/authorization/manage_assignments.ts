import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  parseAuthorizationBoundary,
  roleIdentityPattern,
} from "../../../domain/authorization/boundary.ts";
import { err, validationError } from "../../../domain/errors/result.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

export function makeAuthorizationService(repository: AuthorizationRepository) {
  const invalid = (message: string, details: Record<string, unknown> = {}) =>
    Promise.resolve(
      err(validationError("validation_failed", message, details)),
    );
  const expectedVersion = (value: unknown): number | undefined => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : undefined;
  };
  return {
    authority(auth: AuthContext, boundaryInput: unknown) {
      const boundary = parseAuthorizationBoundary(boundaryInput);
      return boundary
        ? repository.authority(auth, boundary)
        : invalid("authorization boundary is invalid", { field: "boundary" });
    },
    roles(auth: AuthContext, boundaryInput: unknown) {
      const boundary = parseAuthorizationBoundary(boundaryInput);
      return boundary
        ? repository.listRoleDefinitions(boundary, auth)
        : invalid("authorization boundary is invalid", { field: "boundary" });
    },
    roleAssignments(auth: AuthContext, userId: string) {
      return isUuidV7(userId)
        ? repository.listRoleAssignments(auth, userId)
        : invalid("user_id must be a UUIDv7", { field: "user_id" });
    },
    createRoleAssignment(
      auth: AuthContext,
      userId: string,
      input: Record<string, unknown>,
    ) {
      const boundary = parseAuthorizationBoundary(input.boundary);
      if (
        !isUuidV7(userId) ||
        Object.keys(input).some((key) => !["role", "boundary"].includes(key)) ||
        typeof input.role !== "string" ||
        !roleIdentityPattern.test(input.role) || !boundary
      ) return invalid("role assignment is invalid");
      return repository.createRoleAssignment(
        auth,
        userId,
        input.role,
        boundary,
      );
    },
    disableRoleAssignment(
      auth: AuthContext,
      userId: string,
      assignmentId: string,
      input: Record<string, unknown>,
    ) {
      const version = expectedVersion(input.expected_version);
      if (
        !isUuidV7(userId) || !isUuidV7(assignmentId) ||
        Object.keys(input).some((key) => key !== "expected_version") || !version
      ) {
        return invalid("role assignment disable request is invalid");
      }
      return repository.disableRoleAssignment(
        auth,
        userId,
        assignmentId,
        version,
      );
    },
    policyAssignments(auth: AuthContext, active: unknown) {
      if (active !== undefined && active !== "true" && active !== "false") {
        return invalid("active must be true or false", { field: "active" });
      }
      return repository.listPolicyAssignments(
        auth,
        active === undefined ? undefined : active === "true",
      );
    },
    createPolicyAssignment(auth: AuthContext, input: Record<string, unknown>) {
      const boundary = parseAuthorizationBoundary(input.boundary);
      if (
        Object.keys(input).some((key) =>
          !["policy_revision_id", "boundary"].includes(key)
        ) || typeof input.policy_revision_id !== "string" ||
        !isUuidV7(input.policy_revision_id) || !boundary
      ) {
        return invalid("policy assignment is invalid");
      }
      return repository.createPolicyAssignment(
        auth,
        input.policy_revision_id,
        boundary,
      );
    },
    disablePolicyAssignment(
      auth: AuthContext,
      assignmentId: string,
      input: Record<string, unknown>,
    ) {
      const version = expectedVersion(input.expected_version);
      if (
        !isUuidV7(assignmentId) ||
        Object.keys(input).some((key) => key !== "expected_version") || !version
      ) {
        return invalid("policy assignment disable request is invalid");
      }
      return repository.disablePolicyAssignment(auth, assignmentId, version);
    },
  };
}
