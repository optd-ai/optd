import {
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  authoredOperationContract,
  stageRequestContract,
} from "../../../src/schemas/changesets/operations.ts";
import {
  normalizeOperations,
  OperationError,
} from "../../../src/domain/changesets/operations.ts";
import { stageDigest } from "../../../src/domain/changesets/stage.ts";
import {
  applyPatches,
  compilePatchedMutation,
  PatchError,
} from "../../../src/domain/changesets/patch.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const generated = [
  "019b7a2e-7c10-7000-8000-000000000010",
  "019b7a2e-7c10-7000-8000-000000000011",
];

Deno.test("all seven authored operation schemas are accepted exactly", () => {
  const values = [
    { op: "create", resource: "optd/crm:lead", fields: {} },
    {
      op: "update",
      resource: "optd/crm:lead",
      object_id: generated[0],
      set: { score: 1 },
    },
    {
      op: "transition",
      resource: "optd/crm:lead",
      object_id: generated[0],
      to: "done",
    },
    { op: "archive", resource: "optd/crm:lead", object_id: generated[0] },
    {
      op: "link",
      relationship: "optd/crm:lead_owner",
      from: generated[0],
      to: generated[1],
    },
    {
      op: "unlink",
      relationship: "optd/crm:lead_owner",
      relationship_id: generated[0],
    },
    {
      op: "comment",
      resource: "optd/crm:lead",
      object_id: generated[0],
      body: "ok",
    },
  ];
  for (const value of values) {
    assertEquals(authoredOperationContract.check(value), true);
  }
});

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
      resource: "optd/crm:lead",
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
        resource: "optd/crm:lead",
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
        resource: "optd/crm:lead",
        object_id: { $ref: "lead.object_id" },
        set: { score: 2 },
      },
      {
        op: "create",
        key: "lead",
        resource: "optd/crm:lead",
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
            resource: "optd/crm:lead",
            fields: {},
          },
          {
            op: "comment",
            project_id: "019b7a2e-7c10-7000-8000-000000000002",
            resource: "optd/crm:lead",
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

Deno.test("normalization allocates fresh IDs and rejects mutation conflicts", async () => {
  const request = {
    project_id: project,
    operations: [
      {
        op: "create" as const,
        key: "lead",
        resource: "optd/crm:lead",
        fields: { score: 1 },
      },
      {
        op: "comment" as const,
        resource: "optd/crm:lead",
        object_id: { $ref: "lead.object_id" },
        body: "x",
      },
    ],
  };
  const first = await normalizeOperations(request);
  const second = await normalizeOperations(request);
  assertNotEquals(
    first.operations[0].object_id,
    second.operations[0].object_id,
  );
  assertNotEquals(
    first.operations[1].comment_id,
    second.operations[1].comment_id,
  );
  assertNotEquals(first.operationGraphDigest, second.operationGraphDigest);
  await assertRejects(
    () =>
      normalizeOperations({
        project_id: project,
        operations: [
          {
            op: "update",
            resource: "optd/crm:lead",
            object_id: generated[0],
            set: { score: 1 },
          },
          {
            op: "update",
            resource: "optd/crm:lead",
            object_id: generated[0],
            set: { score: 2 },
          },
        ],
      }),
    OperationError,
    "different values",
  );
  await assertRejects(
    () =>
      normalizeOperations({
        project_id: project,
        operations: [
          {
            op: "archive",
            resource: "optd/crm:lead",
            object_id: generated[0],
          },
          {
            op: "update",
            resource: "optd/crm:lead",
            object_id: generated[0],
            set: { score: 2 },
          },
        ],
      }),
    OperationError,
    "archive",
  );
});

Deno.test("normalization enforces all operational limits", async () => {
  const request = {
    project_id: project,
    operations: [{
      op: "create" as const,
      resource: "optd/crm:lead",
      fields: { name: "abcd" },
    }],
  };
  const limits = (
    maxOperations: number,
    maxDepth: number,
    maxGraphBytes: number,
    maxStringBytes: number,
  ) => ({ maxOperations, maxDepth, maxGraphBytes, maxStringBytes });
  await assertRejects(
    () => normalizeOperations(request, undefined, limits(0, 64, 1000, 100)),
    OperationError,
  );
  await assertRejects(
    () => normalizeOperations(request, undefined, limits(2, 64, 10, 100)),
    OperationError,
  );
  await assertRejects(
    () => normalizeOperations(request, undefined, limits(2, 64, 1000, 3)),
    OperationError,
  );
  await assertRejects(
    () => normalizeOperations(request, undefined, limits(2, 2, 1000, 100)),
    OperationError,
  );
});

Deno.test("stage digest binds every required evidence category", async () => {
  const base = {
    operation_graph_digest: `sha256:${"1".repeat(64)}`,
    projects: [{ project_id: project, version: 1, status: "active" }],
    pack_revisions: [{ revision_id: generated[0] }],
    operations: [],
    dependencies: [{ kind: "policy", digest: `sha256:${"2".repeat(64)}` }],
    hook_executions: [],
    policy_decisions: [{ allowed: true }],
    approval_requirements: [],
    required_capabilities: ["create"],
    effects: ["resource:create"],
    planned_events: [],
    planned_deliveries: [],
  };
  const original = await stageDigest(base);
  for (const key of Object.keys(base) as Array<keyof typeof base>) {
    const changed = structuredClone(base);
    if (Array.isArray(changed[key])) {
      (changed[key] as unknown[]).push({ changed: key });
    } else changed.operation_graph_digest = `sha256:${"3".repeat(64)}`;
    assertNotEquals(await stageDigest(changed), original, key);
  }
  assertEquals(await stageDigest(structuredClone(base)), original);
});

Deno.test("patch failures and canonical recompilation are deterministic", () => {
  assertThrows(
    () =>
      applyPatches(
        { a: 1 },
        [{ op: "test", path: "/a", value: 2 }],
        new Set(["a"]),
      ),
    PatchError,
    "test failed",
  );
  assertThrows(
    () =>
      applyPatches({ a: 1 }, [
        { op: "replace", path: "/a", value: 2 },
        { op: "replace", path: "/a", value: 3 },
      ], new Set(["a"])),
    PatchError,
    "duplicate",
  );
  assertEquals(compilePatchedMutation(null, { z: 1, a: 2 }), {
    fields: { a: 2, z: 1 },
  });
  assertEquals(compilePatchedMutation({ a: 1, b: 2 }, { a: 3, c: null }), {
    set: { a: 3, c: null },
    unset: ["b"],
  });
});
