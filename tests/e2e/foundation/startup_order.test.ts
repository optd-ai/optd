import {
  findPostgresBins,
} from "../../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { startServer } from "../../../src/main_server.ts";

const READINESS_TIMEOUT_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 5_000;

function assert(condition: boolean, message: string): asserts condition {
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

async function withDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Capture = {
  readonly text: string;
  readonly completion: Promise<void>;
  cancel(): Promise<void>;
};

function captureStream(
  stream: ReadableStream<Uint8Array>,
  onText?: (text: string) => void,
): Capture {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  let cancelling = false;
  const completion = (async () => {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        text += chunk.value;
        onText?.(text);
      }
    } catch (error) {
      if (!cancelling) throw error;
    } finally {
      reader.releaseLock();
    }
  })();
  return {
    get text() {
      return text;
    },
    completion,
    async cancel() {
      cancelling = true;
      await reader.cancel().catch(() => undefined);
      await completion.catch(() => undefined);
    },
  };
}

async function readOptional(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    return `<unavailable: ${error instanceof Error ? error.message : error}>`;
  }
}

async function processEvidence(
  phase: string,
  child: Deno.ChildProcess,
  root: string,
  stdout: Capture,
  stderr: Capture,
  status: Deno.CommandStatus | undefined,
): Promise<string> {
  const postmasterPidText = (await readOptional(
    `${root}/postgres/data/postmaster.pid`,
  )).split(/\r?\n/, 1)[0];
  const postmasterPid = /^\d+$/.test(postmasterPidText)
    ? Number(postmasterPidText)
    : undefined;
  const parts = [
    `phase=${phase}`,
    `child_pid=${child.pid}`,
    `status=${status ? JSON.stringify(status) : "pending"}`,
    `root=${root}`,
    `--- stdout ---\n${stdout.text}`,
    `--- stderr ---\n${stderr.text}`,
    `--- /proc/${child.pid}/status ---\n${await readOptional(
      `/proc/${child.pid}/status`,
    )}`,
    `--- /proc/${child.pid}/wchan ---\n${await readOptional(
      `/proc/${child.pid}/wchan`,
    )}`,
    `--- /proc/${child.pid}/children ---\n${await readOptional(
      `/proc/${child.pid}/task/${child.pid}/children`,
    )}`,
    `--- postmaster.pid ---\n${postmasterPidText}`,
  ];
  if (postmasterPid !== undefined) {
    parts.push(
      `--- /proc/${postmasterPid}/status ---\n${await readOptional(
        `/proc/${postmasterPid}/status`,
      )}`,
      `--- /proc/${postmasterPid}/wchan ---\n${await readOptional(
        `/proc/${postmasterPid}/wchan`,
      )}`,
    );
  }
  return parts.join("\n");
}

async function killForCleanup(
  child: Deno.ChildProcess,
  statusPromise: Promise<Deno.CommandStatus>,
  root: string,
  stdout: Capture,
  stderr: Capture,
): Promise<void> {
  try {
    Deno.kill(child.pid, "SIGKILL");
  } catch {
    // Already reaped or exiting normally.
  }
  const postmasterPidText = (await readOptional(
    `${root}/postgres/data/postmaster.pid`,
  )).split(/\r?\n/, 1)[0];
  if (/^\d+$/.test(postmasterPidText)) {
    try {
      Deno.kill(Number(postmasterPidText), "SIGKILL");
    } catch {
      // The graceful server shutdown already reaped managed PostgreSQL.
    }
  }
  await withDeadline(
    statusPromise.catch((): Deno.CommandStatus => ({
      success: false,
      code: 1,
      signal: null,
    })),
    CLEANUP_TIMEOUT_MS,
    `failed to reap server child ${child.pid}`,
  ).catch(() => undefined);
  await Promise.all([stdout.cancel(), stderr.cancel()]);
}

function startCpuLoad(): {
  child: Deno.ChildProcess;
  status: Promise<Deno.CommandStatus>;
} {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      "let value = 1; while (true) value = Math.imul(value, 1664525) + 1013904223;",
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  return { child, status: child.status };
}

async function stopCpuLoad(load: ReturnType<typeof startCpuLoad>) {
  try {
    Deno.kill(load.child.pid, "SIGKILL");
  } catch {
    // Already stopped.
  }
  await load.status.catch(() => undefined);
}

