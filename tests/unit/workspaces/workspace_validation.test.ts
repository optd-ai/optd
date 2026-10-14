import { assert, assertEquals } from "jsr:@std/assert";
import { isUuidV7, uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  validateDescription,
  validateWorkspaceName,
  validateWorkspaceSlug,
} from "../../../src/domain/workspaces/model.ts";
import { makeWorkspaceService } from "../../../src/application/services/workspaces/manage_workspaces.ts";
import {
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
} from "../../../src/domain/workspaces/pagination.ts";
import type { WorkspaceRepository } from "../../../src/application/ports/workspace_repository.ts";

Deno.test("Workspace IDs and fields enforce the frozen validation contract", () => {
  assert(isUuidV7(uuidV7()));
  assert(!isUuidV7(crypto.randomUUID()));
  assert(validateWorkspaceSlug("sales-2026").ok);
  const slug = validateWorkspaceSlug("Sales");
  assert(!slug.ok);
  assertEquals(slug.error.code, "validation_failed");
  assert(validateWorkspaceName(" Sales ").ok);
  assert(!validateWorkspaceName(" ").ok);
  assert(validateWorkspaceName("😀".repeat(120)).ok);
  assert(!validateWorkspaceName("😀".repeat(121)).ok);
  assert(validateWorkspaceSlug(`a${"b".repeat(62)}`).ok);
  assert(!validateWorkspaceSlug(`a${"b".repeat(63)}`).ok);
  assert(validateDescription(null).ok);
  assert(!validateDescription("x".repeat(16_385)).ok);
});

Deno.test("Workspace cursors bind stable positions to exact filters", () => {
  const cursor = encodeWorkspaceCursor(
    { status: "active" },
    { slug: "bravo", id: uuidV7() },
  );
  const decoded = decodeWorkspaceCursor(cursor, { status: "active" });
  assert(decoded.ok);
  assertEquals(decoded.value.slug, "bravo");
  const mismatch = decodeWorkspaceCursor(cursor, { status: "archived" });
  assert(!mismatch.ok);
  assertEquals(mismatch.error.code, "workspace_cursor_mismatch");
  const malformed = decodeWorkspaceCursor("not-a-cursor", { status: "active" });
  assert(!malformed.ok);
  assertEquals(malformed.error.code, "workspace_cursor_invalid");
});

Deno.test("Workspace service reports stable UUID and authorization errors", async () => {
  const repository = {
    get: () =>
      Promise.resolve({
        ok: false,
        error: {
          code: "authorization_insufficient",
          severity: "authorization",
          message: "denied",
          details: { action: "workspace.read" },
        },
      }),
  } as unknown as WorkspaceRepository;
  const service = makeWorkspaceService(repository);
  const unauthorized = await service.get({
    id: uuidV7(),
    principalId: uuidV7(),
    principalType: "human_user",
    humanUserId: uuidV7(),
    sessionId: uuidV7(),
    credentialKind: "human_full",
    roles: [],
    createdAt: new Date().toISOString(),
  }, uuidV7());
  assert(!unauthorized.ok);
  assertEquals(unauthorized.error.code, "authorization_insufficient");
  assertEquals(unauthorized.error.details, { action: "workspace.read" });

  const invalidId = await service.get({
    id: uuidV7(),
    principalId: uuidV7(),
    principalType: "human_user",
    humanUserId: uuidV7(),
    sessionId: uuidV7(),
    credentialKind: "human_full",
    roles: ["system:super_admin"],
    createdAt: new Date().toISOString(),
  }, "not-a-uuid");
  assert(!invalidId.ok);
  assertEquals(invalidId.error.code, "validation_failed");
});
