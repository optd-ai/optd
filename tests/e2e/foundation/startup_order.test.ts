import { findPostgresBins } from "../../../src/adapters/outbound/postgres-process/lifecycle.ts";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    return (listener.addr as Deno.NetAddr).port;
  } finally {
    listener.close();
  }
}

function masterKey(): string {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
}

function serverCommand(env: Record<string, string>): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/main_server.ts"],
    cwd: Deno.cwd(),
    env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
}

Deno.test("startup failure precedes readiness for fixed and ephemeral ports", async () => {
  for (const port of [String(freePort()), "0"]) {
    const root = await Deno.makeTempDir({ prefix: "operant-startup-fault-" });
    await Deno.writeTextFile(`${root}/runtime`, "not a directory");
    const output = await serverCommand({
      OPERANT_DATA_DIR: root,
      OPERANT_HOST: "127.0.0.1",
      OPERANT_PORT: port,
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assert(output.code === 1, `expected startup exit 1, got ${output.code}`);
    assert(
      !stdout.includes("server_listening"),
      `premature readiness: ${stdout}`,
    );
    assert(stderr.includes('"event":"startup_failed"'), stderr);
    assert(!stderr.includes("not a directory\nnot a directory"), stderr);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test({
  name:
    "ephemeral-port process announces readiness only after runtime preparation",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (!await findPostgresBins()) {
      console.log(
        "PostgreSQL binaries unavailable; valid startup is exercised in the Nix integration partition",
      );
      return;
    }
    const root = await Deno.makeTempDir({ prefix: "operant-startup-zero-" });
    const child = serverCommand({
      OPERANT_DATA_DIR: root,
      OPERANT_HOST: "127.0.0.1",
      OPERANT_PORT: "0",
      OPERANT_PG_PORT: String(freePort()),
      OPERANT_BOOTSTRAP_TOKEN: masterKey(),
      OPERANT_MASTER_KEY: masterKey(),
    }).spawn();
    const stderrPromise = new Response(child.stderr).text();
    const reader = child.stdout.pipeThrough(new TextDecoderStream())
      .getReader();
    let stdout = "";
    try {
      const deadline = Date.now() + 60_000;
      while (!stdout.includes('"event":"server_listening"')) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("server readiness timed out");
        let timer: ReturnType<typeof setTimeout> | undefined;
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("server readiness timed out")),
              remaining,
            );
          }),
        ]).finally(() => timer === undefined ? undefined : clearTimeout(timer));
        if (chunk.done) break;
        stdout += chunk.value;
      }
      assert(stdout.includes('"event":"server_listening"'), stdout);
      const runtimeIndex = stdout.indexOf('"event":"runtime_started"');
      const listeningIndex = stdout.indexOf('"event":"server_listening"');
      assert(runtimeIndex >= 0 && runtimeIndex < listeningIndex, stdout);
      Deno.kill(child.pid, "SIGTERM");
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        stdout += chunk.value;
      }
      const status = await child.status;
      const stderr = await stderrPromise;
      assert(
        status.success,
        `server exit ${status.code}: ${stderr}\n${stdout}`,
      );
      assert(!stderr.includes('"event":"startup_failed"'), stderr);
    } finally {
      reader.releaseLock();
      try {
        Deno.kill(child.pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
      await child.status.catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});
