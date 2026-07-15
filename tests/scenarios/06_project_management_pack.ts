import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("project-management pack executes generic project/task workflow", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP project-management scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "operant-project-pack-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    const apply = await runOptctl([
      "--server",
      server.url,
      "pack",
      "apply",
      "tests/fixtures/packs/project-management-pack",
      "--json",
    ]);
    assertEquals(apply.code, 0, apply.stderr);
    const applyJson = JSON.parse(apply.stdout);
    assertEquals(
      applyJson.data.summary.resources.includes("default.task"),
      true,
    );
    assertEquals(
      applyJson.data.summary.actions.includes("default.start_task"),
      true,
    );
    assertEquals(applyJson.data.seeds.planned, 8);

    const metadata = await runOptctl([
      "--server",
      server.url,
      "metadata",
      "resource",
      "default.task",
      "--json",
    ]);
    assertEquals(metadata.code, 0, metadata.stderr);
    const metadataJson = JSON.parse(metadata.stdout);
    assertEquals(metadataJson.data.name, "default.task");
    assert(metadataJson.data.spec.fields.project_id);
    assertStringIncludes(
      JSON.stringify(metadataJson.data.spec.axi),
      "start_task",
    );

    const tempDir = await Deno.makeTempDir({ prefix: "operant-project-json-" });
    const projectId = `project_${crypto.randomUUID()}`;
    const taskId = `task_${crypto.randomUUID()}`;
    const createPath = `${tempDir}/create_project_task.json`;
    await Deno.writeTextFile(
      createPath,
      JSON.stringify({
        actor_context: { id: "manager", roles: ["project_manager"] },
        operations: [
          {
            op: "create",
            resource: "default.project",
            fields: {
              id: projectId,
              name: "Agent Platform MVP",
              description: "Generic project-management fixture",
              status: "active",
              owner_id: "manager",
              visibility: "members",
              start_date: "2026-07-09",
              target_date: "2026-08-01",
            },
          },
          {
            op: "create",
            resource: "default.task",
            fields: {
              id: taskId,
              title: "Prove project pack genericity",
              description: "Run a non-CRM workflow through the same engine",
              project_id: projectId,
              stage_id: "todo",
              state: "todo",
              assignee_id: "alice",
              priority: "high",
              estimated_hours: 4,
            },
          },
          {
            op: "link",
            relationship: "default.project_task",
            from: projectId,
            to: taskId,
            fields: { role: "primary" },
          },
        ],
      }),
    );
    const create = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);
    const createJson = JSON.parse(create.stdout);
    assertEquals(createJson.data.committed, true);

    const assigneeActor = JSON.stringify({
      id: "alice",
      roles: ["project_member"],
      project_ids: [projectId],
      task_ids: [taskId],
    });

    const start = await runOptctl([
      "--server",
      server.url,
      "action",
      "commit",
      "default.start_task",
      "--input",
      JSON.stringify({ task_id: taskId, stage_id: "in_progress" }),
      "--actor",
      assigneeActor,
      "--json",
    ]);
    assertEquals(start.code, 0, start.stderr);
    assertEquals(JSON.parse(start.stdout).data.changeset.committed, true);

    const block = await runOptctl([
      "--server",
      server.url,
      "action",
      "commit",
      "default.block_task",
      "--input",
      JSON.stringify({
        task_id: taskId,
        stage_id: "blocked",
        blocked_reason: "Waiting for reviewer",
      }),
      "--actor",
      assigneeActor,
      "--json",
    ]);
    assertEquals(block.code, 0, block.stderr);

    const unblock = await runOptctl([
      "--server",
      server.url,
      "action",
      "commit",
      "default.start_task",
      "--input",
      JSON.stringify({ task_id: taskId, stage_id: "in_progress" }),
      "--actor",
      assigneeActor,
      "--json",
    ]);
    assertEquals(unblock.code, 0, unblock.stderr);

    const complete = await runOptctl([
      "--server",
      server.url,
      "action",
      "commit",
      "default.complete_task",
      "--input",
      JSON.stringify({ task_id: taskId, stage_id: "done", spent_hours: 2.5 }),
      "--actor",
      assigneeActor,
      "--json",
    ]);
    assertEquals(complete.code, 0, complete.stderr);

    const timesheetPath = `${tempDir}/timesheet.json`;
    await Deno.writeTextFile(
      timesheetPath,
      JSON.stringify({
        actor_context: JSON.parse(assigneeActor),
        operations: [{
          op: "create",
          resource: "default.timesheet_entry",
          fields: {
            id: `time_${crypto.randomUUID()}`,
            task_id: taskId,
            actor_id: "alice",
            hours: 2.5,
            description: "Implementation and validation",
            entry_date: "2026-07-09",
          },
        }],
      }),
    );
    const timesheet = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      timesheetPath,
      "--json",
    ]);
    assertEquals(timesheet.code, 0, timesheet.stderr);

    const deniedPath = `${tempDir}/denied.json`;
    await Deno.writeTextFile(
      deniedPath,
      JSON.stringify({
        actor_context: {
          id: "mallory",
          roles: ["project_member"],
          project_ids: [],
          task_ids: [],
        },
        operations: [{
          op: "update",
          resource: "default.task",
          id: taskId,
          fields: { priority: "urgent" },
        }],
      }),
    );
    const denied = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      deniedPath,
      "--json",
    ]);
    assertEquals(denied.code, 1);
    assertStringIncludes(denied.stderr, "policy_denied");

    const tasks = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.task",
      "--where",
      `project_id == \"${projectId}\"`,
      "--fields",
      "id,title,state,assignee_id,spent_hours",
      "--sort",
      "id:asc",
      "--limit",
      "1",
      "--actor",
      assigneeActor,
      "--json",
    ]);
    assertEquals(tasks.code, 0, tasks.stderr);
    const tasksJson = JSON.parse(tasks.stdout);
    assertEquals(tasksJson.data.items.length, 1);
    assertEquals(tasksJson.data.items[0].id, taskId);
    assertEquals(tasksJson.data.items[0].state, "done");

    const history = await runOptctl([
      "--server",
      server.url,
      "history",
      "default.task",
      taskId,
      "--json",
    ]);
    assertEquals(history.code, 0, history.stderr);
    const historyJson = JSON.parse(history.stdout);
    assert(historyJson.data.versions.length >= 5);
    assert(
      historyJson.data.versions.some((v: Record<string, unknown>) => {
        const snapshot = typeof v.snapshot_json === "string"
          ? JSON.parse(v.snapshot_json)
          : v.snapshot_json as Record<string, unknown>;
        return snapshot.state === "blocked";
      }),
    );

    const drain = await runOptctl([
      "--server",
      server.url,
      "outbox",
      "drain",
      "--json",
    ]);
    assertEquals(drain.code, 0, drain.stderr);
    const drainJson = JSON.parse(drain.stdout);
    assert(drainJson.data.succeeded >= 1);

    const hookRows = await query<{ count: string }>(
      server.sql,
      "select count(*)::text as count from hook_executions where hook='default.notify_project_change' and phase='event.after_commit' and status='succeeded'",
    );
    assert(Number(hookRows.rows[0]?.count ?? 0) >= 1);

    const crmAssumptions = await grepSourceForCrmAssumptions();
    assertEquals(crmAssumptions, []);
  } finally {
    await server?.shutdown();
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

async function grepSourceForCrmAssumptions(): Promise<string[]> {
  const matches: string[] = [];
  const crmTerms =
    /readActionLead|leadId|default\.lead|notify_crm_change|convert_lead/;
  for await (const entry of Deno.readDir("src")) {
    if (!entry.isDirectory) continue;
  }
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.isFile && path.endsWith(".ts")) {
        const text = await Deno.readTextFile(path);
        if (crmTerms.test(text)) matches.push(path);
      }
    }
  }
  await walk("src");
  return matches;
}
