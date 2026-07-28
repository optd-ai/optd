// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { queryRequestContract } from "../../src/schemas/queries/query.ts";
import { evaluateTargetedActionPolicy } from "../../src/adapters/outbound/postgres/repositories/query_object_repository.ts";
import {
  makeQueryObjectsService,
  type QueryDefinition,
} from "../../src/application/services/query_objects.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";

Deno.test("query contract is strict, Project-scoped, and bounded", () => {
  const valid = {
    project_id: "019b7a2e-7c10-7000-8000-000000000002",
    definition: {
      kind: "resource",
      publisher: "operant",
      pack: "crm",
      name: "lead",
    },
    sort: [{ field: "updated_at", direction: "desc" }],
    limit: 500,
  };
  assertEquals(queryRequestContract.issues(valid), []);
  assertEquals(
    queryRequestContract.issues({ ...valid, actor: [] })[0]?.code,
    "unknown_field",
  );
  assertEquals(
    queryRequestContract.issues({ ...valid, limit: 501 })[0]?.code,
    "maximum",
  );
  assertEquals(
    queryRequestContract.issues({ ...valid, sort: [] })[0]?.code,
    "minItems",
  );
});

Deno.test("query application owns definition-aware projection and sort validation", async () => {
  const definition: QueryDefinition = {
    revisionId: "revision",
    document: { spec: { axi: { list: { fields: ["name"] } } } },
    fields: {
      id: { type: "string" },
      updated_at: { type: "timestamp" },
      name: { type: "string" },
    },
    packFields: ["name"],
    identity: "operant/crm:lead",
  };
  let pageCalls = 0;
  const service = makeQueryObjectsService({
    async execute(_call, work) {
      return await work({
        definition: () => Promise.resolve(definition),
        authorize: () =>
          Promise.resolve({
            policyDigest: "digest",
            normalizedWhere: true,
            visible: true,
            archivedVisible: true,
          }),
        page: {
          query: (_plan) => {
            pageCalls++;
            return Promise.resolve({
              rows: [],
              nextPosition: null,
              hasMore: false,
              total: null,
            });
          },
        },
      });
    },
  }, {
    shapeDigest: () => Promise.resolve("shape"),
    decode: () => Promise.reject(new Error("unused")),
    encode: () => Promise.reject(new Error("unused")),
  });
  const base = {
    project_id: "019b7a2e-7c10-7000-8000-000000000002",
    definition: {
      kind: "resource" as const,
      publisher: "operant",
      pack: "crm",
      name: "lead",
    },
  };
  const rejected = await service.query({ ...base, fields: ["missing"] }, auth);
  assertEquals(rejected.ok, false);
  assertEquals(pageCalls, 0);
  const accepted = await service.query(base, auth);
  assertEquals(accepted.ok, true);
  assertEquals(pageCalls, 1);
  if (accepted.ok) {
    assertEquals(accepted.value.resolved_fields, ["name"]);
    assertEquals(accepted.value.resolved_sort, [
      { field: "updated_at", direction: "desc" },
      { field: "id", direction: "desc" },
    ]);
  }
});

