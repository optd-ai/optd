// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  ACTIVE_SEED_KEY_CONFLICT,
  decideSeedReconciliation,
  freezeSeedActivePresence,
  seedActivePresenceMatches,
  type SeedReconciliationRepository,
  seedReplacementCommitResult,
} from "../../../src/application/ports/repair/seeds.ts";

const replacementId = "019b1234-5678-7abc-8def-0123456789ab";
const versionId = "019b1234-5678-7abc-8def-0123456789ac";
const nextVersionId = "019b1234-5678-7abc-8def-0123456789ad";
const ids = { nextUuidV7: () => replacementId };

const seedRepository: SeedReconciliationRepository<
  { key: string },
  { id: string },
  unknown,
  { kind: string },
  { id: string },
  { stageId: string }
> = {
  findActiveRow: () => Promise.resolve(undefined),
  stageSource: () => Promise.resolve({ stageId: "stage-1" }),
};

Deno.test("seed repository exposes active-only lookup and immutable staging", () => {
  assertEquals(Object.keys(seedRepository).toSorted(), [
    "findActiveRow",
    "stageSource",
  ]);
});

Deno.test("archived seed matches are absent and receive a new UUIDv7", () => {
  assertEquals(
    decideSeedReconciliation(
      [{
        objectId: "archived-object",
        objectVersion: 9,
        objectVersionId: versionId,
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
        objectVersionId: versionId,
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
      objectVersionId: versionId,
    },
  );
  assertEquals(
    decideSeedReconciliation(
      [{
        objectId: "active-object",
        objectVersion: 2,
        objectVersionId: versionId,
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
      objectVersionId: versionId,
    },
  );
});

Deno.test("seed presence freezes immutable version identity and detects change", () => {
  const active = {
    objectId: "active-object",
    objectVersion: 2,
    objectVersionId: versionId,
    archivedAt: null,
    valuesDigest: "desired",
  };
  const frozen = freezeSeedActivePresence(active);
  assertEquals(frozen, {
    kind: "present",
    objectId: "active-object",
    currentObjectVersionId: versionId,
  });
  assertEquals(seedActivePresenceMatches(frozen, active), true);
  assertEquals(
    seedActivePresenceMatches(frozen, {
      ...active,
      objectVersion: 3,
      objectVersionId: nextVersionId,
    }),
    false,
  );
  assertEquals(
    seedActivePresenceMatches(frozen, { ...active, archivedAt: "now" }),
    false,
  );
  assertEquals(freezeSeedActivePresence(null), { kind: "absent" });
  assertEquals(
    seedActivePresenceMatches({ kind: "absent" }, {
      ...active,
      archivedAt: "now",
    }),
    true,
  );
  assertEquals(seedActivePresenceMatches({ kind: "absent" }, active), false);
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

Deno.test("multiple active matches and invalid immutable IDs fail closed", () => {
  const active = {
    objectId: "active-object",
    objectVersion: 1,
    objectVersionId: versionId,
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
  assertThrows(
    () => freezeSeedActivePresence({ ...active, objectVersionId: "version-2" }),
    Error,
    "current_object_version_id must be UUIDv7",
  );
});
