// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { EnvelopeCrypto } from "../../src/adapters/outbound/crypto/envelope.ts";
import { PostgresHookSecretRepository } from "../../src/adapters/outbound/postgres/hook_secret_repository.ts";
import {
  type ActionStageHookDeclaration,
  TrustedStageHookCoordinator,
} from "../../src/adapters/outbound/use-cases/hooks/stage_hook_coordinator.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";
import { startHttpProvider } from "../support/http_provider.ts";

Deno.test({
  name:
    "stored action stage executes curated pinned reads through real coordinator child",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const provider = startHttpProvider([{
      kind: "success",
      body: { ok: true },
    }]);
    const harness = await startAuthenticatedHarness();
    const pack = await Deno.makeTempDir({
      prefix: "operant-action-stage-pack-",
    });
    try {
      await writePack(pack, provider.url);
      const apply = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(apply.code, 0, apply.stderr);
      const project = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "action-stage-project",
        "--display-name",
        "Action Stage Project",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id as string;
      const read = await seedRead(harness, projectId);
      const declaration = await storedDeclaration(harness, provider.url);
      const auth = (await query<{
        id: string;
        principal_id: string;
      }>(
        harness.server.sql,
        "select id,principal_id from auth_contexts order by created_at desc limit 1",
      )).rows[0];
      const coordinator = new TrustedStageHookCoordinator(
        new PostgresHookSecretRepository(
          harness.server.sql,
          new EnvelopeCrypto(null),
        ),
        {
          cacheDir: await Deno.makeTempDir({ prefix: "operant-action-child-" }),
        },
      );
      const authority = {
        principal_id: auth.principal_id,
        auth_context_id: auth.id,
        assignment_digest: `sha256:${"a".repeat(64)}`,
        policy_digest: `sha256:${"b".repeat(64)}`,
      };
      const dependency = {
        name: "source",
        project_id: projectId,
        resource_identity: "test/actionproof:source",
        object_id: read.id,
        object_version_id: read.object_version_id,
      };
      const result = await coordinator.runActionStage({
        action: "test/actionproof:generate",
        actor: {
          id: "0198c4ba-42b8-7000-8000-000000000011",
          principal_type: "human_user",
        },
        project_id: projectId,
        input: {
          source_id: read.id,
          actor: {
            id: "spoofed",
            principal_type: "human_user",
            roles: ["admin"],
          },
        },
        reads: {
          source: { name: read.name, status: read.status },
        },
        read_dependencies: [dependency],
        declarations: [declaration],
        authority_snapshot: authority,
      });
      assertEquals(provider.attempts.length, 1);
      assertEquals(result.added_operations.length, 1);
      assertEquals(result.added_operations[0].op, "create");
      assertEquals(result.added_operations[0].fields, {
        name: "Pinned Source",
        status: "converted",
      });
      assertEquals(result.read_dependencies, [dependency]);
      assertEquals(result.hook_executions.length, 1);
      assertEquals(result.hook_executions[0].read_dependencies, [dependency]);
      assertEquals(result.hook_executions[0].authority_snapshot, authority);
      assertEquals(result.hook_executions[0].grant_snapshot, { grants: [] });
      assertEquals(
        result.hook_executions[0].output_schema,
        "changeset.operations.v1",
      );
      assertEquals(
        result.hook_executions[0].input_digest.startsWith("sha256:"),
        true,
      );
      assertEquals(result.operation_graph_digest.startsWith("sha256:"), true);
      assertEquals(
        "project_id" in
          (result.hook_executions[0].output.operations as Record<
            string,
            unknown
          >[])[0],
        false,
      );
      assertEquals(result.added_operations[0].project_id, projectId);

      const explicitProject = await coordinator.runActionStage({
        action: "test/actionproof:generate",
        actor: {
          id: "0198c4ba-42b8-7000-8000-000000000011",
          principal_type: "human_user",
        },
        project_id: projectId,
        input: { source_id: read.id },
        reads: { source: { name: read.name, status: read.status } },
        read_dependencies: [dependency],
        declarations: [{
          ...declaration,
          script_content:
            `console.log(JSON.stringify({operations:[{op:"create",project_id:"${projectId}",resource:"test/actionproof:target",fields:{name:"same project",status:"ready"}}]}));`,
        }],
        authority_snapshot: authority,
      });
      assertEquals(explicitProject.added_operations[0].project_id, projectId);

      const otherProjectId = uuidV7();
      await assertStageError(
        () =>
          coordinator.runActionStage({
            action: "test/actionproof:generate",
            actor: {
              id: "0198c4ba-42b8-7000-8000-000000000011",
              principal_type: "human_user",
            },
            project_id: projectId,
            input: { source_id: read.id },
            reads: { source: { name: read.name, status: read.status } },
            read_dependencies: [dependency],
            declarations: [{
              ...declaration,
              script_content:
                `console.log(JSON.stringify({operations:[{op:"create",project_id:"${otherProjectId}",resource:"test/actionproof:target",fields:{name:"cross project",status:"ready"}}]}));`,
            }],
            authority_snapshot: authority,
          }),
        "hook_invalid_output",
      );

      const publicStage = await harness.runOptctl([
        "--json",
        "--project",
        "action-stage-project",
        "action",
        "stage",
        "test/actionproof:generate",
        "--input",
        JSON.stringify({ source_id: read.id }),
      ]);
      assertEquals(publicStage.code, 0, publicStage.stderr);
      for (const field of ["principal_id", "actor", "roles"]) {
        const spoofed = await harness.runOptctl([
          "--json",
          "--project",
          "action-stage-project",
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ source_id: read.id, [field]: "spoofed" }),
        ]);
        assertEquals(spoofed.code, 1, `${field}: ${spoofed.stderr}`);
        assertStringIncludes(
          spoofed.stderr,
          "caller-supplied actor or role authority is not accepted",
        );
      }
      const staged = JSON.parse(publicStage.stdout).data;
      assertEquals(staged.source.kind, "action");
      assertEquals(staged.source.identity.action, "test/actionproof:generate");
      assertEquals(staged.operations.length, 1);
      assertEquals(
        staged.hook_executions.some((execution: { phase: string }) =>
          execution.phase === "action.stage"
        ),
        true,
      );
      assertEquals(provider.attempts.length, 2);

      const sourceTable = (await query<{ table_name: string }>(
        harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test' and pack_name='actionproof' and definition_kind='resource' and definition_name='source'`,
      )).rows[0].table_name;
      const beforeUnavailable = await stageCount(harness.server.sql);
      await query(
        harness.server.sql,
        `update "${sourceTable}" set status='blocked' where id=$1`,
        [read.id],
      );
      const unavailable = await harness.runOptctl([
        "--json",
        "--project",
        "action-stage-project",
        "action",
        "stage",
        "test/actionproof:generate",
        "--input",
        JSON.stringify({ source_id: read.id }),
      ]);
      assertEquals(unavailable.code, 1);
      assertEquals(provider.attempts.length, 2);
      assertEquals(await stageCount(harness.server.sql), beforeUnavailable);
      await query(
        harness.server.sql,
        `update "${sourceTable}" set status='ready' where id=$1`,
        [read.id],
      );

      const seedStage = await harness.runOptctl([
        "--json",
        "--project",
        "action-stage-project",
        "seed",
        "stage",
        "test/actionproof",
        "--seed",
        "targets",
      ]);
      assertEquals(seedStage.code, 0, seedStage.stderr);
      const seeded = JSON.parse(seedStage.stdout).data;
      assertEquals(seeded.status, "staged");
      assertEquals(seeded.stage.source.kind, "seed");
      assertEquals(seeded.stage.operations[0].op, "create");

      await assertStageError(
        () =>
          coordinator.runActionStage({
            action: "test/actionproof:generate",
            actor: {
              id: "0198c4ba-42b8-7000-8000-000000000011",
              principal_type: "human_user",
            },
            project_id: projectId,
            input: { source_id: read.id },
            reads: {},
            read_dependencies: [dependency],
            declarations: [declaration],
            authority_snapshot: authority,
          }),
        "hook_input_invalid",
      );
      assertEquals(provider.attempts.length, 2);

      await assertStageError(
        () =>
          coordinator.runActionStage({
            action: "test/actionproof:generate",
            actor: {
              id: "0198c4ba-42b8-7000-8000-000000000011",
              principal_type: "human_user",
            },
            project_id: projectId,
            input: { source_id: read.id },
            reads: {
              source: {
                name: read.name,
                status: read.status,
              },
            },
            read_dependencies: [dependency],
            declarations: [{ ...declaration, effects: [] }],
            authority_snapshot: authority,
          }),
        "hook_effect_denied",
      );
      assertEquals(provider.attempts.length, 3);

      await assertStageError(
        () =>
          coordinator.runActionStage({
            action: "test/actionproof:generate",
            actor: {
              id: "0198c4ba-42b8-7000-8000-000000000011",
              principal_type: "human_user",
            },
            project_id: projectId,
            input: { source_id: read.id },
            reads: {
              source: {
                name: read.name,
                status: read.status,
              },
            },
            read_dependencies: [dependency],
            declarations: [{
              ...declaration,
              script_content:
                `console.log(JSON.stringify({operations:[{op:"create",unknown:true}]}));`,
            }],
            authority_snapshot: authority,
          }),
        "hook_invalid_output",
      );
    } finally {
      await harness.close();
      await provider.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

Deno.test({
  name:
    "targeted action hook persistence deterministically rejects stale authority and read races",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const provider = startHttpProvider();
    const harness = await startAuthenticatedHarness();
    const pack = await Deno.makeTempDir({ prefix: "operant-action-races-" });
    try {
      await writePack(pack, provider.url);
      const apply = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(apply.code, 0, apply.stderr);
      const project = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "action-races",
        "--display-name",
        "Action Races",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id as string;
      const unrelatedProject = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "action-races-unrelated",
        "--display-name",
        "Unrelated Action Races",
      ]);
      assertEquals(unrelatedProject.code, 0, unrelatedProject.stderr);
      const unrelatedProjectId = JSON.parse(unrelatedProject.stdout).data
        .id as string;
      const read = await seedRead(harness, projectId);
      const auth = (await query<{ id: string; principal_id: string }>(
        harness.server.sql,
        "select id,principal_id from auth_contexts order by created_at desc limit 1",
      )).rows[0];
      const roleAssignment = (await query<{ id: string }>(
        harness.server.sql,
        "select id from role_assignments where principal_id=$1 and role_id='system:super_admin' and active",
        [auth.principal_id],
      )).rows[0].id;
      const policy =
        (await query<{ assignment_id: string; version_id: string }>(
          harness.server.sql,
          `select pa.id assignment_id,pdv.id version_id
           from policy_assignments pa join policy_definition_versions pdv
             on pdv.id=pa.policy_definition_version_id
          where pdv.policy_id='test/actionproof:action_access' and pa.active`,
        )).rows[0];
      const relationshipTable = (await query<{ table_name: string }>(
        harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test'
          and pack_name='actionproof' and definition_kind='relationship'
          and definition_name='source_actor'`,
      )).rows[0].table_name;
      const linked = await harness.runJson(["--json", "changeset", "stage"], {
        project_id: projectId,
        operations: [{
          op: "link",
          key: "actor-link",
          project_id: projectId,
          relationship: "test/actionproof:source_actor",
          from: read.id,
          to: auth.principal_id,
          fields: {},
        }],
      });
      assertEquals(linked.code, 0, linked.stderr);
      const relationshipStage = JSON.parse(linked.stdout).data;
      const relationshipId = relationshipStage.operations[0].relationship_id;
      const relationshipCommit = await harness.runOptctl([
        "--json",
        "changeset",
        "commit",
        relationshipStage.id,
      ]);
      assertEquals(relationshipCommit.code, 0, relationshipCommit.stderr);
      await query(
        harness.server.sql,
        "update role_assignments set role_id='test/actionproof:operator',boundary_type='all_projects' where id=$1",
        [roleAssignment],
      );

      let expectedAttempts = 0;
      const race = async (
        name: string,
        mutate: () => Promise<void>,
        restore: () => Promise<void>,
        expectedCode: "project_conflict" | "policy_denied",
      ) => {
        const token = `race-${name}`;
        provider.enqueue({ kind: "hold", token });
        const beforeStages = await evidenceCounts(harness.server.sql);
        const pending = harness.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ source_id: read.id }),
        ]);
        expectedAttempts++;
        await provider.waitForAttempts(expectedAttempts);
        await mutate();
        provider.release(token);
        const result = await pending;
        try {
          assertEquals(result.code, 1, `${name}: ${result.stderr}`);
          assertEquals(
            JSON.parse(result.stderr).error.code,
            expectedCode,
            name,
          );
          assertEquals(
            await evidenceCounts(harness.server.sql),
            beforeStages,
            `${name} persisted partial evidence`,
          );
          assertEquals(provider.attempts.length, expectedAttempts);
        } finally {
          await restore();
        }
      };

      await race(
        "role-disable",
        () =>
          query(
            harness.server.sql,
            "update role_assignments set active=false where id=$1",
            [roleAssignment],
          ).then(() => undefined),
        () =>
          query(
            harness.server.sql,
            "update role_assignments set active=true where id=$1",
            [roleAssignment],
          ).then(() => undefined),
        "project_conflict",
      );
      await race(
        "policy-assignment-disable",
        () =>
          query(
            harness.server.sql,
            "update policy_assignments set active=false where id=$1",
            [policy.assignment_id],
          ).then(() => undefined),
        () =>
          query(
            harness.server.sql,
            "update policy_assignments set active=true where id=$1",
            [policy.assignment_id],
          ).then(() => undefined),
        "project_conflict",
      );
      await race(
        "policy-version-disable",
        () =>
          query(
            harness.server.sql,
            "update policy_definition_versions set active=false where id=$1",
            [policy.version_id],
          ).then(() => undefined),
        () =>
          query(
            harness.server.sql,
            "update policy_definition_versions set active=true where id=$1",
            [policy.version_id],
          ).then(() => undefined),
        "policy_denied",
      );
      await race(
        "rebac-archive",
        () =>
          query(
            harness.server.sql,
            `update "${relationshipTable}" set archived_at=now() where id=$1`,
            [relationshipId],
          ).then(() => undefined),
        () =>
          query(
            harness.server.sql,
            `update "${relationshipTable}" set archived_at=null where id=$1`,
            [relationshipId],
          ).then(() => undefined),
        "project_conflict",
      );

      const originalVersion = read.object_version_id;
      const replacementVersion = uuidV7();
      await query(
        harness.server.sql,
        `insert into object_versions(id,project_id,definition_kind,resource_identity,
          object_id,version,previous_version_id,changeset_commit_id,operation,
          resource_revision,snapshot_json,changed_fields,auth_context_id)
         select $1,project_id,definition_kind,resource_identity,object_id,version+1,id,
          changeset_commit_id,'update',resource_revision,snapshot_json,'{}'::text[],auth_context_id
         from object_versions where id=$2`,
        [replacementVersion, originalVersion],
      );
      const sourceTable = (await query<{ table_name: string }>(
        harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test'
          and pack_name='actionproof' and definition_kind='resource'
          and definition_name='source'`,
      )).rows[0].table_name;
      await race(
        "required-read-version",
        () =>
          query(
            harness.server.sql,
            `update "${sourceTable}" set version=version+1,current_object_version_id=$1 where id=$2`,
            [replacementVersion, read.id],
          ).then(() => undefined),
        () =>
          query(
            harness.server.sql,
            `update "${sourceTable}" set version=1,current_object_version_id=$1 where id=$2`,
            [originalVersion, read.id],
          ).then(() => undefined),
        "project_conflict",
      );

      const control = async (unrelated = false) => {
        const token = unrelated ? "unrelated" : "unchanged";
        provider.enqueue({ kind: "hold", token });
        const pending = harness.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ source_id: read.id }),
        ]);
        expectedAttempts++;
        await provider.waitForAttempts(expectedAttempts);
        if (unrelated) {
          await query(
            harness.server.sql,
            "insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active) values($1,$2,'test/actionproof:operator','project',$3,true)",
            [uuidV7(), auth.principal_id, unrelatedProjectId],
          );
        }
        provider.release(token);
        const result = await pending;
        assertEquals(result.code, 0, `${token}: ${result.stderr}`);
        assertEquals(provider.attempts.length, expectedAttempts);
        return JSON.parse(result.stdout).data;
      };
      const unchanged = await control();
      const evidence = unchanged.source.identity.authority_evidence;
      assertEquals(evidence.action, "action:test/actionproof:generate");
      assertEquals(evidence.targets, [{
        resource: "test/actionproof:source",
        object_id: read.id,
        object_version_id: originalVersion,
      }]);
      assertEquals(/^sha256:[0-9a-f]{64}$/.test(evidence.policy_digest), true);
      assertEquals(
        /^sha256:[0-9a-f]{64}$/.test(evidence.cutoff.facts_digest),
        true,
      );
      const unrelated = await control(true);
      assertEquals(
        unrelated.source.identity.authority_evidence.policy_digest,
        evidence.policy_digest,
      );
      assertEquals(
        unrelated.source.identity.authority_evidence.cutoff.facts_digest,
        evidence.cutoff.facts_digest,
      );
    } finally {
      await harness.close();
      await provider.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

async function evidenceCounts(sql: Parameters<typeof query>[0]) {
  return (await query<{ stages: string; hooks: string }>(
    sql,
    `select (select count(*)::text from staged_changesets) stages,
            (select count(*)::text from staged_hook_executions) hooks`,
  )).rows[0];
}

async function stageCount(sql: Parameters<typeof query>[0]) {
  return Number(
    (await query<{ count: string }>(
      sql,
      "select count(*)::text count from staged_changesets",
    )).rows[0].count,
  );
}

async function assertStageError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    assertEquals(error.code, code);
  }
}

