import {
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert@1";
import { join } from "jsr:@std/path";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

Deno.test({
  name:
    "fresh compiled CLI stages, inspects, duplicates, and cancels immutable evidence",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startLiveHarness();
    try {
      assertEquals(
        (await harness.bootstrap({
          username: "owner",
          password: "Correct-horse-battery-1!",
        })).code,
        0,
      );
      const projectResult = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "alpha",
        "--display-name",
        "Alpha",
      ]);
      assertEquals(projectResult.code, 0, projectResult.stderr);
      const projectId = JSON.parse(projectResult.stdout).data.id;
      const betaResult = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "beta",
        "--display-name",
        "Beta",
      ]);
      assertEquals(betaResult.code, 0, betaResult.stderr);
      const betaProjectId = JSON.parse(betaResult.stdout).data.id;
      const pack = join(harness.rootDir, "strict-pack");
      await Deno.mkdir(join(pack, "resources"), { recursive: true });
      await Deno.mkdir(join(pack, "relationships"), { recursive: true });
      await Deno.mkdir(join(pack, "lifecycles"), { recursive: true });
      await Deno.writeTextFile(
        join(pack, "pack.yaml"),
        JSON.stringify({
          kind: "Pack",
          apiVersion: "operant.dev/v1",
          metadata: { publisher: "testpub", name: "strict", version: "1.0.0" },
          spec: { purpose: "Immutable staging acceptance pack", axi: {} },
        }),
      );
      await Deno.writeTextFile(
        join(pack, "resources", "item.yaml"),
        JSON.stringify({
          kind: "Resource",
          apiVersion: "operant.dev/v1",
          metadata: { name: "item" },
          spec: {
            fields: {
              name: { type: "string", required: true },
              state: { type: "string", required: true },
              score: { type: "integer" },
            },
            axi: {},
          },
        }),
      );
      await Deno.writeTextFile(
        join(pack, "relationships", "item_link.yaml"),
        JSON.stringify({
          kind: "Relationship",
          apiVersion: "operant.dev/v1",
          metadata: { name: "item_link" },
          spec: {
            from: { resource: "testpub/strict:item" },
            to: { resource: "testpub/strict:item" },
            fields: { label: { type: "string" } },
            axi: {},
          },
        }),
      );
      await Deno.writeTextFile(
        join(pack, "lifecycles", "item_lifecycle.yaml"),
        JSON.stringify({
          kind: "Lifecycle",
          apiVersion: "operant.dev/v1",
          metadata: { name: "item_lifecycle" },
          spec: {
            resource: "testpub/strict:item",
            field: "state",
            initial: "new",
            states: [{ name: "new" }, { name: "done", terminal: true }],
            transitions: [{ name: "finish", from: ["new"], to: "done" }],
            axi: {},
          },
        }),
      );
      const apply = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(apply.code, 0, apply.stderr);
      const facts = await seedCurrentFacts(harness, projectId, betaProjectId);
      const prerequisiteStageCount = Number(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
      );
      const request = {
        operations: [{
          project_id: projectId,
          op: "create",
          key: "item",
          resource: "testpub/strict:item",
          fields: { name: "A", state: "new" },
        }, {
          op: "update",
          project_id: projectId,
          resource: "testpub/strict:item",
          object_id: { $ref: "item.object_id" },
          set: { score: 2 },
        }, {
          op: "comment",
          project_id: projectId,
          resource: "testpub/strict:item",
          object_id: { $ref: "item.object_id" },
          body: "staged",
        }, {
          op: "transition",
          project_id: projectId,
          resource: "testpub/strict:item",
          object_id: facts.transitionId,
          expected_version: 1,
          to: "done",
        }, {
          op: "archive",
          project_id: projectId,
          resource: "testpub/strict:item",
          object_id: facts.archiveId,
          expected_version: 1,
        }, {
          op: "link",
          project_id: betaProjectId,
          relationship: "testpub/strict:item_link",
          from: facts.betaFromId,
          to: facts.betaToId,
          fields: { label: "peer" },
        }, {
          op: "unlink",
          project_id: betaProjectId,
          relationship: "testpub/strict:item_link",
          relationship_id: facts.relationshipId,
          expected_version: 1,
        }],
      };
      const first = await harness.runJson(
        ["--json", "changeset", "stage"],
        request,
      );
      if (first.code !== 0) console.log(await harness.diagnostics());
      assertEquals(first.code, 0, first.stderr);
      const firstEnvelope = JSON.parse(first.stdout);
      const firstData = firstEnvelope.data ?? firstEnvelope;
      if (!firstData.id) throw new Error(first.stdout);
      const inspect = await harness.runOptctl([
        "--json",
        "changeset",
        "inspect",
        firstData.id,
      ]);
      assertEquals(inspect.code, 0, inspect.stderr);
      assertEquals(JSON.parse(inspect.stdout).data, firstData);
      const second = await harness.runJson(
        ["--json", "changeset", "stage"],
        request,
      );
      assertEquals(second.code, 0, second.stderr);
      const secondData = JSON.parse(second.stdout).data;
      assertNotEquals(secondData.id, firstData.id);
      assertEquals(
        secondData.operation_graph_digest,
        firstData.operation_graph_digest,
      );
      assertEquals(secondData.stage_digest, firstData.stage_digest);
      const cancellations = await harness.runConcurrent([{
        args: [
          "--json",
          "changeset",
          "cancel",
          firstData.id,
          "--reason",
          "abandoned",
        ],
      }, {
        args: ["--json", "changeset", "cancel", firstData.id],
      }]);
      assertEquals(cancellations.map((item) => item.code), [0, 0]);
      for (const cancellation of cancellations) {
        assertEquals(JSON.parse(cancellation.stdout).data.status, "cancelled");
        assertEquals(JSON.parse(cancellation.stdout).data.lifecycle_version, 2);
      }
      const counts = await query<{ roots: string; operations: string }>(
        harness.server.sql,
        "select (select count(*) from staged_changesets)::text roots,(select count(*) from staged_changeset_operations)::text operations",
      );
      assertEquals(Number(counts.rows[0].roots), prerequisiteStageCount + 2);
      assertEquals(Number(counts.rows[0].operations) > 0, true);
      await assertRejects(() =>
        query(
          harness.server.sql,
          "update staged_changesets set warnings_json='[]' where id=$1",
          [firstData.id],
        )
      );
      for (const removed of ["preview", "commit", "stage-and-commit"]) {
        const result = await harness.runOptctl([
          "--json",
          "changeset",
          removed,
          firstData.id,
        ]);
        assertEquals(result.code, 2);
      }
      const beforeInvalid = (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from staged_changesets",
      )).rows[0].count;
      for (
        const invalid of [
          {
            project_id: projectId,
            idempotency_key: "x",
            operations: request.operations,
          },
          {
            project_id: projectId,
            operations: [{
              op: "create",
              resource: "testpub/strict:item",
              object_id: uuidV7(),
              fields: { name: "x", state: "new" },
            }],
          },
          {
            project_id: projectId,
            operations: [{
              op: "create",
              resource: "testpub/strict:item",
              fields: { name: "x", state: "new" },
              actor_id: uuidV7(),
            }],
          },
          {
            project_id: projectId,
            operations: [{
              op: "update",
              resource: "testpub/strict:item",
              object_id: facts.transitionId,
              expectedVersion: 1,
              set: { score: 3 },
            }],
          },
        ]
      ) {
        const rejected = await harness.runJson(
          ["--json", "changeset", "stage"],
          invalid,
        );
        assertEquals(rejected.code, 1);
        assertEquals(
          JSON.parse(rejected.stderr).error.code,
          "validation_failed",
        );
      }
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        beforeInvalid,
      );
      const auth = (await query<{ id: string }>(
        harness.server.sql,
        "select id from auth_contexts order by created_at desc limit 1",
      )).rows[0].id;
      const injectedId = uuidV7();
      await assertRejects(() =>
        harness.server.sql.begin(async (tx) => {
          await query(
            tx,
            `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json)
             values($1,1,'direct',$2::jsonb,$3,$2::jsonb,$4,$4,$2::jsonb,'[]','[]','[]','[]','[]')`,
            [injectedId, {}, auth, `sha256:${"0".repeat(64)}`],
          );
          await query(
            tx,
            "insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'invalid',1)",
            [injectedId],
          );
        })
      );
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets where id=$1",
          [injectedId],
        )).rows[0].count,
        "0",
      );
      await Deno.mkdir(join(pack, "hooks"), { recursive: true });
      await Deno.writeTextFile(
        join(pack, "hooks", "guard.yaml"),
        JSON.stringify({
          kind: "Hook",
          apiVersion: "operant.dev/v1",
          metadata: { name: "guard" },
          spec: {
            script: "guard.ts",
            permissions: {
              net: false,
              env: false,
              read: false,
              write: false,
              run: false,
            },
            secrets: [],
            effects: { operations: [] },
            output: { schema: "validation.v1" },
            attachments: [{
              phase: "changeset.validate",
              resource: "testpub/strict:item",
              input: {},
            }],
            axi: {},
          },
        }),
      );
      await Deno.writeTextFile(
        join(pack, "hooks", "guard.ts"),
        "export default () => ({warnings: [], errors: []});\n",
      );
      const packRoot = JSON.parse(
        await Deno.readTextFile(join(pack, "pack.yaml")),
      );
      packRoot.metadata.version = "1.0.1";
      await Deno.writeTextFile(
        join(pack, "pack.yaml"),
        JSON.stringify(packRoot),
      );
      const hookApply = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(hookApply.code, 0, hookApply.stderr);
      const beforeHookFailure = (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from staged_changesets",
      )).rows[0].count;
      const hookFailure = await harness.runJson([
        "--json",
        "changeset",
        "stage",
      ], {
        project_id: projectId,
        operations: [{
          op: "create",
          resource: "testpub/strict:item",
          fields: { name: "blocked", state: "new" },
        }],
      });
      assertEquals(hookFailure.code, 1);
      assertEquals(
        JSON.parse(hookFailure.stderr).error.code,
        "hook_coordinator_unavailable",
      );
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        beforeHookFailure,
      );
    } finally {
      await harness.close();
    }
  },
});

