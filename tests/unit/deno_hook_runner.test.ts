function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertStringIncludes(actual: string, expected: string): void {
  if (!actual.includes(expected)) {
    throw new Error(`expected string to include ${expected}`);
  }
}

async function assertDirectoryEmpty(path: string): Promise<void> {
  const entries = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry.name);
  assertEquals(entries, []);
}
import {
  clearRuntimeHookCache,
  DenoHookRunner,
  type HookDefinition,
  prepareRuntimeHookCache,
  runtimeHookCacheDirectory,
} from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";

Deno.test("runtime hook caches recover only their owned invocation entries", async () => {
  const root = await Deno.makeTempDir();
  const first = runtimeHookCacheDirectory(`${root}/first`);
  const second = runtimeHookCacheDirectory(`${root}/second`);
  await Promise.all([
    Deno.mkdir(`${first}/invocation_stale`, { recursive: true }),
    Deno.mkdir(`${second}/invocation_active`, { recursive: true }),
  ]);
  await Deno.writeTextFile(`${first}/invocation_stale/hook.ts`, "sensitive");
  await Deno.writeTextFile(`${first}/keep`, "owned metadata");

  await prepareRuntimeHookCache(first);

  assertEquals(
    await Array.fromAsync(Deno.readDir(first)).then((entries) =>
      entries.map((entry) => entry.name).sort()
    ),
    ["keep"],
  );
  assertEquals(
    await Array.fromAsync(Deno.readDir(second)).then((entries) =>
      entries.map((entry) => entry.name).sort()
    ),
    ["invocation_active"],
  );
  assertEquals((await Deno.stat(first)).mode! & 0o777, 0o700);

  await clearRuntimeHookCache(second);
  await assertDirectoryEmpty(second);
  await Deno.remove(root, { recursive: true });
});

Deno.test("runtime hook cache startup removes stale partial directories", async () => {
  const cacheDir = await Deno.makeTempDir();
  for (const name of ["invocation_hook_partial", "invocation_entry_partial"]) {
    await Deno.mkdir(`${cacheDir}/${name}`, { mode: 0o700 });
    await Deno.writeTextFile(`${cacheDir}/${name}/hook.ts`, "raw source");
  }
  await prepareRuntimeHookCache(cacheDir);
  await assertDirectoryEmpty(cacheDir);
  await Deno.remove(cacheDir, { recursive: true });
});

Deno.test("runtime hook cache recovery erases source and preserves its first removal failure", async () => {
  for (const retryFails of [false, true]) {
    const cacheDir = await Deno.makeTempDir();
    const invocation = `${cacheDir}/invocation_stale`;
    await Deno.mkdir(invocation, { mode: 0o700 });
    await Deno.writeTextFile(`${invocation}/hook.ts`, "unique raw source");
    await Deno.writeTextFile(`${invocation}/entry.ts`, "trusted entry");
    let removals = 0;
    let caught: unknown;
    try {
      await clearRuntimeHookCache(cacheDir, {
        remove: async (path, options) => {
          removals++;
          if (removals === 1 || retryFails) {
            throw new Error("injected initial removal failure");
          }
          await Deno.remove(path, options);
        },
      });
    } catch (error) {
      caught = error;
    }
    assertEquals(
      caught instanceof Error ? caught.message : String(caught),
      "injected initial removal failure",
    );
    assertEquals(removals, 2);
    if (retryFails) {
      assertEquals(await Deno.readTextFile(`${invocation}/hook.ts`), "");
      assertEquals(await Deno.readTextFile(`${invocation}/entry.ts`), "");
      await Deno.remove(invocation, { recursive: true });
    } else {
      await assertDirectoryEmpty(cacheDir);
    }
    assertEquals((await Deno.stat(cacheDir)).mode! & 0o777, 0o700);
    await Deno.remove(cacheDir, { recursive: true });
  }
});

