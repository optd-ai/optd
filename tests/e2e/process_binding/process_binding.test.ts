import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
} from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { startLiveHarness } from "../../support/live_harness.ts";

type Binding = {
  id: string;
  session_id: string;
  anchor: {
    pid: number;
    parentPid: number;
    startTicks: string;
    uid: number;
    bootId: string;
  };
};

Deno.test("compiled optctl binds one nearest Linux process credential without fallback", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.runOptctl([
      "--json",
      "bootstrap",
      "init",
      "--username",
      "process-admin",
      "--password-stdin",
    ], "compiled process binding password\n");
    assertEquals(boot.code, 0, boot.stderr);

    const humanStatus = await harness.runOptctl(["--json", "auth", "status"]);
    assertEquals(humanStatus.code, 0, humanStatus.stderr);
    const inherited = JSON.parse(humanStatus.stdout).data;
    assertEquals(inherited.credential_type, "human");
    assertEquals(inherited.authenticated, true);
    assert(inherited.anchor_pid > 1);
    assertMatch(inherited.anchor_start_ticks, /^\d+$/);
    assertEquals(inherited.anchor_uid, Deno.uid());
    assertMatch(inherited.anchor_boot_id, /^[0-9a-f-]{36}$/);

    const childStatus = await harness.runOptctl([
      "--json",
      "auth",
      "isolate",
      "--",
      harness.binaryPath,
      "--server",
      harness.baseUrl,
      "--json",
      "auth",
      "status",
    ]);
    assertEquals(childStatus.code, 0, childStatus.stderr);
    const isolated = JSON.parse(childStatus.stdout).data;
    assertEquals(isolated.authenticated, false);
    assertEquals(isolated.request_credential_available, true);

    const helperPath = join(harness.rootDir, "narrow-agent.ts");
    const requestPath = join(harness.rootDir, "narrow-request.json");
    const resultPath = join(harness.rootDir, "narrow-result.json");
    await Deno.writeTextFile(helperPath, narrowAgentHelper(), { mode: 0o600 });
    const isolatedRequest = await harness.runOptctl([
      "--json",
      "auth",
      "isolate",
      "--",
      Deno.execPath(),
      "run",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      helperPath,
      harness.binaryPath,
      harness.baseUrl,
      requestPath,
      resultPath,
      "request",
    ]);
    assertEquals(isolatedRequest.code, 0, isolatedRequest.stderr);
    const requestId = await waitForJson(requestPath) as string;
    const approved = await harness.runOptctl([
      "--json",
      "auth",
      "approve",
      requestId,
      "--yes",
      "--agent-name",
      "narrow-child",
    ]);
    assertEquals(approved.code, 0, approved.stderr);
    const isolateResult = await harness.runOptctl([
      "--json",
      "auth",
      "isolate",
      "--",
      Deno.execPath(),
      "run",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      helperPath,
      harness.binaryPath,
      harness.baseUrl,
      requestPath,
      resultPath,
      "finish",
    ]);
    assertEquals(isolateResult.code, 0, isolateResult.stderr);
    const narrow = await waitForJson(resultPath) as Record<string, unknown>;
    assertEquals(narrow.credential_type, "agent");
    assertEquals(narrow.work_code, 1);
    assertEquals(narrow.work_error, "authorization_insufficient");
    assertEquals(narrow.denied_code, 1);
    assertEquals(narrow.denied_error, "authorization_insufficient");
    assertEquals(narrow.revoked_code, 0);
    assertEquals(narrow.invalid_stop_error, "internal_error");

    const otherOrigin = await harness.runOptctl([
      "--server",
      "http://127.0.0.1:1",
      "--json",
      "auth",
      "status",
    ]);
    assertEquals(otherOrigin.code, 0, otherOrigin.stderr);
    assertEquals(JSON.parse(otherOrigin.stdout).data.authenticated, false);

    const paths = await authPaths(harness.homeDir);
    assertEquals((await Deno.stat(paths.root)).mode! & 0o777, 0o700);
    assertEquals((await Deno.stat(paths.token)).uid, Deno.uid());
    await Deno.chmod(paths.token, 0o644);
    const unhealthy = await runDirect(
      harness.binaryPath,
      harness.baseUrl,
      harness.homeDir,
      harness.rootDir,
      ["--json", "auth", "doctor"],
    );
    assertEquals(unhealthy.code, 1);
    assertEquals(
      JSON.parse(unhealthy.stdout).findings.some((finding: { code: string }) =>
        finding.code === "token_permissions_unsafe"
      ),
      true,
    );
    const repaired = await runDirect(
      harness.binaryPath,
      harness.baseUrl,
      harness.homeDir,
      harness.rootDir,
      [
        "--json",
        "auth",
        "doctor",
        "--fix",
        "--yes",
      ],
    );
    assertEquals(repaired.code, 0, repaired.stderr);
    assertEquals((await Deno.stat(paths.token)).mode! & 0o777, 0o600);

    const binding = JSON.parse(
      await Deno.readTextFile(paths.binding),
    ) as Binding;
    for (
      const mutation of [
        { startTicks: `${BigInt(binding.anchor.startTicks) + 1n}` },
        { uid: binding.anchor.uid + 1 },
        { bootId: crypto.randomUUID() },
      ]
    ) {
      await writeBinding(paths.binding, {
        ...binding,
        anchor: { ...binding.anchor, ...mutation },
      });
      const stale = await runDirect(
        harness.binaryPath,
        harness.baseUrl,
        harness.homeDir,
        harness.rootDir,
        ["--json", "auth", "status"],
      );
      assertEquals(stale.code, 0, stale.stderr);
      assertEquals(JSON.parse(stale.stdout).data.authenticated, false);
    }
    await writeBinding(paths.binding, binding);
    const restored = await runDirect(
      harness.binaryPath,
      harness.baseUrl,
      harness.homeDir,
      harness.rootDir,
      ["--json", "auth", "status"],
    );
    assertEquals(JSON.parse(restored.stdout).data.authenticated, true);

    await writeBinding(paths.binding, {
      ...binding,
      anchor: {
        ...binding.anchor,
        startTicks: `${BigInt(binding.anchor.startTicks) + 1n}`,
      },
    });
    const cleaned = await runDirect(
      harness.binaryPath,
      harness.baseUrl,
      harness.homeDir,
      harness.rootDir,
      ["--json", "auth", "cleanup"],
    );
    assertEquals(cleaned.code, 0, cleaned.stderr);
    assertEquals(JSON.parse(cleaned.stdout).data.removed >= 1, true);
    assertEquals(
      (await runDirect(
        harness.binaryPath,
        harness.baseUrl,
        harness.homeDir,
        harness.rootDir,
        ["--json", "auth", "status"],
      )).code,
      0,
    );
  } finally {
    await harness.close();
  }
});

