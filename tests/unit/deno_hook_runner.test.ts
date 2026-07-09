import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
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
    scriptContent: source,
    outputSchema: "validation.v1",
    timeoutMs: 1_000,
    permissions: {},
    ...extra,
  };
}

Deno.test("DenoHookRunner captures stderr and valid output", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "ok",
      `console.error("hello logs"); console.log(JSON.stringify({ errors: [], warnings: [] }));`,
    ),
    {
      hook: "ok",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, true);
  assertStringIncludes(result.logs, "hello logs");
});

Deno.test("DenoHookRunner reports permission failures", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "env_denied",
      `Deno.env.get("SECRET"); console.log(JSON.stringify({ errors: [] }));`,
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
    hook("blocked", `console.log(JSON.stringify({ errors: [] }));`, {
      permissions: { env: true },
    }),
    {
      hook: "blocked",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "permission_policy_denied");
});

Deno.test("DenoHookRunner reports timeouts", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "timeout",
      `await new Promise((resolve) => setTimeout(resolve, 1000)); console.log(JSON.stringify({ errors: [] }));`,
      { timeoutMs: 20 },
    ),
    {
      hook: "timeout",
      phase: "changeset.validate",
      input: {},
    },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "timeout");
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
       console.log(JSON.stringify({ errors: token === "shh-value" && !otherAllowed ? [] : ["bad env"] }));`,
      { secrets: [{ name: "api_token", env: "API_TOKEN" }] },
    ),
    { hook: "secret_env", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, true);
  assertEquals(result.output?.errors, []);
});

Deno.test("DenoHookRunner fails before spawn when a declared secret is missing", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const result = await runner.run(
    hook(
      "missing_secret",
      `console.error("spawned"); console.log(JSON.stringify({ errors: [] }));`,
      {
        secrets: [{ name: "api_token", env: "API_TOKEN" }],
      },
    ),
    { hook: "missing_secret", phase: "changeset.validate", input: {} },
  );
  assertEquals(result.ok, false);
  assertEquals(result.error?.code, "missing_secret");
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
  assertEquals(badJson.error?.code, "invalid_stdout_json");

  const invalid = await runner.run(
    hook("bad_schema", `console.log(JSON.stringify({ patches: {} }));`, {
      outputSchema: "patch.v1",
    }),
    { hook: "bad_schema", phase: "changeset.before_preview", input: {} },
  );
  assertEquals(invalid.ok, false);
  assertEquals(invalid.error?.code, "invalid_output_schema");
});
