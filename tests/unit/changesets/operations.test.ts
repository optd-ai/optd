import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  authoredOperationContract,
  stageRequestContract,
} from "../../../src/schemas/changesets/operations.ts";
import {
  normalizeOperations,
  OperationError,
} from "../../../src/domain/changesets/operations.ts";
import {
  applyPatches,
  PatchError,
} from "../../../src/domain/changesets/patch.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const generated = [
  "019b7a2e-7c10-7000-8000-000000000010",
  "019b7a2e-7c10-7000-8000-000000000011",
];

Deno.test("authored operations reject caller IDs and legacy aliases", () => {
  for (
    const extra of [
      "object_id",
      "id",
      "actor_id",
      "causation_id",
      "idempotency_key",
    ]
  ) {
    const value = {
      op: "create",
      project_id: project,
      resource: "operant/crm:lead",
      fields: {},
      [extra]: generated[0],
    };
    assertEquals(authoredOperationContract.check(value), false);
  }
  assertEquals(
    stageRequestContract.check({
      project_id: project,
      operations: [{
        op: "update",
        resource: "operant/crm:lead",
        object_id: generated[0],
        expectedVersion: 1,
        set: { name: "x" },
      }],
    }),
    false,
  );
});

Deno.test("normalization allocates before resolving forward refs and folds update", async () => {
  let index = 0;
  const result = await normalizeOperations({
    project_id: project,
    operations: [
      {
        op: "update",
        resource: "operant/crm:lead",
        object_id: { $ref: "lead.object_id" },
        set: { score: 2 },
      },
      {
        op: "create",
        key: "lead",
        resource: "operant/crm:lead",
        fields: { name: "A" },
      },
    ],
  }, () => generated[index++]);
  assertEquals(result.operations.length, 1);
  assertEquals(result.operations[0].op, "create");
  assertEquals(result.operations[0].key, "op_000001");
  assertEquals(result.operations[0].fields, { score: 2, name: "A" });
  assertEquals(result.operationGraphDigest.startsWith("sha256:"), true);
});

Deno.test("normalization rejects cross-project and conflicting mutation refs", async () => {
  await assertRejects(
    () =>
      normalizeOperations({
        operations: [
          {
            op: "create",
            key: "lead",
            project_id: project,
            resource: "operant/crm:lead",
            fields: {},
          },
          {
            op: "comment",
            project_id: "019b7a2e-7c10-7000-8000-000000000002",
            resource: "operant/crm:lead",
            object_id: { $ref: "lead.object_id" },
            body: "x",
          },
        ],
      }, () => generated[0]),
    OperationError,
    "cross-project",
  );
});

Deno.test("patch engine implements pointer escapes and RFC 6902 arrays", () => {
  const output = applyPatches({ "a/b": { values: [1, 3] } }, [
    { op: "add", path: "/a~1b/values/1", value: 2 },
    { op: "test", path: "/a~1b/values/2", value: 3 },
  ], new Set(["a/b"]));
  assertEquals(output, { "a/b": { values: [1, 2, 3] } });
  assertThrows(
    () =>
      applyPatches(
        { a: 1 },
        [{ op: "replace", path: "/a~2", value: 2 }],
        new Set(["a"]),
      ),
    PatchError,
  );
  assertThrows(
    () =>
      applyPatches({ a: 1 }, [{ op: "remove", path: "/id" }], new Set(["a"])),
    PatchError,
    "mutable",
  );
});
