function assertEquals(actual: unknown, expected: unknown): void {
  if (
    !Object.is(actual, expected) &&
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
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
import {
  DenoHookRunner,
  type HookDefinition,
  resolveHookDenoBinary,
} from "../../../src/adapters/outbound/deno-hooks/hook_runner.ts";

function hook(
  source: string,
  extra: Partial<HookDefinition> = {},
): HookDefinition {
  return {
    namespace: "test",
    name: "secure",
    revision: "revision",
    scriptPath: "secure.ts",
    scriptDigest: "sha256:test",
    scriptContent: source,
    outputSchema: "validation.v1",
    timeoutMs: 30_000,
    permissions: {
      net: false,
      env: false,
      read: false,
      write: false,
      run: false,
    },
    ...extra,
  };
}
const valid =
  `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`;
const envelope = {
  hook: "test:secure",
  phase: "changeset.validate",
  input: {},
};

Deno.test("runner uses an empty ambient environment and narrow secret access", async () => {
  const runner = new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    secretValues: { token: "needle" },
  });
  const result = await runner.run(
    hook(
      `
    const token=Deno.env.get("TOKEN"); let ambient=false;
    try { ambient=Deno.env.get("PATH")!==undefined } catch {}
    console.error(token); console.log(JSON.stringify({allow:token==="needle"&&!ambient,errors:[],warnings:[],required_approvals:[]}));
  `,
      { secrets: [{ name: "token", slot: "token", env: "TOKEN" }] },
    ),
    envelope,
  );
  assertEquals(result.ok, true);
  assertStringIncludes(result.logs, "[REDACTED_SECRET]");
  assertEquals(result.logs.includes("needle"), false);
  assertEquals(result.secretsRedacted, true);
});

Deno.test("runner permanently denies imports and unrestricted capabilities before spawn", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  for (
    const source of [
      `import "./x.ts";`,
      `await import("data:text/javascript,x")`,
      `await import("blob:denied")`,
      `await import("https://example.invalid/x.ts")`,
      `await import("jsr:@std/assert")`,
      `await import("npm:package")`,
      `await import("node:fs")`,
      `new Function("return import('npm:x')")`,
    ]
  ) {
    const result = await runner.run(hook(source), envelope);
    assertEquals(result.ok, false);
    assertEquals(result.error?.code, "hook_import_denied");
  }
  assertEquals(
    (await runner.run(hook(valid, { permissions: { net: true } }), envelope))
      .error?.code,
    "hook_capability_denied",
  );
});

Deno.test("trusted prelude blocks obfuscated eval and constructor imports and deletes entries", async () => {
  const cacheDir = await Deno.makeTempDir();
  const runner = new DenoHookRunner({ cacheDir });
  const escapes = [
    `const e=(0,eval); await e("im"+"port('data:text/javascript,export default 1')");`,
    `await (()=>{}).constructor("return im"+"port('data:text/javascript,export default 1')")();`,
    `await (async()=>{}).constructor("return im"+"port('data:text/javascript,export default 1')")();`,
    `(function*(){}).constructor("return im"+"port('data:text/javascript,export default 1')")();`,
    `(async function*(){}).constructor("return im"+"port('data:text/javascript,export default 1')")();`,
    `AsyncFunction("return im"+"port('blob:denied')")();`,
    `GeneratorFunction("return im"+"port('data:text/javascript,export default 1')")();`,
    `AsyncGeneratorFunction("return im"+"port('data:text/javascript,export default 1')")();`,
    `fetch.constructor("return globalThis.fetch")();`,
  ];
  for (let index = 0; index < escapes.length; index++) {
    const result = await runner.run(
      hook(
        `${escapes[index]} ${valid}`,
        { scriptDigest: `sha256:escape_${index}` },
      ),
      envelope,
    );
    assertEquals(result.ok, false);
    assertEquals(result.error?.code, "hook_failed");
    const entries = [];
    for await (const entry of Deno.readDir(cacheDir)) entries.push(entry.name);
    assertEquals(entries, []);
  }
});

Deno.test("trusted fetch rejects declared redirects without contacting destination", async () => {
  let destinationAttempts = 0;
  const destinationController = new AbortController();
  const destination = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: destinationController.signal,
    onListen() {},
  }, () => {
    destinationAttempts++;
    return new Response("destination");
  });
  const destinationAddress = destination.addr as Deno.NetAddr;
  const sourceController = new AbortController();
  const source = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: sourceController.signal,
    onListen() {},
  }, () =>
    new Response(null, {
      status: 302,
      headers: {
        location: `http://127.0.0.1:${destinationAddress.port}/target`,
      },
    }));
  const sourceAddress = source.addr as Deno.NetAddr;
  try {
    const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
    const result = await runner.run(
      hook(
        `await fetch("http://127.0.0.1:${sourceAddress.port}/redirect", {redirect:"follow"}); ${valid}`,
        {
          scriptDigest: "sha256:redirect",
          permissions: {
            net: [
              `127.0.0.1:${sourceAddress.port}`,
              `127.0.0.1:${destinationAddress.port}`,
            ],
            env: false,
            read: false,
            write: false,
            run: false,
          },
        },
      ),
      envelope,
    );
    assertEquals(result.ok, false);
    assertEquals(result.error?.code, "hook_failed");
    assertEquals(destinationAttempts, 0);
  } finally {
    sourceController.abort();
    destinationController.abort();
    await Promise.all([
      source.finished.catch(() => undefined),
      destination.finished.catch(() => undefined),
    ]);
  }
});