async function storedDeclaration(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  providerUrl: string,
): Promise<ActionStageHookDeclaration> {
  const row = (await query<{
    attachment_id: string;
    hook_revision_id: string;
    pack_revision_id: string;
    hook_identity: string;
    ordinal: number;
    declaration_digest: string;
    declaration_spec: Record<string, unknown>;
    hook_security_digest: string;
    hook_script_digest: string;
    hook_normalized_config: Record<string, unknown>;
    hook_script_content: string;
  }>(
    harness.server.sql,
    `select attachment.id attachment_id,attachment.hook_revision_id,
            attachment.candidate_revision_id pack_revision_id,attachment.hook_identity,
            attachment.ordinal,attachment.declaration_digest,attachment.declaration_spec,
            component.hook_security_digest,component.hook_script_digest,
            component.hook_normalized_config,component.hook_script_content
       from pack_hook_attachment_revisions attachment
       join pack_component_revisions component on component.id=attachment.hook_revision_id
       join pack_active_revisions active
         on active.candidate_revision_id=attachment.candidate_revision_id
      where attachment.phase='action.stage' and attachment.hook_identity='test/actionproof:generate'`,
  )).rows[0];
  const spec = row.declaration_spec;
  const config = row.hook_normalized_config;
  const permissions = config.permissions as Record<string, unknown>;
  return {
    attachment_id: row.attachment_id,
    hook_revision_id: row.hook_revision_id,
    pack_revision_id: row.pack_revision_id,
    hook: row.hook_identity,
    phase: "action.stage",
    resource: null,
    operation_key: null,
    order: row.ordinal,
    script_digest: row.hook_script_digest,
    security_digest: row.hook_security_digest,
    script_content: row.hook_script_content,
    timeout_ms: Number(config.timeout_ms),
    output_schema: "changeset.operations.v1",
    permissions: {
      net: (permissions.net as string[]) ?? [new URL(providerUrl).host],
      env: [],
    },
    secret_slots: [],
    input_mapping: spec.input as Record<string, unknown>,
    condition: null,
    effects:
      ((config.effects as Record<string, unknown>).operations as unknown[]) ??
        [],
    declaration_digest: row.declaration_digest,
  };
}

