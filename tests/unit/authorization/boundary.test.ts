import { assertEquals } from "@std/assert";
import {
  authorizationBoundaryMatches,
  parseAuthorizationBoundary,
} from "../../../src/domain/authorization/boundary.ts";
import { authorizationBoundaryPredicate } from "../../../src/adapters/outbound/postgres/authorization_boundary_sql.ts";

Deno.test("authorization boundaries are explicit and strict", () => {
  assertEquals(parseAuthorizationBoundary({ type: "system" }), {
    type: "system",
  });
  assertEquals(parseAuthorizationBoundary({ type: "all_workspaces" }), {
    type: "all_workspaces",
  });
  assertEquals(parseAuthorizationBoundary({}), undefined);
  assertEquals(parseAuthorizationBoundary({ type: "all_projects" }), undefined);
  assertEquals(
    parseAuthorizationBoundary({
      type: "project",
      project_id: "019b7a2e-7c10-7000-8000-000000000001",
    }),
    undefined,
  );
  assertEquals(
    parseAuthorizationBoundary({
      type: "workspace",
      project_id: "019b7a2e-7c10-7000-8000-000000000001",
    }),
    undefined,
  );
  assertEquals(
    parseAuthorizationBoundary({ type: "system", workspace_id: "ignored" }),
    undefined,
  );
  assertEquals(parseAuthorizationBoundary({ type: "workspace" }), undefined);
  assertEquals(
    parseAuthorizationBoundary({
      type: "workspace",
      workspace_id: "not-a-uuid",
    }),
    undefined,
  );
});

Deno.test("authorization boundary inheritance is canonical and one-way", () => {
  const workspace = {
    type: "workspace" as const,
    workspaceId: "019b7a2e-7c10-7000-8000-000000000001",
  };
  const otherWorkspace = {
    type: "workspace" as const,
    workspaceId: "019b7a2e-7c10-7000-8000-000000000002",
  };
  assertEquals(authorizationBoundaryMatches(workspace, workspace), true);
  assertEquals(
    authorizationBoundaryMatches(workspace, { type: "all_workspaces" }),
    true,
  );
  assertEquals(authorizationBoundaryMatches(workspace, otherWorkspace), false);
  assertEquals(
    authorizationBoundaryMatches(workspace, { type: "system" }),
    false,
  );
  assertEquals(
    authorizationBoundaryMatches({ type: "all_workspaces" }, workspace),
    false,
  );
  assertEquals(
    authorizationBoundaryMatches(
      { type: "all_workspaces" },
      { type: "all_workspaces" },
    ),
    true,
  );
  assertEquals(
    authorizationBoundaryMatches({ type: "system" }, { type: "system" }),
    true,
  );
  assertEquals(
    authorizationBoundaryMatches(
      { type: "system" },
      { type: "all_workspaces" },
    ),
    false,
  );
  assertEquals(
    authorizationBoundaryPredicate("ra", "$2", "$3"),
    "(ra.boundary_type=$2 and ra.workspace_id is not distinct from $3::uuid or $2='workspace' and ra.boundary_type='all_workspaces')",
  );
});
