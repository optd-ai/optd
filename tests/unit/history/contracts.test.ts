import { assert, assertEquals } from "@std/assert";
import {
  historyEntryContract,
  objectDtoContract,
  relationshipDtoContract,
} from "../../../src/schemas/api/objects.ts";

const id = "019a0000-0000-7000-8000-000000000001";
const at = "2026-07-16T12:00:00.000Z";

Deno.test("object and relationship read DTOs are strict and UUIDv7 typed", () => {
  assert(objectDtoContract.check({
    kind: "object",
    id,
    project_id: id,
    resource: {
      publisher: "optd",
      pack: "crm",
      name: "lead",
      revision_id: id,
    },
    version: 1,
    object_version_id: id,
    data: { name: "Acme" },
    archived_at: null,
    created_at: at,
    updated_at: at,
  }));
  assert(relationshipDtoContract.check({
    kind: "relationship",
    id,
    project_id: id,
    relationship: {
      publisher: "optd",
      pack: "crm",
      name: "contact_company",
      revision_id: id,
    },
    version: 1,
    object_version_id: id,
    from: id,
    to: id,
    fields: {},
    archived_at: null,
    created_at: at,
    updated_at: at,
  }));
  assertEquals(
    objectDtoContract.check({
      kind: "object",
      id: id.toUpperCase(),
      project_id: id,
      resource: {
        publisher: "optd",
        pack: "crm",
        name: "lead",
        revision_id: id,
      },
      version: 1,
      object_version_id: id,
      data: {},
      archived_at: null,
      created_at: at,
      updated_at: at,
    }),
    false,
  );
  assertEquals(
    objectDtoContract.check({
      kind: "object",
      id,
      project_id: id,
      resource: {
        publisher: "optd",
        pack: "crm",
        name: "lead",
        revision_id: id,
      },
      version: 1,
      object_version_id: id,
      data: {},
      archived_at: null,
      created_at: at,
      updated_at: at,
      extension: {},
    }),
    false,
  );
});

Deno.test("history entries remain discriminated with explicit identifiers", () => {
  assert(historyEntryContract.check({
    kind: "object_version",
    object_version_id: id,
    version: 1,
    operation: "create",
    provenance: { changeset_commit_id: id, auth_context_id: id },
    changed_fields: [],
    data: {},
    archived_at: null,
    created_at: at,
  }));
  assert(
    historyEntryContract.check({
      kind: "comment",
      comment_id: id,
      body: "observed",
      target_object_version_id: id,
      provenance: { changeset_commit_id: id, auth_context_id: id },
      created_at: at,
    }),
  );
  assertEquals(
    historyEntryContract.check({
      kind: "comment",
      id,
      body: "observed",
      target_object_version_id: id,
      provenance: { changeset_commit_id: id, auth_context_id: id },
      created_at: at,
    }),
    false,
  );
});
