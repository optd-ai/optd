// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { queryRequestContract } from "../../src/schemas/queries/query.ts";
import {
  evaluateTargetedActionPolicy,
  lockExactTargetAuthorityDependencies,
} from "../../src/adapters/outbound/postgres/repositories/query_object_repository.ts";
import {
  makeQueryObjectsService,
  type QueryDefinition,
} from "../../src/application/services/query_objects.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";

Deno.test("exact multi-target authority rows lock in canonical table and UUID order", async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const fake = {
    unsafe(sql: string, params: unknown[]) {
      calls.push({ sql, params });
      if (sql.includes("pack_runtime_tables")) {
        return Promise.resolve([{
          table_name: params[2] === "alpha_owner"
            ? "runtime_alpha_owner"
            : "runtime_zeta_owner",
        }]);
      }
      return Promise.resolve([]);
    },
  };
  const id = (suffix: string) =>
    `01900000-0000-7000-8000-${suffix.padStart(12, "0")}`;
  await lockExactTargetAuthorityDependencies(fake, [{
    target_dependency: "role_assignment",
    assignment_table: "role_assignments",
    assignment_id: id("9"),
    system_role_id: "test:second",
    role_version_id: id("8"),
  }, {
    target_dependency: "relationship",
    resource_identity: "test/pack:zeta_owner",
    object_id: id("7"),
  }, {
    target_dependency: "policy_rule",
    policy_assignment_id: id("6"),
    policy_version_id: id("5"),
    rule_id: id("4"),
  }, {
    target_dependency: "relationship",
    resource_identity: "test/pack:alpha_owner",
    object_id: id("3"),
  }, {
    target_dependency: "role_assignment",
    assignment_table: "role_assignments",
    assignment_id: id("2"),
    system_role_id: "test:first",
    role_version_id: id("1"),
  }]);
  assertEquals(
    calls.filter((call) => call.sql.includes("pack_runtime_tables")).map(
      (call) => call.params[2],
    ),
    ["alpha_owner", "zeta_owner"],
  );
  assertEquals(
    calls.filter((call) =>
      call.sql.includes("where id=$1 for share") &&
      !call.sql.includes("pack_runtime_tables")
    )
      .map((call) => [
        /from\s+"([^"]+)"/.exec(call.sql)?.[1],
        call.params[0],
      ]),
    [
      ["policy_assignments", id("6")],
      ["policy_definition_versions", id("5")],
      ["policy_rules", id("4")],
      ["role_assignments", id("2")],
      ["role_assignments", id("9")],
      ["role_definition_versions", id("1")],
      ["role_definition_versions", id("8")],
      ["runtime_alpha_owner", id("3")],
      ["runtime_zeta_owner", id("7")],
      ["system_roles", "test:first"],
      ["system_roles", "test:second"],
    ],
  );
});

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
  let cursorFactoryCalls = 0;
  const service = makeQueryObjectsService({
    async execute(_call, work) {
      return await work({
        projectExists: true,
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
  }, () => {
    cursorFactoryCalls++;
    return {
      shapeDigest: () => Promise.resolve("shape"),
      decode: () => Promise.reject(new Error("unused")),
      encode: () => Promise.reject(new Error("unused")),
    };
  });
  assertEquals(cursorFactoryCalls, 0);
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
  assertEquals(cursorFactoryCalls, 0);
  const accepted = await service.query(base, auth);
  assertEquals(accepted.ok, true);
  assertEquals(pageCalls, 1);
  assertEquals(cursorFactoryCalls, 1);
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
      if (
        text.includes("from role_assignments ra") ||
        text.includes("from agent_authorization_roles ar")
      ) {
        return [{
          assignment_id: "role-assignment",
          assignment_owner_id: auth.principalId,
          assignment_active: true,
          assignment_version: 1,
          role_id: "operant/projects:member",
          system_role_active: true,
          version_id: "role-version",
          version: 1,
          role_version_active: true,
          role_candidate_revision_id: null,
          role_definition_name: null,
          boundary_type: "all_projects",
          project_id: null,
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
          condition_kind: mode,
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
          policy_version_active: true,
          policy_candidate_revision_id: null,
          policy_definition_name: null,
          policy_candidate_active: true,
          assignment_id: "assignment",
          assignment_version: 1,
          assignment_boundary_type: "all_projects",
          assignment_project_id: null,
          assignment_active: true,
          evaluation_order: 0,
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

Deno.test("Project policy SQL keeps system boundaries isolated", async () => {
  const humanSql = policySql({ resource: "operant/projects:task" });
  await evaluateTargetedActionPolicy(
    humanSql,
    { projectId, action, targets: [taskTarget] },
    auth,
  );
  const humanRoles =
    humanSql.statements.find((item) =>
      item.text.includes("from role_assignments ra")
    )!.text;
  assertEquals(humanRoles.includes("ra.boundary_type='all_projects'"), true);
  assertEquals(
    humanRoles.includes(
      "ra.boundary_type='project' and ra.project_id=$2",
    ),
    true,
  );
  assertEquals(
    humanRoles.includes(
      "ra.role_id='system:super_admin' and ra.boundary_type='system'",
    ),
    true,
  );
  assertEquals(
    humanRoles.includes("ra.boundary_type in ('system','all_projects')"),
    false,
  );

  const agentSql = policySql({ resource: "operant/projects:task" });
  await evaluateTargetedActionPolicy(
    agentSql,
    { projectId, action, targets: [taskTarget] },
    {
      ...auth,
      principalType: "agent_user",
      credentialKind: "agent_authorization",
      authorizationId: "authorization",
    },
  ).catch(() => undefined);
  const agentRoles =
    agentSql.statements.find((item) =>
      item.text.includes("from agent_authorization_roles ar")
    )!.text;
  assertEquals(agentRoles.includes("ar.boundary_type='all_projects'"), true);
  assertEquals(
    agentRoles.includes(
      "ar.boundary_type='project' and ar.project_id=$2",
    ),
    true,
  );
  assertEquals(
    agentRoles.includes(
      "ar.role_id='system:super_admin' and ar.boundary_type='system'",
    ),
    true,
  );
  assertEquals(
    agentRoles.includes("ar.boundary_type in ('system','all_projects')"),
    false,
  );

  const policy =
    humanSql.statements.find((item) =>
      item.text.includes("from policy_rules pr join")
    )!.text;
  assertEquals(policy.includes("pa.boundary_type='all_projects'"), true);
  assertEquals(
    policy.includes(
      "pa.boundary_type='project' and pa.project_id=$4",
    ),
    true,
  );
  assertEquals(policy.includes("pa.boundary_type='system'"), false);
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
