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
  if (input.type === "all_projects" && Object.keys(input).length === 1) {
    return { type: "all_projects" };
  }
  if (
    input.type === "project" && Object.keys(input).length === 2 &&
    typeof input.project_id === "string" && isUuidV7(input.project_id)
  ) {
    return { type: "project", projectId: input.project_id };
  }
}

export function boundaryDto(boundary: AuthorizationBoundary) {
  return boundary.type === "project"
    ? { type: "project" as const, project_id: boundary.projectId }
    : { type: boundary.type };
}

export const roleIdentityPattern =
  /^(?:system:[a-z][a-z0-9_]*|[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9_]*)$/;
