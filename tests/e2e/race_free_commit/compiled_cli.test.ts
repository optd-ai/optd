// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
  type Sql,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

for (const trace of [false, true]) {
  Deno.test({
    name: `forced-fresh CLI commits all seven canonical operations (${
      trace ? "trace" : "default"
    })`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const harness = await startLiveHarness({
        environment: trace ? { OPTD_LOG_LEVEL: "trace" } : {},
      });
      const pack = await Deno.makeTempDir({ prefix: "race-free-pack-" });
      try {
        assertEquals(
          (await harness.bootstrap({
            username: "commit-admin",
            password: "commit acceptance password",
            displayName: "Commit Administrator",
          })).code,
          0,
        );
        await writeCommitPack(pack);
        const applied = await harness.runOptctl([
          "--json",
          "pack",
          "apply",
          pack,
          "--safe",
        ]);
        assertEquals(applied.code, 0, applied.stderr);
        const project = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `commit-proof-${trace ? "trace" : "default"}`,
          "--display-name",
          "Commit Proof",
        ]);
        assertEquals(project.code, 0, project.stderr);
        const projectId = JSON.parse(project.stdout).data.id as string;
        const setup = await stageFile(harness, pack, {
          operations: ["a", "b", "c", "d"].map((key) => ({
            op: "create",
            key,
            project_id: projectId,
            resource: "test/commitproof:item",
            fields: { name: key.toUpperCase(), status: "new" },
          })).concat([{
            op: "link",
            key: "old_link",
            project_id: projectId,
            relationship: "test/commitproof:item_link",
            from: { $ref: "a.object_id" },
            to: { $ref: "b.object_id" },
            fields: { label: "old" },
          }] as never[]),
        });
        const setupCommit = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          setup.id,
        ]);
        assertEquals(setupCommit.code, 0, setupCommit.stderr);
        const operation = (key: string) =>
          setup.operations.find((candidate: { key: string }) =>
            candidate.key === key
          );
        const a = operation("a").object_id;
        const b = operation("b").object_id;
        const c = operation("c").object_id;
        const d = operation("d").object_id;
        const oldLink = operation("old_link").relationship_id;
        const staged = await stageFile(harness, pack, {
          operations: [{
            op: "create",
            key: "e",
            project_id: projectId,
            resource: "test/commitproof:item",
            fields: { name: "E", status: "new" },
          }, {
            op: "update",
            project_id: projectId,
            resource: "test/commitproof:item",
            object_id: a,
            set: { note: "updated" },
          }, {
            op: "transition",
            project_id: projectId,
            resource: "test/commitproof:item",
            object_id: b,
            to: "active",
          }, {
            op: "archive",
            project_id: projectId,
            resource: "test/commitproof:item",
            object_id: c,
          }, {
            op: "link",
            key: "new_link",
            project_id: projectId,
            relationship: "test/commitproof:item_link",
            from: d,
            to: { $ref: "e.object_id" },
            fields: { label: "new" },
          }, {
            op: "unlink",
            project_id: projectId,
            relationship: "test/commitproof:item_link",
            relationship_id: oldLink,
          }, {
            op: "comment",
            key: "created_comment",
            project_id: projectId,
            resource: "test/commitproof:item",
            object_id: { $ref: "e.object_id" },
            body: "created in this graph",
          }],
        });
        assertEquals(staged.operations.map((item: { op: string }) => item.op), [
          "create",
          "update",
          "transition",
          "archive",
          "link",
          "unlink",
          "comment",
        ]);
        const commit = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          staged.id,
        ]);
        assertEquals(commit.code, 0, commit.stderr);
        const commitDto = JSON.parse(commit.stdout).data;
        const repeat = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          staged.id,
        ]);
        assertEquals(repeat.code, 0, repeat.stderr);
        assertEquals(JSON.parse(repeat.stdout).data, commitDto);
        const inspect = await harness.runOptctl([
          "--json",
          "changeset",
          "inspect",
          staged.id,
        ]);
        assertEquals(inspect.code, 0, inspect.stderr);
        assertEquals(JSON.parse(inspect.stdout).data.commit.id, commitDto.id);
        const e = staged.operations[0].object_id;
        const view = await harness.runOptctl([
          "--json",
          "--project",
          projectId,
          "view",
          "test/commitproof:item",
          e,
        ]);
        assertEquals(view.code, 0, view.stderr);
        assertEquals(JSON.parse(view.stdout).data.version, 1);
        const history = await harness.runOptctl([
          "--json",
          "--project",
          projectId,
          "history",
          "test/commitproof:item",
          e,
        ]);
        assertEquals(history.code, 0, history.stderr);
        assertEquals(
          JSON.parse(history.stdout).data.items.map((item: { kind: string }) =>
            item.kind
          ).sort(),
          ["comment", "object_version"],
        );
        const facts = (await query<{
          operation: string;
          object_id: string;
          version: number;
        }>(
          harness.server.sql,
          `select operation,object_id,version from object_versions
           where changeset_commit_id=$1 order by created_at,id`,
          [commitDto.id],
        )).rows;
        assertEquals(facts.length, 6);
        assertEquals(facts.map((fact) => fact.operation).sort(), [
          "archive",
          "create",
          "link",
          "transition",
          "unlink",
          "update",
        ]);
        const createdVersion = facts.find((fact) =>
          fact.object_id === e
        )!.version;
        assertEquals(Number(createdVersion), 1);
        const comment = (await query<{
          target_object_version_id: string;
          version_id: string;
          version: number;
        }>(
          harness.server.sql,
          `select comment.target_object_version_id,version.id version_id,version.version
           from comments comment join object_versions version
             on version.id=comment.target_object_version_id
           where comment.changeset_commit_id=$1`,
          [commitDto.id],
        )).rows[0];
        assertEquals(comment.target_object_version_id, comment.version_id);
        assertEquals(Number(comment.version), 1);
        const eventTypes =
          (await query<{ event_type: string; schema_version: number }>(
            harness.server.sql,
            "select event_type,schema_version from events where changeset_commit_id=$1 order by event_type",
            [commitDto.id],
          )).rows;
        assertEquals(eventTypes.length, 8);
        assertEquals(
          eventTypes.every((event) => Number(event.schema_version) === 1),
          true,
        );
        assertEquals(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from audit_events where changeset_commit_id=$1",
            [commitDto.id],
          )).rows[0].count,
          "8",
        );

        const runtimeTable = (await query<{ table_name: string }>(
          harness.server.sql,
          `select table_name from pack_runtime_tables where publisher='test'
           and pack_name='commitproof' and definition_kind='resource' and definition_name='item'`,
        )).rows[0].table_name;
        for (const point of ["object_versions", "audit_events"] as const) {
          const failureStage = await stageFile(harness, pack, {
            operations: [{
              op: "create",
              project_id: projectId,
              resource: "test/commitproof:item",
              fields: { name: `failure-${point}-${trace}`, status: "new" },
            }],
          });
          const failedObjectId = failureStage.operations[0].object_id;
          await installFailureTrigger(harness.server.sql, point);
          const failed = await harness.runOptctl([
            "--json",
            "changeset",
            "commit",
            failureStage.id,
          ]);
          assertEquals(failed.code, 1);
          assertEquals(JSON.parse(failed.stderr).error.code, "internal_error");
          await removeFailureTrigger(harness.server.sql, point);
          assertEquals(
            (await query<{ count: string }>(
              harness.server.sql,
              `select count(*)::text count from ${
                quoteIdentifier(runtimeTable)
              } where id=$1`,
              [failedObjectId],
            )).rows[0].count,
            "0",
          );
          assertEquals(
            (await query<{ count: string }>(
              harness.server.sql,
              "select count(*)::text count from changeset_commits where stage_id=$1",
              [failureStage.id],
            )).rows[0].count,
            "0",
          );
        }
        const commentFailureStage = await stageFile(harness, pack, {
          operations: [{
            op: "comment",
            project_id: projectId,
            resource: "test/commitproof:item",
            object_id: e,
            body: "must roll back",
          }],
        });
        const commentsBefore = (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from comments where object_id=$1",
          [e],
        )).rows[0].count;
        await installFailureTrigger(
          harness.server.sql,
          "events",
          "comment.added",
        );
        const failedComment = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          commentFailureStage.id,
        ]);
        assertEquals(failedComment.code, 1);
        await removeFailureTrigger(harness.server.sql, "events");
        assertEquals(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from comments where object_id=$1",
            [e],
          )).rows[0].count,
          commentsBefore,
        );
      } finally {
        await harness.close();
        await Deno.remove(pack, { recursive: true }).catch(() => undefined);
      }
    },
  });
}

