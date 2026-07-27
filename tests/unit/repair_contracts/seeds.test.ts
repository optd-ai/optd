// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import { decideSeedReconciliation } from "../../../src/application/ports/repair/seeds.ts";

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
