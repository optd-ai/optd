import { assert, assertEquals } from "@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("Projects administrator initializes seeds, resolves its boundary, lists IDs and imports without super-admin", async () => {
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "onboarding-admin",
      password: "onboarding-admin-password",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    async function cli(args: string[]) {
      const result = await harness.runOptctl(["--json", ...args]);
      assertEquals(result.code, 0, result.stderr);
      return JSON.parse(result.stdout).data;
    }
    await cli([
      "pack",
      "apply",
      "prototypes/project-management-pack",
      "--safe",
    ]);
    const workspace = await cli([
      "workspace",
      "create",
      "onboarding",
      "--display-name",
      "Onboarding",
    ]);
    const identity = await cli(["auth", "whoami"]);
    const principalId = identity.principal.id;
    await query(
      harness.server.sql,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,workspace_id,active) values($1,$2,'optd/projects:projects_admin','workspace',$3,true)",
      [uuidV7(), principalId, workspace.id],
    );
    await query(
      harness.server.sql,
      "update role_assignments set active=false where principal_id=$1 and role_id='system:super_admin'",
      [principalId],
    );
    await cli(["context", "set-workspace", "onboarding"]);
    const metadata = await cli([
      "metadata",
      "seed",
      "optd/projects:task_stages",
    ]);
    assertEquals(metadata.rows.length, 4);
    assertEquals(metadata.resource, "optd/projects:task_stage");
    await cli([
      "--workspace",
      workspace.id,
      "seed",
      "commit",
      "optd/projects",
      "--all",
    ]);
    const repeated = await cli([
      "--workspace",
      workspace.id,
      "seed",
      "commit",
      "optd/projects",
      "--all",
    ]);
    assertEquals(repeated.status, "unchanged");
    const stages = await cli([
      "--workspace",
      workspace.id,
      "list",
      "optd/projects:task_stage",
    ]);
    assertEquals(stages.items.length, 4);
    assert(
      stages.items.every((row: { id: string; data: { id: string } }) =>
        row.id === row.data.id
      ),
    );
    const tags = await cli([
      "--workspace",
      workspace.id,
      "list",
      "optd/projects:task_tag",
    ]);
    assertEquals(tags.items.length, 4);
    const work = await cli([
      "--workspace",
      workspace.id,
      "create",
      "optd/projects:project",
      "--input",
      JSON.stringify({
        name: "Historical work",
        status: "active",
        owner_id: principalId,
        visibility: "members",
      }),
    ]);
    const done = stages.items.find((row: { data: { state: string } }) =>
      row.data.state === "done"
    ).id;
    const taskInput = JSON.stringify({
      title: "Completed before onboarding",
      project_id: work.created.op_000001,
      stage_id: done,
      assignee_id: principalId,
    });
    const imported = await cli([
      "--workspace",
      workspace.id,
      "create",
      "optd/projects:task",
      "--input",
      taskInput,
      "--initial-state",
      "done",
      "--reason",
      "Historical migration",
    ]);
    const task = await cli([
      "--workspace",
      workspace.id,
      "view",
      "optd/projects:task",
      imported.created.op_000001,
    ]);
    assertEquals(task.data.state, "done");
    await query(
      harness.server.sql,
      "update role_assignments set role_id='optd/projects:project_manager' where principal_id=$1 and role_id='optd/projects:projects_admin'",
      [principalId],
    );
    const denied = await harness.runOptctl([
      "--json",
      "--workspace",
      workspace.id,
      "create",
      "optd/projects:task",
      "--input",
      taskInput,
      "--initial-state",
      "done",
      "--reason",
      "Not an administrator",
    ]);
    assertEquals(denied.code, 1);
    assertEquals(JSON.parse(denied.stderr).error.code, "policy_denied");
  } finally {
    await harness.close();
  }
});
