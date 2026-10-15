import { assertEquals } from "@std/assert";
import { DenoHookRunner } from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";

const principalId = "019b7a2e-7c10-7000-8000-000000000001";

for (const principalType of ["human_user", "agent_user"]) {
  for (const from of ["in_progress", "blocked"]) {
    Deno.test(`Projects ${principalType} completes own ${from} task without approval`, async () => {
      const result = await validate({
        actor: { id: principalId, principal_type: principalType },
        operation: {
          op: "transition",
          resource: "optd/projects:task",
          to: "done",
        },
        current: { title: "My task", state: from, assignee_id: principalId },
        proposed: {
          title: "My task",
          state: "done",
          assignee_id: principalId,
          blocked_reason: "",
        },
      });
      assertEquals(result, {
        allow: true,
        errors: [],
        warnings: [],
        required_approvals: [],
      });
    });
  }
}

for (
  const fixture of [
    {
      name: "illegal lifecycle edge",
      resource: "optd/projects:task",
      current: { state: "todo" },
      proposed: { title: "My task", state: "done" },
      code: "invalid_transition",
    },
    {
      name: "unresolved blocked reason",
      resource: "optd/projects:task",
      current: { state: "blocked" },
      proposed: { title: "My task", state: "done", blocked_reason: "waiting" },
      code: "blocked_reason_unresolved",
    },
    {
      name: "missing title",
      resource: "optd/projects:task",
      current: { state: "in_progress" },
      proposed: { title: "", state: "done" },
      code: "required",
    },
    {
      name: "invalid timesheet hours",
      resource: "optd/projects:timesheet",
      current: null,
      proposed: { hours: "0" },
      code: "invalid_hours",
    },
  ]
) {
  Deno.test(`Projects completion still rejects ${fixture.name}`, async () => {
    const result = await validate({
      operation: { resource: fixture.resource },
      current: fixture.current,
      proposed: fixture.proposed,
    });
    assertEquals(result.allow, false);
    assertEquals(result.errors.map((error) => error.code), [fixture.code]);
    assertEquals(result.required_approvals, []);
  });
}

for (const state of ["todo", "done", "blocked"]) {
  for (const reason of [undefined, "", "  ", "waiting"]) {
    Deno.test(`Projects blocked task to ${state} validates reason ${JSON.stringify(reason)}`, async () => {
      const result = await validate({
        operation: {
          op: "transition",
          resource: "optd/projects:task",
          to: state,
        },
        current: { title: "Task", state: "blocked", blocked_reason: "waiting" },
        proposed: { title: "Task", state, blocked_reason: reason },
      });
      assertEquals(
        result.allow,
        state === "blocked" ? reason === "waiting" : reason !== "waiting",
      );
    });
  }
}

async function validate(input: Record<string, unknown>) {
  const cacheDir = await Deno.makeTempDir({ prefix: "optd-task-completion-" });
  try {
    const result = await new DenoHookRunner({ cacheDir }).run({
      namespace: "optd/projects",
      name: "validate_task",
      revision: "completion-test",
      scriptPath: "hooks/validate_task.ts",
      scriptDigest: `sha256:${"1".repeat(64)}`,
      scriptContent: await Deno.readTextFile(
        "prototypes/project-management-pack/hooks/validate_task.ts",
      ),
      outputSchema: "validation.v1",
      timeoutMs: 30_000,
      permissions: {},
    }, {
      hook: "optd/projects:validate_task",
      phase: "changeset.validate",
      input,
    });
    if (!result.ok) throw new Error(JSON.stringify(result));
    return result.output as {
      allow: boolean;
      errors: { code: string }[];
      warnings: unknown[];
      required_approvals: unknown[];
    };
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
}
