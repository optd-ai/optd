// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { DenoHookRunner } from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";
import { authoredOperationContract } from "../../src/schemas/changesets/operations.ts";

const projectId = "019b7a2e-7c10-7000-8000-000000000001";
const taskId = "019b7a2e-7c10-7000-8000-000000000002";
const stageId = "019b7a2e-7c10-7000-8000-000000000003";

for (
  const fixture of [
    {
      name: "start_task",
      input: { task_id: taskId, stage_id: stageId },
      effects: new Map([["optd/projects:task", new Set(["transition"])]]),
    },
    {
      name: "block_task",
      input: { task_id: taskId, stage_id: stageId, blocked_reason: "waiting" },
      effects: new Map([["optd/projects:task", new Set(["transition"])]]),
    },
    {
      name: "complete_task",
      input: {
        task_id: taskId,
        stage_id: stageId,
        spent_hours: "1.25",
        entry_date: "2026-07-24",
      },
      effects: new Map([
        ["optd/projects:task", new Set(["transition"])],
        ["optd/projects:timesheet", new Set(["create"])],
      ]),
    },
  ]
) {
  Deno.test(`Projects ${fixture.name} hook emits authored operations within exact effects`, async () => {
    const scriptContent = await Deno.readTextFile(
      `prototypes/project-management-pack/hooks/${fixture.name}.ts`,
    );
    const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
    const result = await runner.run({
      namespace: "optd/projects",
      name: fixture.name,
      revision: "fixture",
      scriptPath: `hooks/${fixture.name}.ts`,
      scriptDigest: `sha256:${"1".repeat(64)}`,
      scriptContent,
      outputSchema: "changeset.operations.v1",
      timeoutMs: 30_000,
      permissions: {},
    }, {
      hook: `optd/projects:${fixture.name}`,
      phase: "action.stage",
      input: {
        action_input: fixture.input,
        task: { version: 1 },
        actor: { id: taskId, principal_type: "human_user" },
      },
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    const operations =
      (result.output as { operations: Record<string, unknown>[] }).operations;
    for (const operation of operations) {
      assertEquals(
        authoredOperationContract.check({
          ...operation,
          project_id: projectId,
        }),
        true,
        JSON.stringify(
          authoredOperationContract.issues({
            ...operation,
            project_id: projectId,
          }),
        ),
      );
      const resource = String(operation.resource);
      assertEquals(
        fixture.effects.get(resource)?.has(String(operation.op)),
        true,
      );
    }
  });
}
