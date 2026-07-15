import { assert, assertEquals } from "jsr:@std/assert";
import { isUuidV7, uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  validateDescription,
  validateProjectName,
  validateProjectSlug,
} from "../../../src/domain/projects/model.ts";
import { makeProjectService } from "../../../src/application/services/projects/manage_projects.ts";
import type { ProjectRepository } from "../../../src/application/ports/project_repository.ts";

Deno.test("Project IDs and fields enforce the frozen validation contract", () => {
  assert(isUuidV7(uuidV7()));
  assert(!isUuidV7(crypto.randomUUID()));
  assert(validateProjectSlug("sales-2026").ok);
  const slug = validateProjectSlug("Sales");
  assert(!slug.ok);
  assertEquals(slug.error.code, "validation_failed");
  assert(validateProjectName(" Sales ").ok);
  assert(!validateProjectName(" ").ok);
  assert(validateDescription(null).ok);
  assert(!validateDescription("x".repeat(16_385)).ok);
});

Deno.test("Project service reports stable UUID and authorization errors", async () => {
  const repository = {} as ProjectRepository;
  const service = makeProjectService(repository);
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
  assertEquals(unauthorized.error.details, { action: "project.read" });

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
