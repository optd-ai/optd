import type { Hono } from "npm:hono";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { Result } from "../../../domain/errors/result.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";
import { boundaryDto } from "../../../domain/authorization/boundary.ts";
import type {
  BoundaryAuthority,
  PolicyAssignmentRecord,
  RoleAssignmentRecord,
  RoleDefinition,
} from "../../../domain/authorization/model.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import type { AuthVariables } from "./auth_middleware.ts";

export type AuthorizationHttpService = {
  authority(
    auth: AuthContext,
    boundary: unknown,
  ): Promise<Result<BoundaryAuthority>>;
  roles(
    auth: AuthContext,
    boundary: unknown,
  ): Promise<Result<Array<RoleDefinition & { assigned: boolean }>>>;
  roleAssignments(
    auth: AuthContext,
    userId: string,
  ): Promise<Result<RoleAssignmentRecord[]>>;
  createRoleAssignment(
    auth: AuthContext,
    userId: string,
    input: Record<string, unknown>,
  ): Promise<Result<RoleAssignmentRecord>>;
  disableRoleAssignment(
    auth: AuthContext,
    userId: string,
    assignmentId: string,
    input: Record<string, unknown>,
  ): Promise<Result<RoleAssignmentRecord>>;
  policyAssignments(
    auth: AuthContext,
    active: unknown,
  ): Promise<Result<PolicyAssignmentRecord[]>>;
  createPolicyAssignment(
    auth: AuthContext,
    input: Record<string, unknown>,
  ): Promise<Result<PolicyAssignmentRecord>>;
  disablePolicyAssignment(
    auth: AuthContext,
    assignmentId: string,
    input: Record<string, unknown>,
  ): Promise<Result<PolicyAssignmentRecord>>;
};

export function registerAuthorizationRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  service: AuthorizationHttpService,
) {
  app.get(
    "/api/v1/authorization/authority",
    async (c) =>
      respond(
        c,
        await service.authority(c.get("auth"), queryBoundary(c.req.url)),
      ),
  );
  app.get(
    "/api/v1/authorization/roles",
    async (c) =>
      respond(c, await service.roles(c.get("auth"), queryBoundary(c.req.url))),
  );
  app.get(
    "/api/v1/auth/users/:user_id/role-assignments",
    async (c) =>
      respond(
        c,
        await service.roleAssignments(c.get("auth"), c.req.param("user_id")),
      ),
  );
  app.post(
    "/api/v1/auth/users/:user_id/role-assignments",
    async (c) =>
      respond(
        c,
        await service.createRoleAssignment(
          c.get("auth"),
          c.req.param("user_id"),
          await jsonObject(c),
        ),
        201,
      ),
  );
  app.post(
    "/api/v1/auth/users/:user_id/role-assignments/:assignment_id/disable",
    async (c) =>
      respond(
        c,
        await service.disableRoleAssignment(
          c.get("auth"),
          c.req.param("user_id"),
          c.req.param("assignment_id"),
          await jsonObject(c),
        ),
      ),
  );
  app.get(
    "/api/v1/policy-assignments",
    async (c) =>
      respond(
        c,
        await service.policyAssignments(
          c.get("auth"),
          new URL(c.req.url).searchParams.get("active") ?? undefined,
        ),
      ),
  );
  app.post(
    "/api/v1/policy-assignments",
    async (c) =>
      respond(
        c,
        await service.createPolicyAssignment(
          c.get("auth"),
          await jsonObject(c),
        ),
        201,
      ),
  );
  app.post(
    "/api/v1/policy-assignments/:assignment_id/disable",
    async (c) =>
      respond(
        c,
        await service.disablePolicyAssignment(
          c.get("auth"),
          c.req.param("assignment_id"),
          await jsonObject(c),
        ),
      ),
  );
}

function queryBoundary(urlValue: string) {
  const url = new URL(urlValue);
  const allowed = new Set(["boundary_type", "project_id"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))) {
    return undefined;
  }
  const type = url.searchParams.get("boundary_type");
  const projectId = url.searchParams.get("project_id");
  return type === "project" && projectId
    ? { type, project_id: projectId }
    : type && !projectId
    ? { type }
    : undefined;
}
async function jsonObject(
  c: { req: { json(): Promise<unknown> } },
): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => undefined);
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function respond(
  c: { json(data: unknown, status?: number): Response },
  result: Result<unknown>,
  status = 200,
) {
  if (!result.ok) {
    return c.json(errorEnvelope(result.error), toHttpStatus(result.error));
  }
  return c.json(
    successEnvelope(
      Array.isArray(result.value)
        ? { items: result.value.map(toDto) }
        : toDto(result.value),
    ),
    status,
  );
}
function toDto(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toDto);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.boundary && typeof record.boundary === "object") {
    record.boundary = boundaryDto(record.boundary as never);
  }
  return Object.fromEntries(
    Object.entries(record).map((
      [key, child],
    ) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      toDto(child),
    ]),
  );
}
