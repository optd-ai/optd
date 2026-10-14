import type { AuthorizationBoundary } from "../auth/model.ts";
import { isUuidV7 } from "../ids/uuid_v7.ts";

export function parseAuthorizationBoundary(
  value: unknown,
): AuthorizationBoundary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const input = value as Record<string, unknown>;
  if (input.type === "system" && Object.keys(input).length === 1) {
    return { type: "system" };
  }
  if (input.type === "all_workspaces" && Object.keys(input).length === 1) {
    return { type: "all_workspaces" };
  }
  if (
    input.type === "workspace" && Object.keys(input).length === 2 &&
    typeof input.workspace_id === "string" && isUuidV7(input.workspace_id)
  ) {
    return { type: "workspace", workspaceId: input.workspace_id };
  }
}

export function boundaryDto(boundary: AuthorizationBoundary) {
  return boundary.type === "workspace"
    ? { type: "workspace" as const, workspace_id: boundary.workspaceId }
    : { type: boundary.type };
}

export function authorizationBoundaryMatches(
  target: AuthorizationBoundary,
  assignment: AuthorizationBoundary,
): boolean {
  if (target.type === "workspace") {
    return assignment.type === "all_workspaces" ||
      (assignment.type === "workspace" &&
        assignment.workspaceId === target.workspaceId);
  }
  return assignment.type === target.type;
}

export const roleIdentityPattern =
  /^(?:system:[a-z][a-z0-9_]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9_]*)$/;
