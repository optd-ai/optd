// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  ACTIVE_SEED_KEY_CONFLICT,
  decideSeedReconciliation,
  seedReplacementCommitResult,
} from "../../../src/application/ports/repair/seeds.ts";

const replacementId = "019b1234-5678-7abc-8def-0123456789ab";
const ids = { nextUuidV7: () => replacementId };

Deno.test("archived seed matches are absent and receive a new UUIDv7", () => {
  assertEquals(
    decideSeedReconciliation(
      [{
        objectId: "archived-object",
        objectVersion: 9,
        archivedAt: "2026-07-01T00:00:00.000Z",
        valuesDigest: "old",
      }],
      "desired",
      ids,
    ),
    {
      kind: "create",
      objectId: replacementId,
    },
  );
});

Deno.test("seed reconciliation repeats unchanged and updates active identity", () => {
  assertEquals(
    decideSeedReconciliation(
      [{
        objectId: "active-object",
        objectVersion: 2,
        archivedAt: null,
        valuesDigest: "desired",
      }],
      "desired",
      ids,
    ),
    {
      kind: "unchanged",
      objectId: "active-object",
      objectVersion: 2,
    },
  );
  assertEquals(
    decideSeedReconciliation(
      [{
        objectId: "active-object",
        objectVersion: 2,
        archivedAt: null,
        valuesDigest: "old",
      }],
      "desired",
      ids,
    ),
    {
      kind: "update",
      objectId: "active-object",
      objectVersion: 2,
    },
  );
});

Deno.test("concurrent archived-seed replacement has one winner and one stable loser", () => {
  const constraint = {
    name: "lead_status_project_key_active_uidx",
    projectScoped: true as const,
    fields: ["project_id", "key"],
    predicate: "active()" as const,
  };
  assertEquals(
    [
      seedReplacementCommitResult({
        kind: "inserted",
        objectId: replacementId,
      }, constraint),
      seedReplacementCommitResult({
        kind: "unique_conflict",
        constraint: constraint.name,
      }, constraint),
    ],
    [{ kind: "created", objectId: replacementId }, {
      kind: "conflict",
      code: ACTIVE_SEED_KEY_CONFLICT,
      constraint: constraint.name,
    }],
  );
  assertThrows(
    () =>
      seedReplacementCommitResult({
        kind: "unique_conflict",
        constraint: "unrelated_constraint",
      }, constraint),
    Error,
    "unexpected seed replacement uniqueness conflict",
  );
});

Deno.test("multiple active matches and non-UUIDv7 allocation fail closed", () => {
  const active = {
    objectId: "active-object",
    objectVersion: 1,
    archivedAt: null,
    valuesDigest: "desired",
  };
  assertThrows(
    () => decideSeedReconciliation([active, active], "desired", ids),
    Error,
    "active-only seed uniqueness is violated",
  );
  assertThrows(
    () =>
      decideSeedReconciliation([], "desired", {
        nextUuidV7: () => "not-a-uuid",
      }),
    Error,
    "must be UUIDv7",
  );
});