async function installFailureTrigger(
  sql: Sql,
  table: "object_versions" | "audit_events" | "events",
  eventType?: string,
) {
  await query(
    sql,
    `create function test_commit_failure_point() returns trigger language plpgsql as $$
     begin
       ${eventType ? `if new.event_type=${sqlString(eventType)} then` : ""}
       raise exception 'injected commit failure';
       ${eventType ? "end if;" : ""}
       return new;
     end $$`,
  );
  await query(
    sql,
    `create trigger test_commit_failure_point before insert on ${
      quoteIdentifier(table)
    }
     for each row execute function test_commit_failure_point()`,
  );
}
async function removeFailureTrigger(
  sql: Sql,
  table: "object_versions" | "audit_events" | "events",
) {
  await query(
    sql,
    `drop trigger test_commit_failure_point on ${quoteIdentifier(table)}`,
  );
  await query(sql, "drop function test_commit_failure_point()");
}
function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function stageFile(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  root: string,
  body: unknown,
) {
  const file = `${root}/stage-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(file, JSON.stringify(body));
  const result = await harness.runOptctl([
    "--json",
    "changeset",
    "stage",
    file,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data;
}

async function writeCommitPack(root: string) {
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/relationships`);
  await Deno.mkdir(`${root}/lifecycles`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: optd.dev/v1\nmetadata: { publisher: test, name: commitproof, version: 1.0.0 }\nspec: { purpose: Canonical commit acceptance., axi: {} }\n`,
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    `kind: Resource\napiVersion: optd.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    name: { type: string, required: true, unique: true }\n    status: { type: string, required: true }\n    note: { type: string }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/relationships/item_link.yaml`,
    `kind: Relationship\napiVersion: optd.dev/v1\nmetadata: { name: item_link }\nspec:\n  from: { resource: item }\n  to: { resource: item }\n  fields:\n    label: { type: string }\n  unique: [from, to]\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/lifecycles/item_status.yaml`,
    `kind: Lifecycle\napiVersion: optd.dev/v1\nmetadata: { name: item_status }\nspec:\n  resource: item\n  field: status\n  initial: new\n  states:\n    - { name: new, terminal: false }\n    - { name: active, terminal: false }\n  transitions:\n    - name: activate\n      from: [new]\n      to: active\n      set: { note: transitioned }\n  axi: {}\n`,
  );
}
