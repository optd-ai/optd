// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals } from "jsr:@std/assert";
import { normalizeOperations } from "../../src/domain/changesets/operations.ts";
import {
  makeStageSeedsService,
  reconcileSeedRow,
  validateSeedSelection,
} from "../../src/application/services/seeds/stage_seeds.ts";
import { isUuidV7 } from "../../src/domain/ids/uuid_v7.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const object = "019b7a2e-7c10-7000-8000-000000000002";
const context = {
  operationKey: "statuses_0",
  projectId: project,
  resource: "test/demo:status",
};

Deno.test("seed stage rejects names alias and unknown DTO fields before persistence", async () => {
  const service = makeStageSeedsService({} as never, {
    stageSource: () => Promise.reject(new Error("must not persist")),
  });
  const auth = {} as never;
  for (
    const body of [{ project_id: project, all: false, names: ["a"] }, {
      project_id: project,
      all: true,
      seed_names: [],
      extra: true,
    }]
  ) {
    const result = await service.stage("test", "demo", body, auth);
    assertEquals(result.ok, false);
  }
});

Deno.test("seed selection requires strict all xor unique names", () => {
  assertEquals(validateSeedSelection(true, []), null);
  assertEquals(validateSeedSelection(false, ["a", "b"]), null);
  assert(validateSeedSelection(false, []) !== null);
  assert(validateSeedSelection(true, ["a"]) !== null);
  assert(validateSeedSelection(false, ["a", "a"]) !== null);
});

Deno.test("seed reconcile creates without authored id and normalization allocates UUIDv7", async () => {
  const operation = reconcileSeedRow(
    { code: "new", label: null },
    undefined,
    context,
  )!;
  assertEquals(operation.fields, { code: "new", label: null });
  assertEquals(operation.object_id, undefined);
  const normalized = await normalizeOperations(
    { operations: [operation] } as never,
  );
  assert(isUuidV7(String(normalized.operations[0].object_id)));
});

Deno.test("seed reconcile preserves UUID extras and changes only declared differences", () => {
  const current = {
    id: object,
    version: 7,
    code: "won",
    label: "Old",
    extra: "preserved",
    nullable: null,
  };
  const update = reconcileSeedRow(
    { code: "won", label: "New", nullable: null },
    current,
    context,
  )!;
  assertEquals(update.object_id, object);
  assertEquals(update.expected_version, 7);
  assertEquals(update.set, { label: "New" });
  assertEquals(
    reconcileSeedRow(
      { code: "won", label: "Old", nullable: null },
      current,
      context,
    ),
    null,
  );
  assertEquals(Object.hasOwn(update, "unset"), false);
  assertEquals(Object.hasOwn(update, "archive"), false);
});

Deno.test("seed reconcile normalizes PostgreSQL scalar representations by frozen descriptors", () => {
  const descriptors = {
    count: { type: "integer" },
    amount: { type: "decimal" },
    due: { type: "date" },
    occurs_at: { type: "timestamp" },
    enabled: { type: "boolean" },
    label: { type: "string" },
    owner_id: { type: "string", ref: "test/demo:user" },
    note: { type: "string", nullable: true },
  };
  const desired = {
    count: 42,
    amount: "1.23",
    due: "2026-07-24",
    occurs_at: "2026-07-24T10:11:12Z",
    enabled: true,
    label: "Exact",
    owner_id: object,
    note: null,
  };
  const current = {
    id: object,
    version: 3,
    count: "42",
    amount: "001.2300",
    due: new Date("2026-07-24T00:00:00.000Z"),
    occurs_at: new Date("2026-07-24T10:11:12.000Z"),
    enabled: true,
    label: "Exact",
    owner_id: object,
    note: null,
  };
  assertEquals(
    reconcileSeedRow(desired, current, context, descriptors),
    null,
  );
});

Deno.test("seed reconcile does not coerce unsafe integers or boolean, string, ref, and null values", () => {
  const desired = {
    unsafe: Number.MAX_SAFE_INTEGER + 1,
    enabled: true,
    label: "1",
    owner_id: object,
    note: null,
  };
  const update = reconcileSeedRow(
    desired,
    {
      id: object,
      version: 4,
      unsafe: "9007199254740992",
      enabled: "true",
      label: 1,
      owner_id: object.toUpperCase(),
      note: "null",
    },
    context,
    {
      unsafe: { type: "integer" },
      enabled: { type: "boolean" },
      label: { type: "string" },
      owner_id: { type: "string", ref: "test/demo:user" },
      note: { type: "string", nullable: true },
    },
  )!;
  assertEquals(update.set, desired);
});