function hook(
  name: string,
  source: string,
  extra: Partial<HookDefinition> = {},
): HookDefinition {
  return {
    namespace: "test",
    name,
    revision: "test.pack@0:abc",
    scriptPath: `hooks/${name}.ts`,
    scriptDigest: `sha256:${name}`,
    scriptContent: `await new Response(Deno.stdin.readable).text();\n${source}`,
    outputSchema: "validation.v1",
    timeoutMs: 30_000,
    permissions: {},
    ...extra,
  };
}

Deno.test("DenoHookRunner captures stderr and valid output", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "ok",
      `console.error("hello logs"); console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
    ),
    {
      hook: "ok",
      phase: "changeset.validate",
      input: {},
    },
  );
  if (!result.ok) throw new Error(JSON.stringify(result));
  assertEquals(result.ok, true);
  assertStringIncludes(result.logs, "hello logs");
});

Deno.test("DenoHookRunner accepts authoritative fast valid exits concurrently", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const results = await Promise.all(
    Array.from({ length: 16 }, (_, index) =>
      runner.run(
        hook(
          `fast_exit_${index}`,
          "",
          {
            scriptContent:
              `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`,
          },
        ),
        {
          hook: `fast_exit_${index}`,
          phase: "changeset.validate",
          input: { payload: "x".repeat(64 * 1024) },
        },
      )),
  );
  for (const result of results) {
    if (!result.ok) throw new Error(JSON.stringify(result));
    assertEquals(result.ok, true);
  }
});

Deno.test("DenoHookRunner terminates after settled output despite open event-loop resources", async () => {
  const cacheDir = await Deno.makeTempDir();
  try {
    const runner = new DenoHookRunner({ cacheDir });
    const result = await runner.run(
      hook(
        "open_resources",
        `console.error("final-business-log");
         console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));
         setInterval(() => console.error("post-completion-log"), 60_000);`,
        { timeoutMs: 2_000 },
      ),
      {
        hook: "open_resources",
        phase: "changeset.validate",
        input: {},
      },
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    assertEquals(result.exitCode, 0);
    assertEquals(result.logs, "final-business-log\n");
    if (result.durationMs >= 2_000) {
      throw new Error(
        `settled hook waited for timeout: ${result.durationMs}ms`,
      );
    }
  } finally {
    await Deno.remove(cacheDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("DenoHookRunner repeatedly completes real two-second pack hooks under CPU stress", async () => {
  const cacheDir = await Deno.makeTempDir();
  const stressor = new Worker(
    "data:application/javascript,while(true){}",
    { type: "module" },
  );
  try {
    const runner = new DenoHookRunner({ cacheDir });
    const normalizeSource = await Deno.readTextFile(
      new URL(
        "../../prototypes/crm-default-pack/hooks/normalize_lead.ts",
        import.meta.url,
      ),
    );
    const startSource = await Deno.readTextFile(
      new URL(
        "../../prototypes/project-management-pack/hooks/start_task.ts",
        import.meta.url,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const runs = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        Promise.all([
          runner.run(
            hook(`normalize_lead_${index}`, "", {
              scriptContent: normalizeSource,
              outputSchema: "patch.v1",
              timeoutMs: 2_000,
            }),
            {
              hook: `normalize_lead_${index}`,
              phase: "changeset.before_preview",
              input: {
                operation: {
                  fields: {
                    email: ` Person${index}@Example.com `,
                    name: " Person ",
                  },
                },
              },
            },
          ),
          runner.run(
            hook(`start_task_${index}`, "", {
              scriptContent: startSource,
              outputSchema: "changeset.operations.v1",
              timeoutMs: 2_000,
            }),
            {
              hook: `start_task_${index}`,
              phase: "action.before_execute",
              input: {
                action_input: {
                  task_id: `task-${index}`,
                  stage_id: "stage",
                },
                task: { version: 1 },
              },
            },
          ),
        ])),
    );
    for (const result of runs.flat()) {
      if (!result.ok) throw new Error(JSON.stringify(result));
      assertEquals(result.exitCode, 0);
      if (result.durationMs >= 2_000) {
        throw new Error(
          `${result.hook} approached its execution bound: ${result.durationMs}ms`,
        );
      }
    }
  } finally {
    stressor.terminate();
    await Deno.remove(cacheDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("DenoHookRunner preserves diagnostics after accepted child closes stdin", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "early_exit",
      `console.error("startup-diagnostic"); Deno.exit(7);`,
      {
        scriptContent:
          `await Deno.stdin.readable.cancel(); console.error("startup-diagnostic"); await new Promise(resolve=>setTimeout(resolve,500));`,
      },
    ),
    {
      hook: "early_exit",
      phase: "changeset.validate",
      input: { payload: "x".repeat(16 * 1024 * 1024) },
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_invalid_output");
  assertEquals(result.exitCode, 0);
  assertStringIncludes(result.logs, "startup-diagnostic");
});

Deno.test("DenoHookRunner bounds delayed stdin delivery separately", async () => {
  const runner = new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    inputDeliveryTimeoutMs: 20,
  });
  const result = await runner.run(
    hook("delayed_input", "", {
      timeoutMs: 1_000,
      scriptContent:
        `await new Promise(resolve => setTimeout(resolve, 250)); await new Response(Deno.stdin.readable).text();`,
    }),
    {
      hook: "delayed_input",
      phase: "changeset.validate",
      input: { payload: "x".repeat(16 * 1024 * 1024) },
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_spawn_failed");
});

Deno.test("DenoHookRunner preserves post-accept invalid and nonzero results", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const invalid = await runner.run(
    hook("accepted_invalid", `console.log("not-json");`),
    { hook: "accepted_invalid", phase: "changeset.validate", input: {} },
  );
  assertEquals(invalid.error?.code, "hook_invalid_output");
  const failed = await runner.run(
    hook("accepted_failure", `console.error("actual-failure"); Deno.exit(9);`),
    { hook: "accepted_failure", phase: "changeset.validate", input: {} },
  );
  assertEquals(failed.error?.code, "hook_failed");
  assertEquals(failed.exitCode, 9);
  assertStringIncludes(failed.logs, "actual-failure");
});

Deno.test("DenoHookRunner reports permission failures", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "env_denied",
      `Deno.env.get("SECRET"); console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
    ),
    {
      hook: "env_denied",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_failed");
  assertStringIncludes(result.logs, "Requires env access");
});