async function seedCurrentFacts(
  harness: LiveHarness,
  alpha: string,
  beta: string,
) {
  const metadata = (await query<{
    revision_id: string;
    resource_table: string;
    relationship_table: string;
    auth_context_id: string;
  }>(
    harness.server.sql,
    `select ar.candidate_revision_id revision_id,
      (select table_name from pack_runtime_tables where publisher='testpub' and pack_name='strict' and definition_kind='resource' and definition_name='item') resource_table,
      (select table_name from pack_runtime_tables where publisher='testpub' and pack_name='strict' and definition_kind='relationship' and definition_name='item_link') relationship_table,
      (select id from auth_contexts order by created_at desc limit 1) auth_context_id
     from pack_active_revisions ar where publisher='testpub' and pack_name='strict'`,
  )).rows[0];
  const ids = {
    transitionId: uuidV7(),
    archiveId: uuidV7(),
    betaFromId: uuidV7(),
    betaToId: uuidV7(),
    relationshipId: uuidV7(),
  };
  const objects = [
    [alpha, ids.transitionId, "Transition"],
    [alpha, ids.archiveId, "Archive"],
    [beta, ids.betaFromId, "From"],
    [beta, ids.betaToId, "To"],
  ] as const;
  for (const [project, objectId, name] of objects) {
    const commitId = await prerequisiteCommit(
        harness,
        metadata.auth_context_id,
      ),
      versionId = uuidV7();
    await query(
      harness.server.sql,
      `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id)
       values($1,$2,'resource','testpub/strict:item',$3,1,$4,'create',$5,$6::jsonb,array['name','state'],$7)`,
      [versionId, project, objectId, commitId, metadata.revision_id, {
        data: { name, state: "new" },
        archived_at: null,
      }, metadata.auth_context_id],
    );
    await query(
      harness.server.sql,
      `insert into ${
        quoteIdentifier(metadata.resource_table)
      }(id,project_id,version,current_object_version_id,created_by,updated_by,name,state,score) values($1,$2,1,$3,$5,$5,$4,'new',null)`,
      [objectId, project, versionId, name, metadata.auth_context_id],
    );
  }
  const relationshipVersion = uuidV7(),
    relationshipCommit = await prerequisiteCommit(
      harness,
      metadata.auth_context_id,
    );
  await query(
    harness.server.sql,
    `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id)
     values($1,$2,'relationship','testpub/strict:item_link',$3,1,$4,'link',$5,$6::jsonb,array['label'],$7)`,
    [
      relationshipVersion,
      beta,
      ids.relationshipId,
      relationshipCommit,
      metadata.revision_id,
      {
        from: ids.betaFromId,
        to: ids.betaToId,
        fields: { label: "old" },
        archived_at: null,
      },
      metadata.auth_context_id,
    ],
  );
  await query(
    harness.server.sql,
    `insert into ${
      quoteIdentifier(metadata.relationship_table)
    }(id,project_id,version,current_object_version_id,created_by,updated_by,from_object_id,to_object_id,label) values($1,$2,1,$3,$6,$6,$4,$5,'old')`,
    [
      ids.relationshipId,
      beta,
      relationshipVersion,
      ids.betaFromId,
      ids.betaToId,
      metadata.auth_context_id,
    ],
  );
  return ids;
}

async function prerequisiteCommit(harness: LiveHarness, authContextId: string) {
  const stageId = uuidV7(), commitId = uuidV7();
  const digest = `sha256:${"0".repeat(64)}`;
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json)
       values($1,1,'seed',$2::jsonb,$3,$2::jsonb,$4,$4,$5::jsonb,'[]','[]','[]','[]','[]')`,
      [stageId, {}, authContextId, digest, {
        schema: "changeset.operations.v1",
        operations: [],
      }],
    );
    await query(
      tx,
      "insert into staged_changeset_lifecycle(stage_id,status,version,committed_at) values($1,'committed',1,now())",
      [stageId],
    );
    await query(
      tx,
      `insert into changeset_commits(id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest) values($1,$2,$3,now(),$4)`,
      [commitId, stageId, authContextId, digest],
    );
  });
  return commitId;
}