const auth: AuthContext = {
  id: "019b7a2e-7c10-7000-8000-000000000010",
  principalId: "019b7a2e-7c10-7000-8000-000000000011",
  principalType: "human_user",
  humanUserId: "019b7a2e-7c10-7000-8000-000000000012",
  sessionId: "019b7a2e-7c10-7000-8000-000000000013",
  credentialKind: "human_full",
  roles: [],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const projectId = "019b7a2e-7c10-7000-8000-000000000020";
const objectId = "019b7a2e-7c10-7000-8000-000000000021";
const action = "action:operant/projects:start_task";
const taskTarget = {
  definition: {
    kind: "resource" as const,
    publisher: "operant",
    pack: "projects",
    name: "task",
  },
  objectId,
};

type RuleMode = "unconditional" | "abac" | "rebac";
function policySql(options: {
  resource?: string;
  mode?: RuleMode;
  objectAllowed?: boolean;
}) {
  const statements: Array<{ text: string; params: unknown[] }> = [];
  return {
    statements,
    unsafe: (text: string, params: unknown[]) => {
      statements.push({ text, params });
      if (
        text.includes("jsonb_extract_path(cr.normalized,$4::text,$5::text)")
      ) {
        return params[4] === "task"
          ? [{
            revision_id: "revision",
            table_name: "task_table",
            document: {
              spec: {
                fields: {
                  assignee_id: {
                    type: "string",
                    required: true,
                    ref: "system:principal",
                  },
                },
              },
            },
          }]
          : [];
      }
      if (text.includes("select ra.role_id,rv.id version_id")) {
        return [{
          role_id: "operant/projects:member",
          version_id: "role-version",
          version: 1,
          boundary_type: "all_projects",
        }];
      }
      if (text.includes("from policy_rules pr join")) {
        if (
          params[1] !== action || params[2] !== options.resource ||
          params[4] !== true
        ) {
          return [];
        }
        const mode = options.mode ?? "unconditional";
        return [{
          id: "rule",
          rule_name: "targeted",
          role_id: "operant/projects:member",
          capability: action,
          resource: options.resource,
          predicate: mode === "abac" ? "assignee_id == actor.id" : null,
          relation_relationship: mode === "rebac"
            ? "operant/projects:task_member"
            : null,
          relation_object_side: mode === "rebac" ? "from" : null,
          relation_subject_side: mode === "rebac" ? "to" : null,
          relation_subject: mode === "rebac" ? "actor.id" : null,
          policy_id: "policy",
          policy_version_id: "policy-version",
          policy_version: 1,
          assignment_id: "assignment",
          assignment_version: 1,
        }];
      }
      if (text.includes("jsonb_extract_path(cr.normalized,'relationships'")) {
        return [{
          table_name: "task_member_table",
          document: {
            spec: {
              from: { resource: "operant/projects:task" },
              to: { resource: "system:principal" },
            },
          },
        }];
      }
      if (text.includes('select exists(select 1 from "task_table"')) {
        return [{
          allowed: options.resource === "operant/projects:task" &&
            options.objectAllowed !== false,
        }];
      }
      return [{ id: "locked" }];
    },
  };
}

Deno.test("targeted semantic policy allows the exact task object", async () => {
  const sql = policySql({ resource: "operant/projects:task" });
  const result = await evaluateTargetedActionPolicy(
    sql,
    { projectId, action, targets: [taskTarget] },
    auth,
  );
  assertEquals(result.allowed, true);
  const policyQuery = sql.statements.find((item) =>
    item.text.includes("from policy_rules pr join")
  )!;
  assertEquals(policyQuery.params.slice(1, 5), [
    action,
    "operant/projects:task",
    projectId,
    true,
  ]);
  assertEquals(policyQuery.text.includes("pr.resource='*'"), true);
});

Deno.test("targeted semantic policy rejects wrong resources and ABAC false", async () => {
  const wrong = await evaluateTargetedActionPolicy(
    policySql({ resource: "operant/projects:project" }),
    { projectId, action, targets: [taskTarget] },
    auth,
  );
  assertEquals(wrong.allowed, false);
  const abac = await evaluateTargetedActionPolicy(
    policySql({
      resource: "operant/projects:task",
      mode: "abac",
      objectAllowed: false,
    }),
    { projectId, action, targets: [taskTarget] },
    auth,
  );
  assertEquals(abac.allowed, false);
});

Deno.test("targeted semantic policy lowers direct ReBAC with the server actor", async () => {
  const sql = policySql({ resource: "operant/projects:task", mode: "rebac" });
  const result = await evaluateTargetedActionPolicy(
    sql,
    { projectId, action, targets: [taskTarget] },
    auth,
  );
  assertEquals(result.allowed, true);
  const decision = sql.statements.find((item) =>
    item.text.includes('select exists(select 1 from "task_table"')
  )!;
  assertEquals(decision.text.includes('"task_member_table" rel'), true);
  assertEquals(decision.params.includes(auth.principalId), true);
});

Deno.test("targeted semantic policy requires all targets and exact unconditional zero-read rules", async () => {
  const multi = await evaluateTargetedActionPolicy(
    policySql({ resource: "operant/projects:task" }),
    {
      projectId,
      action,
      targets: [taskTarget, {
        definition: { ...taskTarget.definition, name: "other" },
        objectId,
      }],
    },
    auth,
  );
  assertEquals(multi.allowed, false);

  const unconditional = await evaluateTargetedActionPolicy(
    policySql({ resource: "operant/projects:task" }),
    { projectId, action, targets: [{ definition: taskTarget.definition }] },
    auth,
  );
  assertEquals(unconditional.allowed, true);
  const conditional = await evaluateTargetedActionPolicy(
    policySql({ resource: "operant/projects:task", mode: "abac" }),
    { projectId, action, targets: [{ definition: taskTarget.definition }] },
    auth,
  );
  assertEquals(conditional.allowed, false);
});
