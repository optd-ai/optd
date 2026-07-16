import { assertEquals } from "jsr:@std/assert";
import {
  authorizationBoundaryMatches,
  parseAuthorizationBoundary,
} from "../../../src/domain/authorization/boundary.ts";
import { authorizationBoundaryPredicate } from "../../../src/adapters/outbound/postgres/authorization_boundary_sql.ts";

Deno.test("authorization boundaries are explicit and strict", () => {
  assertEquals(parseAuthorizationBoundary({ type: "system" }), {
    type: "system",
  });
  assertEquals(parseAuthorizationBoundary({ type: "all_projects" }), {
    type: "all_projects",
  });
  assertEquals(parseAuthorizationBoundary({}), undefined);
  assertEquals(
    parseAuthorizationBoundary({ type: "system", project_id: "ignored" }),
    undefined,
  );
  assertEquals(parseAuthorizationBoundary({ type: "project" }), undefined);
  assertEquals(
    parseAuthorizationBoundary({ type: "project", project_id: "not-a-uuid" }),
    undefined,
  );
});

Deno.test("authorization boundary inheritance is canonical and one-way", () => {
  const project = {
    type: "project" as const,
    projectId: "019b7a2e-7c10-7000-8000-000000000001",
  };
  const otherProject = {
    type: "project" as const,
    projectId: "019b7a2e-7c10-7000-8000-000000000002",
  };
  assertEquals(authorizationBoundaryMatches(project, project), true);
  assertEquals(
    authorizationBoundaryMatches(project, { type: "all_projects" }),
    true,
  );
  assertEquals(authorizationBoundaryMatches(project, otherProject), false);
  assertEquals(
    authorizationBoundaryMatches(project, { type: "system" }),
    false,
  );
  assertEquals(
    authorizationBoundaryMatches({ type: "all_projects" }, project),
    false,
  );
  assertEquals(
    authorizationBoundaryMatches(
      { type: "all_projects" },
      { type: "all_projects" },
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
      { type: "all_projects" },
    ),
    false,
  );
  assertEquals(
    authorizationBoundaryPredicate("ra", "$2", "$3"),
    "(ra.boundary_type=$2 and ra.project_id is not distinct from $3::uuid or $2='project' and ra.boundary_type='all_projects')",
  );
});