Deno.test("startup failure precedes readiness for fixed and ephemeral ports", async () => {
  for (const port of [String(freePort()), "0"]) {
    const root = await Deno.makeTempDir({ prefix: "optd-startup-fault-" });
    try {
      await Deno.writeTextFile(`${root}/runtime`, "not a directory");
      const output = await serverCommand({
        OPTD_DATA_DIR: root,
        OPTD_HOST: "127.0.0.1",
        OPTD_PORT: port,
      }).output();
      const stdout = new TextDecoder().decode(output.stdout);
      const stderr = new TextDecoder().decode(output.stderr);
      const evidence = `phase=startup_failure status=${
        JSON.stringify(output)
      }\nstdout=${stdout}\nstderr=${stderr}`;
      assert(output.code === 1, evidence);
      assert(!stdout.includes("server_listening"), evidence);
      assert(stderr.includes('"event":"startup_failed"'), evidence);
      assert(!stderr.includes("not a directory\nnot a directory"), evidence);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  }
});

Deno.test({
  name:
    "ephemeral-port readiness arms immediate graceful shutdown under CPU contention",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (!await findPostgresBins()) {
      console.log(
        "PostgreSQL binaries unavailable; valid startup is exercised in the Nix integration partition",
      );
      return;
    }
    const configuredRepetitions = Number(
      Deno.env.get("OPTD_STARTUP_SIGNAL_REPETITIONS") ?? "4",
    );
    assert(
      Number.isInteger(configuredRepetitions) && configuredRepetitions >= 2 &&
        configuredRepetitions <= 100,
      `invalid OPTD_STARTUP_SIGNAL_REPETITIONS=${configuredRepetitions}`,
    );
    const load = startCpuLoad();
    try {
      for (let iteration = 1; iteration <= configuredRepetitions; iteration++) {
        const root = await Deno.makeTempDir({
          prefix: `optd-startup-zero-${iteration}-`,
        });
        const child = serverCommand({
          OPTD_DATA_DIR: root,
          OPTD_HOST: "127.0.0.1",
          OPTD_PORT: "0",
          OPTD_PG_PORT: String(freePort()),
          OPTD_BOOTSTRAP_TOKEN: masterKey(),
          OPTD_MASTER_KEY: masterKey(),
        }).spawn();
        let settledStatus: Deno.CommandStatus | undefined;
        const statusPromise = child.status.then((status) => {
          settledStatus = status;
          return status;
        });
        let readinessResolve!: () => void;
        const readiness = new Promise<void>((resolve) => {
          readinessResolve = resolve;
        });
        const stdout = captureStream(child.stdout, (text) => {
          if (text.includes('"event":"server_listening"')) readinessResolve();
        });
        const stderr = captureStream(child.stderr);
        let phase = "awaiting_readiness";
        try {
          try {
            await withDeadline(
              readiness,
              READINESS_TIMEOUT_MS,
              "server readiness timed out",
            );
          } catch (error) {
            throw new Error(
              `${
                error instanceof Error ? error.message : error
              }\n${await processEvidence(
                phase,
                child,
                root,
                stdout,
                stderr,
                settledStatus,
              )}`,
            );
          }
          const runtimeIndex = stdout.text.indexOf('"event":"runtime_started"');
          const listeningIndex = stdout.text.indexOf(
            '"event":"server_listening"',
          );
          assert(
            runtimeIndex >= 0 && runtimeIndex < listeningIndex,
            await processEvidence(
              phase,
              child,
              root,
              stdout,
              stderr,
              settledStatus,
            ),
          );
          const readinessLine = stdout.text.split(/\r?\n/).find((line) =>
            line.includes('"event":"server_listening"')
          );
          assert(
            readinessLine !== undefined,
            await processEvidence(
              phase,
              child,
              root,
              stdout,
              stderr,
              settledStatus,
            ),
          );
          const listening = new URL(JSON.parse(readinessLine).listening);
          assert(
            listening.hostname === "127.0.0.1" &&
              Number(listening.port) > 0,
            `invalid actual ephemeral URL ${listening}\n${await processEvidence(
              phase,
              child,
              root,
              stdout,
              stderr,
              settledStatus,
            )}`,
          );

          phase = "awaiting_shutdown";
          Deno.kill(child.pid, "SIGTERM");
          let status: Deno.CommandStatus;
          try {
            [status] = await withDeadline(
              Promise.all([
                statusPromise,
                stdout.completion,
                stderr.completion,
              ]),
              SHUTDOWN_TIMEOUT_MS,
              "server shutdown timed out",
            );
          } catch (error) {
            throw new Error(
              `${
                error instanceof Error ? error.message : error
              }\n${await processEvidence(
                phase,
                child,
                root,
                stdout,
                stderr,
                settledStatus,
              )}`,
            );
          }
          const evidence = await processEvidence(
            "shutdown_settled",
            child,
            root,
            stdout,
            stderr,
            status,
          );
          assert(status.success && status.code === 0, evidence);
          assert(
            stdout.text.includes('"event":"shutdown_requested"'),
            evidence,
          );
          assert(stdout.text.includes('"event":"shutdown_complete"'), evidence);
          assert(!stderr.text.includes('"event":"startup_failed"'), evidence);
        } finally {
          await killForCleanup(child, statusPromise, root, stdout, stderr);
          await Deno.remove(root, { recursive: true }).catch(() => undefined);
        }
      }
    } finally {
      await stopCpuLoad(load);
    }
  },
});

Deno.test({
  name: "programmatic startServer preserves its actual ephemeral listen URL",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (!await findPostgresBins()) return;
    const root = await Deno.makeTempDir({ prefix: "optd-start-server-" });
    const names = [
      "OPTD_DATA_DIR",
      "OPTD_PG_PORT",
      "OPTD_BOOTSTRAP_TOKEN",
      "OPTD_MASTER_KEY",
    ] as const;
    const previous = new Map(names.map((name) => [name, Deno.env.get(name)]));
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      Deno.env.set("OPTD_DATA_DIR", root);
      Deno.env.set("OPTD_PG_PORT", String(freePort()));
      Deno.env.set("OPTD_BOOTSTRAP_TOKEN", masterKey());
      Deno.env.set("OPTD_MASTER_KEY", masterKey());
      let callbackUrl: string | undefined;
      server = await startServer({
        hostname: "127.0.0.1",
        port: 0,
        onListen: (url) => callbackUrl = url,
      });
      assert(callbackUrl === server.url, `${callbackUrl} !== ${server.url}`);
      const actual = new URL(server.url);
      assert(actual.hostname === "127.0.0.1", server.url);
      assert(Number(actual.port) > 0, server.url);
    } finally {
      await server?.shutdown().catch(() => undefined);
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});