Deno.test("hook Deno runtime requires an absolute verified interpreter", async () => {
  assertEquals(await resolveHookDenoBinary(Deno.execPath()), Deno.execPath());
  let rejected = false;
  try {
    await resolveHookDenoBinary("deno");
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
  const fake = await Deno.makeTempFile();
  await Deno.writeTextFile(fake, "not deno");
  rejected = false;
  try {
    await resolveHookDenoBinary(fake);
  } catch {
    rejected = true;
  }
  assertEquals(rejected, true);
});

Deno.test("runner permanently denies filesystem, subprocess, sys, FFI, and undeclared net", async () => {
  const cases = [
    `await Deno.readTextFile("/etc/passwd");`,
    `await Deno.writeTextFile("/tmp/denied", "x");`,
    `new Deno.Command("/bin/echo").outputSync();`,
    `Deno.systemMemoryInfo();`,
    `Deno.dlopen("/tmp/missing.so", {});`,
    `await fetch("http://127.0.0.1:9");`,
  ];
  for (let index = 0; index < cases.length; index++) {
    const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
    const result = await runner.run(
      hook(
        `${cases[index]} ${valid}`,
        { scriptDigest: `sha256:denied_${index}` },
      ),
      envelope,
    );
    assertEquals(result.ok, false);
    assertEquals(result.error?.code, "hook_failed");
  }
  const self = await new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    serverPort: 8789,
  }).run(
    hook(valid, {
      scriptDigest: "sha256:self",
      permissions: { net: ["127.0.0.1:8789"] },
    }),
    envelope,
  );
  assertEquals(self.error?.code, "hook_capability_denied");
  const database = await new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    databaseEndpoints: ["127.0.0.1:5432"],
  }).run(
    hook(valid, {
      scriptDigest: "sha256:database",
      permissions: { net: ["127.0.0.1:5432"] },
    }),
    envelope,
  );
  assertEquals(database.error?.code, "hook_capability_denied");
});

Deno.test("runner bounds stdout and truncates/redacts stderr", async () => {
  const runner = new DenoHookRunner({
    cacheDir: await Deno.makeTempDir(),
    stdoutLimitBytes: 128,
    stderrLimitBytes: 32,
    secretValues: {
      token: "needle-secret",
      overlapping: "secret",
    },
  });
  const overflow = await runner.run(
    hook(
      `console.log("x".repeat(1024));`,
      { scriptDigest: "sha256:overflow" },
    ),
    envelope,
  );
  assertEquals(overflow.error?.code, "hook_stdout_limit");
  const truncated = await runner.run(
    hook(
      `await Deno.stderr.write(new TextEncoder().encode("x".repeat(28)+"needle-"));
       await Deno.stderr.write(new TextEncoder().encode("secret"+"z".repeat(128)));
       ${valid}`,
      {
        scriptDigest: "sha256:truncated",
        secrets: [
          { name: "token", slot: "token", env: "TOKEN" },
          { name: "overlapping", slot: "overlapping", env: "OVERLAPPING" },
        ],
      },
    ),
    envelope,
  );
  assertEquals(truncated.ok, true);
  assertEquals(truncated.logsTruncated, true);
  assertEquals(truncated.logs.includes("needle-secret"), false);
  assertEquals(truncated.logs.includes("needle-"), false);
  assertEquals(truncated.logs.includes("secret"), false);
  assertEquals(truncated.logs.includes("[OPERANT_LOG_TRUNCATED]"), true);
});

Deno.test("runner enforces timeout and strict output without retaining stdout", async () => {
  const runner = new DenoHookRunner({ cacheDir: await Deno.makeTempDir() });
  const timeout = await runner.run(
    hook(`await new Promise(r=>setTimeout(r,1000));${valid}`, {
      timeoutMs: 20,
    }),
    envelope,
  );
  assertEquals(timeout.error?.code, "hook_timeout");
  const unknown = await runner.run(
    hook(
      `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[],extra:true}))`,
      { scriptDigest: "sha256:unknown" },
    ),
    envelope,
  );
  assertEquals(unknown.error?.code, "hook_invalid_output");
  assertEquals(unknown.error?.details, {});
});
