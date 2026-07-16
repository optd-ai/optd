import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
} from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

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

    const helperPath = join(harness.rootDir, "narrow-agent.ts");
    const requestPath = join(harness.rootDir, "narrow-request.json");
    const resultPath = join(harness.rootDir, "narrow-result.json");
    await Deno.writeTextFile(helperPath, narrowAgentHelper(), { mode: 0o600 });
    const statusResult = await runHelper(
      helperPath,
      harness,
      requestPath,
      resultPath,
      "status-stop",
    );
    assertEquals(statusResult.code, 0, statusResult.stderr);
    const isolated = await waitForJson(resultPath) as Record<string, unknown>;
    assertEquals(isolated.authenticated, false);
    assertEquals(isolated.request_credential_available, true);
    await Deno.remove(resultPath);

    for (const deniedExecutable of ["/bin/echo", "/usr/bin/cat"]) {
      const deniedSpawn = await harness.runOptctl([
        "--json",
        "auth",
        "isolate",
        "--",
        deniedExecutable,
        "denied",
      ]);
      assertEquals(deniedSpawn.code, 1);
      assertEquals(JSON.parse(deniedSpawn.stderr).error.code, "internal_error");
      assertMatch(
        JSON.parse(deniedSpawn.stderr).error.message,
        /allow-run|run access|NotCapable/,
      );
    }

    const isolatedRequest = await runHelper(
      helperPath,
      harness,
      requestPath,
      resultPath,
      "request",
    );
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
    const contextsBefore = await authContextCount(harness);
    const isolateResult = await runHelper(
      helperPath,
      harness,
      requestPath,
      resultPath,
      "finish",
    );
    assertEquals(isolateResult.code, 0, isolateResult.stderr);
    const narrow = await waitForJson(resultPath) as Record<string, unknown>;
    assertEquals(narrow.credential_type, "agent");
    assertEquals(narrow.broader_ancestor_pid, inherited.anchor_pid);
    assert(narrow.anchor_pid !== narrow.broader_ancestor_pid);
    assertEquals(narrow.work_code, 1);
    assertEquals(narrow.work_error, "authorization_insufficient");
    assertEquals(narrow.denied_code, 1);
    assertEquals(narrow.denied_error, "authorization_insufficient");
    assertEquals(narrow.revoked_code, 0);
    assertEquals(narrow.invalid_stop_error, "internal_error");
    assertEquals(
      await authContextCount(harness) - contextsBefore,
      6,
      "one denied work request plus watch ticket, redeem, request, decision, and revoke; no broader credential retry",
    );

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

async function authContextCount(harness: LiveHarness): Promise<number> {
  const result = await query<{ count: number }>(
    harness.server.sql,
    `select count(*)::int count from auth_contexts`,
  );
  return result.rows[0].count;
}

async function runHelper(
  helper: string,
  harness: LiveHarness,
  requestPath: string,
  resultPath: string,
  mode: string,
) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--allow-run=${harness.binaryPath}`,
      "--allow-read",
      "--allow-write",
      "--allow-env",
      helper,
      harness.binaryPath,
      harness.baseUrl,
      requestPath,
      resultPath,
      mode,
    ],
    env: {
      ...Deno.env.toObject(),
      HOME: harness.homeDir,
      XDG_CONFIG_HOME: join(harness.rootDir, "xdg-config"),
      XDG_STATE_HOME: join(harness.rootDir, "xdg-state"),
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
      const env = {
        HOME: Deno.env.get("HOME"),
        XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
        XDG_STATE_HOME: Deno.env.get("XDG_STATE_HOME"),
      };
      if (mode === "request" || mode === "status-stop") {
        env.OPERANT_AUTH_TREE_STOP_PID = String(Deno.pid);
      }
      const output = await new Deno.Command(binary, {
        args: ["--server", server, "--json", ...args],
        clearEnv: true,
        env,
        stdout: "piped", stderr: "piped",
      }).output();
      return { code: output.code, stdout: new TextDecoder().decode(output.stdout), stderr: new TextDecoder().decode(output.stderr) };
    };
    if (mode === "status-stop") {
      const status = await run(["auth", "status"]);
      if (status.code !== 0) throw new Error(status.stderr);
      await Deno.writeTextFile(resultPath, JSON.stringify(JSON.parse(status.stdout).data));
      Deno.exit(0);
    }
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
      clearEnv: true,
      env: {
        HOME: Deno.env.get("HOME"),
        XDG_CONFIG_HOME: Deno.env.get("XDG_CONFIG_HOME"),
        XDG_STATE_HOME: Deno.env.get("XDG_STATE_HOME"),
        OPERANT_AUTH_TREE_STOP_PID: "2147483647",
      },
      stdout: "piped", stderr: "piped",
    }).output();
    const invalidStopBody = JSON.parse(new TextDecoder().decode(invalidStop.stderr));
    const revoked = await run(["auth", "revoke", status.authorization_id]);
    await Deno.writeTextFile(resultPath, JSON.stringify({
      credential_type: status.credential_type,
      anchor_pid: status.anchor_pid,
      broader_ancestor_pid: Deno.ppid,
      work_code: allowed.code,
      work_error: JSON.parse(allowed.stderr).error.code,
      denied_code: denied.code,
      denied_error: JSON.parse(denied.stderr).error.code,
      revoked_code: revoked.code,
      invalid_stop_error: invalidStopBody.error.code,
    }));
  `;
}
