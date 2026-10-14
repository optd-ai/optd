import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { LinuxProcessInspector } from "../../src/adapters/outbound/process-inspection/linux.ts";
import { ProcessInspectionError } from "../../src/application/ports/process_inspection.ts";
import { DenoHookRunner } from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";

Deno.test("process inspection uses PATH and reports a missing helper rather than a dead process", async () => {
  const originalPath = Deno.env.get("PATH");
  const root = await Deno.makeTempDir({ prefix: "optd-proc-helper-" });
  try {
    let cat: string | undefined;
    for (const directory of (originalPath ?? "").split(":")) {
      const path = `${directory}/cat`;
      const stat = await Deno.stat(path).catch(() => undefined);
      if (stat?.isFile && ((stat.mode ?? 0) & 0o111)) {
        cat = await Deno.realPath(path);
        break;
      }
    }
    assert(cat, "test requires cat somewhere on PATH");
    await Deno.symlink(cat, `${root}/cat`);
    Deno.env.set("PATH", root);
    assertEquals(
      (await new LinuxProcessInspector().inspect(Deno.pid)).pid,
      Deno.pid,
    );
    await Deno.remove(`${root}/cat`);
    const error = await assertRejects(
      () => new LinuxProcessInspector().inspect(Deno.pid),
      ProcessInspectionError,
      "cat on PATH",
    );
    assertEquals(error.reason, "unavailable");
  } finally {
    if (originalPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", originalPath);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("CLI help exposes real input flags and missing argument errors name the argument", async () => {
  for (
    const [args, flag] of [
      [["bootstrap", "init"], "--password-stdin"],
      [["create"], "--initial-state"],
      [["changeset", "stage"], "--input"],
      [["pack", "apply"], "--reviewed"],
      [["seed", "commit"], "--all"],
      [["query"], "--include-total"],
    ] as const
  ) {
    const help = await runOptctl([...args, "--help"]);
    assertEquals(help.code, 0, help.stderr);
    assertStringIncludes(help.stdout, flag);
  }
  const context = await runOptctl([
    "context",
    "add",
    "--server",
    "http://localhost:8789",
  ]);
  assertStringIncludes(context.stderr, "context name");
  const approval = await runOptctl([
    "changeset",
    "approve",
    "019b7a2e-7c10-7000-8000-000000000001",
  ]);
  assertStringIncludes(approval.stderr, "requirement id is required");
});

Deno.test("task completion emits no timesheet without hours and rejects half-pairs", async () => {
  const cacheDir = await Deno.makeTempDir({ prefix: "optd-optional-hours-" });
  try {
    const runner = new DenoHookRunner({ cacheDir });
    const hook = {
      namespace: "optd/projects",
      name: "complete_task",
      revision: "test",
      scriptPath: "hooks/complete_task.ts",
      scriptDigest: `sha256:${"1".repeat(64)}`,
      scriptContent: await Deno.readTextFile(
        "prototypes/project-management-pack/hooks/complete_task.ts",
      ),
      outputSchema: "changeset.operations.v1" as const,
      timeoutMs: 30_000,
      permissions: {},
    };
    for (
      const partial of [{}, { spent_hours: "1.00" }, {
        entry_date: "2026-10-14",
      }]
    ) {
      const result = await runner.run(hook, {
        hook: "optd/projects:complete_task",
        phase: "action.stage",
        input: {
          action_input: {
            task_id: "019b7a2e-7c10-7000-8000-000000000001",
            stage_id: "019b7a2e-7c10-7000-8000-000000000002",
            ...partial,
          },
          task: { version: 1 },
          actor: { id: "019b7a2e-7c10-7000-8000-000000000003" },
        },
      });
      assertEquals(result.ok, Object.keys(partial).length === 0);
      if (result.ok) {
        const operations =
          (result.output as { operations: { set: Record<string, unknown> }[] })
            .operations;
        assertEquals(operations.length, 1);
        assertEquals(Object.hasOwn(operations[0].set, "spent_hours"), false);
      }
    }
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
});