Deno.test("DenoHookRunner rejects permissions blocked by global policy", async () => {
  const runner = new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    globalPolicy: {
      net: false,
      read: false,
      write: false,
      env: false,
      run: false,
    },
  });
  const result = await runner.run(
    hook(
      "blocked",
      `console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
      {
        permissions: { env: true },
      },
    ),
    {
      hook: "blocked",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_capability_denied");
});

Deno.test("DenoHookRunner reports timeouts", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "timeout",
      `await new Promise((resolve) => setTimeout(resolve, 1000)); console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
      { timeoutMs: 20 },
    ),
    {
      hook: "timeout",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_timeout");
});

Deno.test("DenoHookRunner parent watchdog stops synchronous infinite hooks", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const started = performance.now();
  const result = await runner.run(
    hook("sync_timeout", `while (true) { /* block the child event loop */ }`, {
      timeoutMs: 30,
    }),
    { hook: "sync_timeout", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_timeout");
  if (performance.now() - started > 5_000) {
    throw new Error(
      "parent hook watchdog did not terminate the child promptly",
    );
  }
});

Deno.test("DenoHookRunner readiness cannot be preempted by hoisted user declarations", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "hoisted_timeout",
      `function TextEncoder() { while (true) { /* hoisted shadow exploit */ } }
       while (true) { /* top-level user code must run after trusted readiness */ }`,
      { timeoutMs: 30 },
    ),
    { hook: "hoisted_timeout", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_timeout");
});

