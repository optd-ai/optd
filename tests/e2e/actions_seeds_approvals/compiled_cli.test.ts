// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  type Sql,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { startHttpProvider } from "../../support/http_provider.ts";
import {
  seedRead,
  writePack,
} from "../../integration/hook_secret_action_stage.test.ts";

for (const trace of [false, true]) {
  Deno.test({
    name: `forced-fresh compiled CLI action and seed canonical E2E (${
      trace ? "trace" : "default"
    })`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const provider = startHttpProvider([{
        kind: "success",
        body: { ok: true },
      }, { kind: "success", body: { ok: true } }]);
      const harness = await startLiveHarness({
        environment: trace ? { OPERANT_LOG_LEVEL: "trace" } : {},
      });
      const pack = await Deno.makeTempDir({
        prefix: "operant-actions-seeds-e2e-",
      });
      let actor: CliLauncher | undefined;
      let reviewer: CliLauncher | undefined;
      try {
        assertEquals(
          (await harness.bootstrap({
            username: "acceptance-admin",
            password: "acceptance bootstrap password",
            displayName: "Acceptance Administrator",
          })).code,
          0,
        );
        await writePack(pack, provider.url);
        assertEquals(
          (await harness.runOptctl(["--json", "pack", "apply", pack, "--safe"]))
            .code,
          0,
        );
        const project = await harness.runOptctl([
          "--json",
          "project",
          "create",
          "acceptance-project",
          "--display-name",
          "Acceptance Project",
        ]);
        assertEquals(project.code, 0, project.stderr);
        const projectId = JSON.parse(project.stdout).data.id as string;
        const read = await seedRead(harness, projectId);
        actor = await provisionOrdinary(
          harness,
          `actor-${trace ? "trace" : "default"}`,
          "all_projects",
        );
        reviewer = await provisionOrdinary(
          harness,
          `reviewer-${trace ? "trace" : "default"}`,
          "system",
        );

        const action = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ project_id: projectId, source_id: read.id }),
        ]);
        assertEquals(action.code, 0, action.stderr);
        const actionData = JSON.parse(action.stdout).data;
        assertEquals(actionData.source, {
          kind: "action",
          identity: {
            action: "test/actionproof:generate",
            revision_id: actionData.source.identity.revision_id,
          },
        });
        assertEquals(
          actionData.hook_executions.filter((item: { phase: string }) =>
            item.phase === "action.stage"
          ).length,
          1,
        );
        const inspect = await actor!.runOptctl([
          "--json",
          "changeset",
          "inspect",
          actionData.id,
        ]);
        assertEquals(
          JSON.parse(inspect.stdout).data.operation_graph_digest,
          actionData.operation_graph_digest,
        );

        const missingRead = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ project_id: projectId, source_id: uuidV7() }),
        ]);
        assertEquals(missingRead.code, 1);
        const beforeSeed = await stageCount(harness.server.sql);
        const seed = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(seed.code, 0, seed.stderr);
        const seedData = JSON.parse(seed.stdout).data;
        assertEquals(seedData.stage.source.kind, "seed");
        assertEquals(await stageCount(harness.server.sql), beforeSeed + 1);
        await materializeSeed(harness.server.sql, projectId, seedData.stage);
        const unchanged = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(unchanged.code, 0, unchanged.stderr);
        assertEquals(JSON.parse(unchanged.stdout).data.stage, null);
        assertEquals(await stageCount(harness.server.sql), beforeSeed + 1);
        const seedObjectId = seedData.stage.operations[0].object_id;
        const targetTable = await runtimeTable(harness.server.sql, "target");
        await query(
          harness.server.sql,
          `update "${targetTable}" set status='stale' where project_id=$1 and id=$2`,
          [projectId, seedObjectId],
        );
        const changed = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(changed.code, 0, changed.stderr);
        const changedOperation =
          JSON.parse(changed.stdout).data.stage.operations[0];
        assertEquals(changedOperation.op, "update");
        assertEquals(changedOperation.object_id, seedObjectId);
        assertEquals(changedOperation.set, { status: "ready" });
        assertEquals(
          (await query<{ note: string }>(
            harness.server.sql,
            `select note from "${targetTable}" where id=$1`,
            [seedObjectId],
          )).rows[0].note,
          "preserved extra",
        );
        const toon = await actor!.runOptctl([
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(toon.code, 0, toon.stderr);
        assertEquals(toon.stdout.includes("status: staged"), true);

        const concurrentProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `concurrent-${trace ? "trace" : "default"}`,
          "--display-name",
          "Concurrent Seed Project",
        ]);
        assertEquals(concurrentProject.code, 0, concurrentProject.stderr);
        const concurrentId = JSON.parse(concurrentProject.stdout).data
          .id as string;
        const concurrentStages = await Promise.all(
          [0, 1].map(() =>
            actor!.runOptctl([
              "--json",
              "--project",
              concurrentId,
              "seed",
              "stage",
              "test/actionproof",
              "--seed",
              "targets",
            ])
          ),
        );
        assertEquals(concurrentStages.map((result) => result.code), [0, 0]);
        const concurrentData = concurrentStages.map((result) =>
          JSON.parse(result.stdout).data.stage
        );
        assertEquals(
          concurrentData[0].operations[0].object_id ===
            concurrentData[1].operations[0].object_id,
          false,
        );
        await materializeSeed(
          harness.server.sql,
          concurrentId,
          concurrentData[0],
        );
        let uniquenessRejected = false;
        try {
          await materializeSeed(
            harness.server.sql,
            concurrentId,
            concurrentData[1],
          );
        } catch {
          uniquenessRejected = true;
        }
        assertEquals(uniquenessRejected, true);

        const multiProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `multi-${trace ? "trace" : "default"}`,
          "--display-name",
          "Multi Seed Project",
        ]);
        assertEquals(multiProject.code, 0, multiProject.stderr);
        const multiProjectId = JSON.parse(multiProject.stdout).data
          .id as string;
        const multiSeed = await actor!.runOptctl([
          "--json",
          "--project",
          multiProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets_alt",
          "--seed",
          "targets",
        ]);
        assertEquals(multiSeed.code, 0, multiSeed.stderr);
        const multiData = JSON.parse(multiSeed.stdout).data.stage;
        assertEquals(multiData.source.identity.seed_names, [
          "targets",
          "targets_alt",
        ]);
        assertEquals(
          [
            ...new Set(
              multiData.policy_decisions.map((decision: { action: string }) =>
                decision.action
              ),
            ),
          ].sort(),
          [
            "seed:test/actionproof:targets",
            "seed:test/actionproof:targets_alt",
          ],
        );
        const limited = await provisionOrdinary(
          harness,
          `limited-${trace ? "trace" : "default"}`,
          "all_projects",
          ["targets"],
        );
        const deniedMulti = await limited.runOptctl([
          "--json",
          "--project",
          multiProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
          "--seed",
          "targets_alt",
        ]);
        assertEquals(deniedMulti.code, 1);
        await limited.close();

        const approval = await insertApprovalFixture(harness.server.sql);
        const listed = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "approvals",
          approval.stageId,
        ]);
        assertEquals(listed.code, 0, listed.stderr);
        const approved = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "approve",
          approval.stageId,
          approval.requirementId,
          "--reason",
          "reviewed",
        ]);
        assertEquals(approved.code, 0, approved.stderr);
        const approvedData = JSON.parse(approved.stdout).data;
        assertEquals(approvedData.status, "ready");
        assertEquals(approvedData.operation_graph_digest, approval.digest);
        const duplicate = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "reject",
          approval.stageId,
          approval.requirementId,
          "--reason",
          "opposite duplicate",
        ]);
        assertEquals(duplicate.code, 0, duplicate.stderr);
        assertEquals(
          JSON.parse(duplicate.stdout).data.approval_decisions.length,
          1,
        );
        const rejectedFixture = await insertApprovalFixture(harness.server.sql);
        const rejected = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "reject",
          rejectedFixture.stageId,
          rejectedFixture.requirementId,
          "--reason",
          "unsafe",
        ]);
        assertEquals(rejected.code, 0, rejected.stderr);
        assertEquals(JSON.parse(rejected.stdout).data.status, "rejected");
        assertEquals(
          (await reviewer!.runOptctl([
            "--json",
            "changeset",
            "approve",
            rejectedFixture.stageId,
            rejectedFixture.requirementId,
          ])).code,
          0,
        );

        for (
          const legacy of [
            ["action", "preview", "test/actionproof:generate", "--input", "{}"],
            ["action", "commit", "test/actionproof:generate", "--input", "{}"],
            ["seed", "commit", "test/actionproof", "--all"],
          ]
        ) {
          assertEquals(
            (await reviewer!.runOptctl([
              "--json",
              "--project",
              projectId,
              ...legacy,
            ])).code,
            2,
          );
        }
      } finally {
        await actor?.close();
        await reviewer?.close();
        await harness.close();
        await provider.close();
        await Deno.remove(pack, { recursive: true }).catch(() => undefined);
      }
    },
  });
}

