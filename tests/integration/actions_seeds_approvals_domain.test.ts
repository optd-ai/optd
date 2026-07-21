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