Deno.test("DenoHookRunner ignores user readiness-frame forgeries", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "forged_timeout",
      `Deno.stderr.writeSync(new TextEncoder().encode("\\u001eOPERANT_HOOK_READY:forged\\u001e\\n"));
       while (true) { /* a forged generic frame cannot control the parent timer */ }`,
      { timeoutMs: 30 },
    ),
    { hook: "forged_timeout", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_timeout");
  assertEquals(result.logs.includes("OPERANT_HOOK_READY"), false);
});

Deno.test("DenoHookRunner removes partial materializations after every population fault", async () => {
  const cases = ["chmod", "hook_write", "entry_write"] as const;
  for (const fault of cases) {
    const cacheDir = await Deno.makeTempDir();
    let writes = 0;
    const runner = new DenoHookRunner({
      cacheDir,
      materializationOperations: {
        chmod: async (path, mode) => {
          if (fault === "chmod") throw new Error("injected chmod failure");
          await Deno.chmod(path, mode);
        },
        writeTextFile: async (path, data, options) => {
          writes += 1;
          await Deno.writeTextFile(path, data, options);
          if (
            (fault === "hook_write" && writes === 1) ||
            (fault === "entry_write" && writes === 2)
          ) {
            throw new Error("injected post-write failure");
          }
        },
      },
    });
    const result = await runner.run(
      hook(
        `materialize_${fault}`,
        `const rawSecret = "must-not-remain";
         console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
      ),
      {
        hook: `materialize_${fault}`,
        phase: "changeset.validate",
        input: {},
      },
    );
    assertEquals(result.ok, false);
    assertEquals(result.error?.code, "hook_spawn_failed");
    assertEquals(result.error?.message, "hook runtime could not be prepared");
    assertEquals(result.logs, "");
    await assertDirectoryEmpty(cacheDir);
    await Deno.remove(cacheDir);
  }
});

Deno.test("DenoHookRunner injects only declared secret env vars", async () => {
  const runner = new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    secretValues: { api_token: "shh-value", other_token: "must-not-leak" },
  });
  const result = await runner.run(
    hook(
      "secret_env",
      `const token = Deno.env.get("API_TOKEN");
       let otherAllowed = false;
       try { otherAllowed = Deno.env.get("OTHER_TOKEN") !== undefined; } catch { otherAllowed = false; }
       console.log(JSON.stringify({ allow: token === "shh-value" && !otherAllowed, errors: token === "shh-value" && !otherAllowed ? [] : [{path:"/",code:"bad_env",message:"bad env"}], warnings: [], required_approvals: [] }));`,
      { secrets: [{ name: "api_token", env: "API_TOKEN" }] },
    ),
    { hook: "secret_env", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, true);
  assertEquals(result.output?.allow, true);
});

Deno.test("DenoHookRunner fails before spawn when a declared secret is missing", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "missing_secret",
      `console.error("spawned"); console.log(JSON.stringify({ allow: true, errors: [], warnings: [], required_approvals: [] }));`,
      {
        secrets: [{ name: "api_token", env: "API_TOKEN" }],
      },
    ),
    { hook: "missing_secret", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "hook_secret_unavailable");
  assertEquals(result.logs, "");
});

Deno.test("DenoHookRunner reports bad JSON and invalid schema", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const badJson = await runner.run(hook("bad_json", `console.log("nope");`), {
    hook: "bad_json",
    phase: "changeset.validate",
    input: {},
  });
  assertEquals(badJson.ok, false);
  assertEquals(badJson.error?.code, "hook_invalid_output");

  const invalid = await runner.run(
    hook("bad_schema", `console.log(JSON.stringify({ patches: {} }));`, {
      outputSchema: "patch.v1",
    }),
    { hook: "bad_schema", phase: "changeset.before_preview", input: {} },
  );
  assertEquals(invalid.ok, false);
  assertEquals(invalid.error?.code, "hook_invalid_output");
});
