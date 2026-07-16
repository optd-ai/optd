import { assertEquals } from "jsr:@std/assert";
import { parseAuthorizationBoundary } from "../../../src/domain/authorization/boundary.ts";

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