export async function seedRead(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  projectId: string,
) {
  const metadata = (await query<{ candidate: string; table_name: string }>(
    harness.server.sql,
    `select active.candidate_revision_id candidate,runtime.table_name
       from pack_active_revisions active join pack_runtime_tables runtime
         on runtime.publisher=active.publisher and runtime.pack_name=active.pack_name
      where active.publisher='test' and active.pack_name='actionproof'
        and runtime.definition_kind='resource' and runtime.definition_name='source'`,
  )).rows[0];
  const auth = (await query<{ id: string }>(
    harness.server.sql,
    "select id from auth_contexts order by created_at desc limit 1",
  )).rows[0].id;
  const stageId = uuidV7(),
    commitId = uuidV7(),
    objectId = uuidV7(),
    versionId = uuidV7();
  const digest = `sha256:${"0".repeat(64)}`;
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json) values($1,1,'seed','{}',$2,(select principal_id from auth_contexts where id=$2),'{}',$3,$3,'{}','[]','[]','[]','[]','[]')`,
      [stageId, auth, digest],
    );
    await query(
      tx,
      "insert into staged_changeset_lifecycle(stage_id,status,version,committed_at) values($1,'committed',1,now())",
      [stageId],
    );
    await query(
      tx,
      "insert into changeset_commits(id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest) values($1,$2,$3,now(),$4)",
      [commitId, stageId, auth, digest],
    );
    await query(
      tx,
      `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id) values($1,$2,'resource','test/actionproof:source',$3,1,$4,'create',$5,$6::jsonb,array['name','status'],$7)`,
      [
        versionId,
        projectId,
        objectId,
        commitId,
        metadata.candidate,
        {
          data: { name: "Pinned Source", status: "ready" },
          archived_at: null,
        },
        auth,
      ],
    );
    await query(
      tx,
      `insert into "${metadata.table_name}"(id,project_id,version,current_object_version_id,created_by,updated_by,name,status) values($1,$2,1,$3,$4,$4,'Pinned Source','ready')`,
      [objectId, projectId, versionId, auth],
    );
  });
  return {
    id: objectId,
    object_version_id: versionId,

    name: "Pinned Source",
    status: "ready",
  };
}

export async function writePack(
  root: string,
  providerUrl: string,
): Promise<void> {
  const endpoint = new URL(providerUrl).host;
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/relationships`);
  await Deno.mkdir(`${root}/roles`);
  await Deno.mkdir(`${root}/policies`);
  await Deno.mkdir(`${root}/actions`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.mkdir(`${root}/seeds`);
  await Deno.mkdir(`${root}/lifecycles`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: actionproof, version: 1.0.0 }\nspec: { purpose: Action stage integration proof., axi: {} }\n`,
  );
  for (const name of ["source", "target"]) {
    await Deno.writeTextFile(
      `${root}/resources/${name}.yaml`,
      `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: ${name} }\nspec:\n  fields:\n    name: { type: string, required: true, unique: true }\n    status: { type: string, required: true }\n    note: { type: string }\n  axi: {}\n`,
    );
  }
  await Deno.writeTextFile(
    `${root}/relationships/source_actor.yaml`,
    `kind: Relationship\napiVersion: operant.dev/v1\nmetadata: { name: source_actor }\nspec:\n  from: { resource: source }\n  to: { resource: system:principal }\n  fields: {}\n  unique: [from, to]\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/roles/operator.yaml`,
    `kind: Role\napiVersion: operant.dev/v1\nmetadata: { name: operator }\nspec:\n  display_name: Action Operator\n  description: Exercises exact targeted action authority.\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/policies/action_access.yaml`,
    `kind: Policy\napiVersion: operant.dev/v1\nmetadata: { name: action_access }\nspec:\n  default_assignment: all_projects\n  rules:\n    - name: action_operator\n      effect: allow\n      roles: [test/actionproof:operator]\n      actions: [read, create, update, action:test/actionproof:generate]\n      resources: [test/actionproof:source, test/actionproof:target]\n      axi: { summary: Action operators may exercise the targeted action fixture. }\n    - name: relationship_operator\n      effect: allow\n      roles: [test/actionproof:operator]\n      actions: [link, unlink]\n      resources: [test/actionproof:source_actor]\n      axi: { summary: Action operators may manage fixture relationships. }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/lifecycles/source_status.yaml`,
    `kind: Lifecycle\napiVersion: operant.dev/v1\nmetadata: { name: source_status }\nspec:\n  resource: source\n  field: status\n  initial: ready\n  states:\n    - { name: ready, terminal: false }\n    - { name: blocked, terminal: true }\n  transitions:\n    - { name: block, from: [ready], to: blocked }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/seeds/targets.yaml`,
    `kind: Seed\napiVersion: operant.dev/v1\nmetadata: { name: targets }\nspec:\n  resource: target\n  key: name\n  mode: changeset\n  rows:\n    - { name: Seeded Target, status: ready }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/seeds/targets_alt.yaml`,
    `kind: Seed\napiVersion: operant.dev/v1\nmetadata: { name: targets_alt }\nspec:\n  resource: target\n  key: name\n  mode: changeset\n  rows:\n    - { name: Alternate Target, status: ready }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/actions/generate.yaml`,
    `kind: Action\napiVersion: operant.dev/v1\nmetadata: { name: generate }\nspec:\n  input:\n    source_id: { type: string, required: true, format: uuid }\n  reads:\n    source:\n      resource: source\n      id_from: '$action.input.source_id'\n      fields: [name, status]\n      required: true\n  availability:\n    resource: source\n    states: [ready]\n    condition: 'status == "ready"'\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/generate.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: generate }\nspec:\n  script: generate.ts\n  timeout: 5s\n  permissions: { net: [${endpoint}], env: false, read: false, write: false, run: false }\n  secrets: []\n  effects:\n    operations:\n      - { resource: test/actionproof:target, ops: [create, update] }\n  output: { schema: changeset.operations.v1 }\n  attachments:\n    - phase: action.stage\n      action: test/actionproof:generate\n      order: 10\n      input: { actor: '$actor', read: '$reads.source', request: '$action.input' }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/generate.ts`,
    `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text()); const read=envelope.input.read; const actor=envelope.input.actor; if (Object.keys(read).sort().join(',')!=="name,status" || read.status!=="ready" || "project_id" in envelope.input.request || JSON.stringify(Object.keys(actor).sort())!==JSON.stringify(["id","principal_type"]) || !/^[0-9a-f-]{36}$/.test(actor.id) || !["human_user","agent_user"].includes(actor.principal_type) || actor.id===envelope.input.request.actor?.id || envelope.authority_snapshot!==undefined || envelope.grant_snapshot!==undefined) throw new Error("uncurated input"); await fetch(${
      JSON.stringify(providerUrl)
    }); console.log(JSON.stringify({operations:[{op:"create",key:"made",resource:"test/actionproof:target",fields:{name:read.name}},{op:"update",resource:"test/actionproof:target",object_id:{$ref:"made.object_id"},set:{status:"converted"}}]}));`,
  );
}