async function provisionOrdinary(
  harness: LiveHarness,
  username: string,
  boundary: "all_projects" | "system",
  seedNames: string[] = ["targets", "targets_alt"],
): Promise<CliLauncher> {
  const password = `ordinary password ${username}`;
  const created = await harness.runOptctl([
    "--json",
    "auth",
    "user",
    "create",
    "--username",
    username,
    "--display-name",
    username,
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(created.code, 0, created.stderr);
  const principalId = (await query<{ principal_id: string }>(
    harness.server.sql,
    "select principal_id from human_users where username=$1",
    [username],
  )).rows[0].principal_id;
  const role = boundary === "system"
    ? "system:admin"
    : `system:${username.replaceAll("-", "_")}`;
  if (boundary !== "system") {
    await query(
      harness.server.sql,
      "insert into system_roles(id,display_name,active) values($1,$2,true)",
      [role, username],
    );
    await query(
      harness.server.sql,
      "insert into role_definition_versions(id,role_id,version,active) values($1,$2,1,true)",
      [uuidV7(), role],
    );
  }
  await query(
    harness.server.sql,
    "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,$3,$4,true)",
    [uuidV7(), principalId, role, boundary],
  );
  const version = uuidV7();
  await query(
    harness.server.sql,
    "insert into policy_definition_versions(id,policy_id,version,active) values($1,$2,1,true)",
    [version, `system:${username.replaceAll("-", "_")}`],
  );
  const capabilities = boundary === "system"
    ? [["changeset.approval.decide", "system:changeset-approval"]]
    : [
      ["action:test/actionproof:generate", "action:test/actionproof:generate"],
      ...seedNames.map((
        name,
      ) => [`seed:test/actionproof:${name}`, `seed:test/actionproof:${name}`]),
      ["changeset.inspect", "changeset"],
      ["project.read", "*"],
    ];
  for (const [capability, resource] of capabilities) {
    await query(
      harness.server.sql,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind) values($1,$2,$3,$4,$5,'unconditional')",
      [uuidV7(), version, role, capability, resource],
    );
  }
  await query(
    harness.server.sql,
    "insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,$3,true)",
    [uuidV7(), version, boundary],
  );
  const launcher = await harness.createProcessTreeLauncher("human");
  const login = await launcher.runOptctl([
    "--json",
    "auth",
    "login",
    "--username",
    username,
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(login.code, 0, login.stderr);
  return launcher;
}

async function insertApprovalFixture(sql: Sql) {
  const auth = (await query<{ id: string; principal_id: string }>(
    sql,
    "select id,principal_id from auth_contexts order by created_at desc limit 1",
  )).rows[0];
  const stageId = uuidV7(),
    requirementId = uuidV7(),
    digest = `sha256:${"d".repeat(64)}`;
  await query(
    sql,
    `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json) values($1,1,'direct','{}',$2,$3,'{}',$4,$4,'{"schema":"changeset.operations.v1","operations":[]}','[]','[]','[]','[]','[]')`,
    [stageId, auth.id, auth.principal_id, digest],
  );
  await query(
    sql,
    `insert into staged_approval_requirements(id,stage_id,ordinal,requirement_json) values($1,$2,0,$3::jsonb)`,
    [requirementId, stageId, {
      id: requirementId,
      key: "acceptance_review",
      role: "system:admin",
      boundary: { type: "system" },
      minimum: 1,
      principal_types: ["human_user"],
      allow_initiator: true,
      expires_at: null,
      reason: "acceptance review",
    }],
  );
  await query(
    sql,
    "insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'awaiting_approval',1)",
    [stageId],
  );
  return { stageId, requirementId, digest };
}

async function stageCount(sql: Parameters<typeof query>[0]) {
  return Number(
    (await query<{ count: string }>(
      sql,
      "select count(*)::text count from staged_changesets",
    )).rows[0].count,
  );
}
async function runtimeTable(sql: Sql, name: string) {
  return (await query<{ table_name: string }>(
    sql,
    `select table_name from pack_runtime_tables where publisher='test' and pack_name='actionproof' and definition_kind='resource' and definition_name=$1`,
    [name],
  )).rows[0].table_name;
}

async function materializeSeed(
  sql: Sql,
  projectId: string,
  stage: Record<string, unknown>,
) {
  const operation = (stage.operations as Array<Record<string, unknown>>)[0];
  const metadata = (await query<{ candidate: string; table_name: string }>(
    sql,
    `select a.candidate_revision_id candidate,r.table_name from pack_active_revisions a join pack_runtime_tables r on r.publisher=a.publisher and r.pack_name=a.pack_name where a.publisher='test' and a.pack_name='actionproof' and r.definition_kind='resource' and r.definition_name='target'`,
  )).rows[0];
  const auth = (await query<{ id: string }>(
    sql,
    "select id from auth_contexts order by created_at desc limit 1",
  )).rows[0].id;
  const commitId = uuidV7(),
    versionId = uuidV7(),
    digest = String(stage.operation_graph_digest);
  await sql.begin(async (tx) => {
    await query(
      tx,
      "update staged_changeset_lifecycle set status='committed',committed_at=now() where stage_id=$1",
      [stage.id],
    );
    await query(
      tx,
      "insert into changeset_commits(id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest) values($1,$2,$3,now(),$4)",
      [commitId, stage.id, auth, digest],
    );
    await query(
      tx,
      `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id) values($1,$2,'resource','test/actionproof:target',$3,1,$4,'create',$5,$6::jsonb,array['name','status'],$7)`,
      [
        versionId,
        projectId,
        operation.object_id,
        commitId,
        metadata.candidate,
        { data: operation.fields, archived_at: null },
        auth,
      ],
    );
    const fields = operation.fields as Record<string, unknown>;
    await query(
      tx,
      `insert into "${metadata.table_name}"(id,project_id,version,current_object_version_id,created_by,updated_by,name,status,note) values($1,$2,1,$3,$4,$4,$5,$6,'preserved extra')`,
      [
        operation.object_id,
        projectId,
        versionId,
        auth,
        fields.name,
        fields.status,
      ],
    );
  });
}