async function runDirect(
  binary: string,
  server: string,
  home: string,
  root: string,
  args: string[],
) {
  const output = await new Deno.Command(binary, {
    args: ["--server", server, ...args],
    env: {
      ...Deno.env.toObject(),
      HOME: home,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout).trimEnd(),
    stderr: new TextDecoder().decode(output.stderr).trimEnd(),
  };
}

async function waitForJson(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      return JSON.parse(await Deno.readTextFile(path));
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof SyntaxError)
      ) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function authPaths(home: string) {
  const root = join(home, ".local", "share", "operant", "auth");
  const instances = join(root, "instances");
  const instance = (await Array.fromAsync(Deno.readDir(instances)))[0];
  assertExists(instance);
  const instancePath = join(instances, instance.name);
  const bindings =
    (await Array.fromAsync(Deno.readDir(join(instancePath, "bindings"))))
      .filter((entry) => entry.name.endsWith(".json"));
  assert(bindings.length >= 1);
  const binding = join(instancePath, "bindings", bindings[0].name);
  const record = JSON.parse(await Deno.readTextFile(binding)) as Binding;
  return {
    root,
    binding,
    token: join(instancePath, "sessions", record.session_id, "token"),
  };
}

async function writeBinding(path: string, binding: Binding) {
  await Deno.writeTextFile(path, JSON.stringify(binding), { mode: 0o600 });
  await Deno.chmod(path, 0o600);
}

function narrowAgentHelper(): string {
  return `
    const [binary, server, requestPath, resultPath, mode] = Deno.args;
    const run = async (args) => {
      const output = await new Deno.Command(binary, {
        args: ["--server", server, "--json", ...args],
        stdout: "piped", stderr: "piped",
      }).output();
      return { code: output.code, stdout: new TextDecoder().decode(output.stdout), stderr: new TextDecoder().decode(output.stderr) };
    };
    if (mode === "request") {
      const request = await run(["auth", "request", "--role", "system:admin", "--boundary", "system", "--reason", "nearest child binding"]);
      if (request.code !== 0) throw new Error(request.stderr);
      const requestId = JSON.parse(request.stdout).data.id;
      await Deno.writeTextFile(requestPath, JSON.stringify(requestId));
      Deno.exit(0);
    }
    const requestId = JSON.parse(await Deno.readTextFile(requestPath));
    const waited = await run(["auth", "wait", requestId]);
    if (waited.code !== 0) throw new Error(waited.stderr);
    const status = JSON.parse((await run(["auth", "status"])).stdout).data;
    const allowed = await run(["project", "list"]);
    const broad = await run(["auth", "request", "--role", "system:super_admin", "--boundary", "system", "--reason", "must not fallback"]);
    if (broad.code !== 0) throw new Error(broad.stderr);
    const broadId = JSON.parse(broad.stdout).data.id;
    const denied = await run(["auth", "approve", broadId, "--yes"]);
    const invalidStop = await new Deno.Command(binary, {
      args: ["--server", server, "--json", "auth", "status"],
      env: { ...Deno.env.toObject(), OPERANT_AUTH_TREE_STOP_PID: "2147483647" },
      stdout: "piped", stderr: "piped",
    }).output();
    const invalidStopBody = JSON.parse(new TextDecoder().decode(invalidStop.stderr));
    const revoked = await run(["auth", "revoke", status.authorization_id]);
    await Deno.writeTextFile(resultPath, JSON.stringify({
      credential_type: status.credential_type,
      work_code: allowed.code,
      work_error: JSON.parse(allowed.stderr).error.code,
      denied_code: denied.code,
      denied_error: JSON.parse(denied.stderr).error.code,
      revoked_code: revoked.code,
      invalid_stop_error: invalidStopBody.error.code,
    }));
  `;
}
