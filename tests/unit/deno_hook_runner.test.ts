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
  DenoHookRunner,
  type HookDefinition,
} from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";

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
