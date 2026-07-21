// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";
import { join } from "jsr:@std/path";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { sha256Hex } from "../../src/domain/ids/canonical_json.ts";
import { FilesystemLocalAuthStore } from "../../src/adapters/outbound/local-auth-store/filesystem.ts";
import { LinuxProcessInspector } from "../../src/adapters/outbound/process-inspection/linux.ts";
import {
  closePostgresClient,
  createPostgresClient,
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";

export type CliResult = {
  argv: string[];
  code: number;
  signal: Deno.Signal | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  durationMs: number;
};

export type BootstrapInput = {
  username: string;
  password: string;
  displayName?: string;
};
export type LoginInput = { username: string; password: string };
export type ProcessTreeKind = "human" | "request_only" | "agent";
export type CliLauncher = {
  kind: ProcessTreeKind;
  runOptctl(args: string[], stdin?: string): Promise<CliResult>;
  close(): Promise<void>;
};
export type ConcurrentCliRequest = {
  args: string[];
  stdin?: string;
  launcher?: CliLauncher;
};
export type ProcessLaunchResult = {
  result: CliResult;
  launcher: CliLauncher;
};
export type HarnessDiagnostics = {
  server: string;
  postgres: string;
  hooks: string;
};

export type LiveHarness = {
  rootDir: string;
  dataDir: string;
  homeDir: string;
  baseUrl: string;
  databaseUrl: string;
  binaryPath: string;
  /** Test-support SQL is only for focused setup/assertions, never acceptance actions. */
  server: { sql: Sql };
  runOptctl(args: string[], stdin?: string): Promise<CliResult>;
  bootstrap(input: BootstrapInput): Promise<CliResult>;
  login(input: LoginInput): Promise<CliResult>;
  bootstrapProcess(input: BootstrapInput): Promise<ProcessLaunchResult>;
  loginProcess(input: LoginInput): Promise<ProcessLaunchResult>;
  selectProject(projectId: string, launcher?: CliLauncher): Promise<CliResult>;
  runJson(
    args: string[],
    input: unknown,
    launcher?: CliLauncher,
  ): Promise<CliResult>;
  runMultipart(
    args: string[],
    directory: string,
    launcher?: CliLauncher,
  ): Promise<CliResult>;
  createProcessTreeLauncher(kind: ProcessTreeKind): Promise<CliLauncher>;
  createAgentLauncher(): Promise<CliLauncher>;
  runConcurrent(requests: ConcurrentCliRequest[]): Promise<CliResult[]>;
  restart(options?: {
    bootstrapToken?: string | null;
    environment?: Record<string, string | null>;
  }): Promise<void>;
  diagnostics(): Promise<HarnessDiagnostics>;
  close(options?: { retain?: boolean }): Promise<void>;
};

type LogSink = {
  write(bytes: Uint8Array): Promise<void>;
  text(): string;
  close(): Promise<void>;
};
type RunningServer = {
  process: Deno.ChildProcess;
  url: string;
  log: LogSink;
  pumps: Promise<void>[];
};

const MAX_DIAGNOSTIC_BYTES = 1024 * 1024;

export async function startLiveHarness(
  options: {
    externalDatabaseUrl?: string;
    bootstrapToken?: string | null;
    environment?: Record<string, string | null>;
  } = {},
): Promise<LiveHarness> {
  if (!options.externalDatabaseUrl && !await findPostgresBins()) {
    throw new Error(
      "SKIP: real Postgres binaries unavailable; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
  }

  const rootDir = await Deno.makeTempDir({ prefix: "operant-live-" });
  const dataDir = join(rootDir, "data");
  const homeDir = join(rootDir, "home");
  const xdgConfig = join(rootDir, "xdg-config");
  const xdgState = join(rootDir, "xdg-state");
  await Promise.all(
    [dataDir, homeDir, xdgConfig, xdgState].map((path) =>
      Deno.mkdir(path, { recursive: true, mode: 0o700 })
    ),
  );

  const binaryPath = await compileOptctl();
  const env = Deno.env.toObject();
  env.OPERANT_DATA_DIR = dataDir;
  env.OPERANT_PORT = String(freePort());
  env.OPERANT_PG_PORT = String(freePort());
  env.OPERANT_HOST = "127.0.0.1";
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_STATE_HOME = xdgState;
  if (options.bootstrapToken === null) delete env.OPERANT_BOOTSTRAP_TOKEN;
  else env.OPERANT_BOOTSTRAP_TOKEN = options.bootstrapToken ?? randomSecret(32);
  env.OPERANT_MASTER_KEY = randomSecret(32);
  if (options.externalDatabaseUrl) {
    env.OPERANT_DATABASE_URL = options.externalDatabaseUrl;
  } else delete env.OPERANT_DATABASE_URL;
  applyEnvironment(env, options.environment);

  let running: RunningServer;
  try {
    running = await launchServer(rootDir, env);
  } catch (error) {
    const startupLog = await Deno.readTextFile(join(rootDir, "server.log"))
      .catch(() => "");
    await Deno.remove(rootDir, { recursive: true }).catch(() => undefined);
    throw new Error(
      `${
        error instanceof Error ? error.message : String(error)
      }\n${startupLog}`,
    );
  }
  let serverRunning = true;
  const legacyAuthBridge = testAuthStoreBridge(
    homeDir,
    xdgConfig,
    () => running.url,
  );
  const databaseUrl = options.externalDatabaseUrl ??
    `postgres://operant@127.0.0.1:${env.OPERANT_PG_PORT}/postgres`;
  const sql = createPostgresClient(databaseUrl);
  const launchers = new Set<CliLauncher>();
  const runBinary = async (
    args: string[],
    stdin?: string,
  ): Promise<CliResult> => {
    const argv = ["--server", running.url, ...args];
    const startedAt = Date.now();
    await legacyAuthBridge.before(Deno.pid);
    const child = new Deno.Command(binaryPath, {
      args: argv,
      env,
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    }
    const result = cliResult(argv, startedAt, await child.output());
    await legacyAuthBridge.after(Deno.pid);
    return result;
  };
  const harness: LiveHarness = {
    rootDir,
    dataDir,
    homeDir,
    baseUrl: running.url,
    databaseUrl,
    binaryPath,
    server: { sql },
    runOptctl: runBinary,
    async bootstrap(input) {
      return await runBinary([
        "bootstrap",
        "init",
        "--username",
        input.username,
        "--password-stdin",
        ...input.displayName ? ["--display-name", input.displayName] : [],
      ], `${input.password}\n`);
    },
    async login(input) {
      return await runBinary([
        "auth",
        "login",
        "--username",
        input.username,
        "--password-stdin",
      ], `${input.password}\n`);
    },
    async bootstrapProcess(input) {
      const launcher = await harness.createProcessTreeLauncher("human");
      try {
        const result = await launcher.runOptctl([
          "--json",
          "bootstrap",
          "init",
          "--username",
          input.username,
          "--password-stdin",
          ...input.displayName ? ["--display-name", input.displayName] : [],
        ], `${input.password}\n`);
        return { result, launcher };
      } catch (error) {
        await launcher.close();
        throw error;
      }
    },
    async loginProcess(input) {
      const launcher = await harness.createProcessTreeLauncher("human");
      try {
        const result = await launcher.runOptctl([
          "--json",
          "auth",
          "login",
          "--username",
          input.username,
          "--password-stdin",
        ], `${input.password}\n`);
        return { result, launcher };
      } catch (error) {
        await launcher.close();
        throw error;
      }
    },
    async selectProject(projectId, launcher) {
      const run = launcher?.runOptctl ?? runBinary;
      return await run(["project", "select", projectId]);
    },
    async runJson(args, input, launcher) {
      const inputDir = join(rootDir, "inputs");
      await Deno.mkdir(inputDir, { recursive: true, mode: 0o700 });
      const path = join(inputDir, `${crypto.randomUUID()}.json`);
      await Deno.writeTextFile(path, JSON.stringify(input), {
        createNew: true,
        mode: 0o600,
      });
      const run = launcher?.runOptctl ?? runBinary;
      return await run([...args, "--file", path]);
    },
    async runMultipart(args, directory, launcher) {
      const stat = await Deno.stat(directory);
      if (!stat.isDirectory) {
        throw new TypeError("multipart input must be a directory");
      }
      const run = launcher?.runOptctl ?? runBinary;
      return await run([...args, directory]);
    },
    async createProcessTreeLauncher(kind) {
      const launcher = await makeProcessTreeLauncher(
        kind,
        binaryPath,
        env,
        () => running.url,
        legacyAuthBridge,
      );
      launchers.add(launcher);
      return {
        ...launcher,
        async close() {
          launchers.delete(launcher);
          await launcher.close();
        },
      };
    },
    async createAgentLauncher() {
      return await harness.createProcessTreeLauncher("agent");
    },
    async runConcurrent(requests) {
      return await Promise.all(
        requests.map(({ args, stdin, launcher }) =>
          launcher ? launcher.runOptctl(args, stdin) : runBinary(args, stdin)
        ),
      );
    },
    async restart(restartOptions = {}) {
      if (restartOptions.bootstrapToken === null) {
        delete env.OPERANT_BOOTSTRAP_TOKEN;
      } else if (restartOptions.bootstrapToken !== undefined) {
        env.OPERANT_BOOTSTRAP_TOKEN = restartOptions.bootstrapToken;
      }
      applyEnvironment(env, restartOptions.environment);
      if (serverRunning) {
        await stopServer(running);
        serverRunning = false;
      }
      try {
        running = await launchServer(rootDir, env);
        serverRunning = true;
        harness.baseUrl = running.url;
      } catch (error) {
        const startupLog = await Deno.readTextFile(join(rootDir, "server.log"))
          .catch(() => "");
        throw new Error(
          `${
            error instanceof Error ? error.message : String(error)
          }\n${startupLog}`,
        );
      }
    },
    async diagnostics() {
      const serverLog = running.log.text();
      const hookRows = await queryHookDiagnostics(sql);
      return {
        server: serverLog,
        postgres: postgresLines(serverLog),
        hooks: hookRows,
      };
    },
    async close(closeOptions = {}) {
      await Promise.all(
        [...launchers].map((launcher) =>
          launcher.close().catch(() => undefined)
        ),
      );
      launchers.clear();
      await closePostgresClient(sql).catch(() => undefined);
      if (serverRunning) await stopServer(running);
      if (!closeOptions.retain) {
        await Deno.remove(rootDir, { recursive: true }).catch(() => undefined);
      }
    },
  };
  return harness;
}

export async function assertHealth(baseUrl: string) {
  const response = await fetch(`${baseUrl}/ready`);
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.ok, true);
  assertEquals(body.data.status, "ready");
  return body;
}

async function compileOptctl(): Promise<string> {
  const cat = await Deno.stat("/bin/cat").catch(() => undefined);
  if (!cat?.isFile || ((cat.mode ?? 0) & 0o111) === 0) {
    throw new Error(
      "compiled Linux process inspection requires reviewed executable /bin/cat",
    );
  }
  const digest = await sourceDigest();
  const cacheDir = join(
    Deno.env.get("TMPDIR") ?? "/tmp",
    "operant-optctl-cache",
    digest,
  );
  const binary = join(cacheDir, "optctl");
  try {
    await Deno.stat(binary);
    return binary;
  } catch {
    // Compile below.
  }
  await Deno.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const compileLock = `${binary}.compile-lock`;
  let ownsLock = false;
  try {
    await Deno.mkdir(compileLock, { mode: 0o700 });
    ownsLock = true;
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  if (!ownsLock) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      try {
        const ready = await Deno.stat(binary);
        if (ready.isFile && ((ready.mode ?? 0) & 0o111) !== 0) return binary;
      } catch { /* compiler still owns the cache entry */ }
      const lock = await Deno.stat(compileLock).catch(() => undefined);
      if (lock?.mtime && Date.now() - lock.mtime.getTime() > 180_000) {
        await Deno.remove(compileLock, { recursive: true }).catch(() =>
          undefined
        );
        return await compileOptctl();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("timed out waiting for the shared optctl compilation");
  }

  const temporary = `${binary}.${Deno.pid}.${crypto.randomUUID()}`;
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "compile",
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-run",
        "--allow-sys=uid",
        "--output",
        temporary,
        "src/main_optctl.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      throw new Error(
        `optctl compilation failed: ${new TextDecoder().decode(output.stderr)}`,
      );
    }
    try {
      await Deno.rename(temporary, binary);
    } catch (error) {
      await Deno.remove(temporary).catch(() => undefined);
      try {
        await Deno.stat(binary);
      } catch {
        throw error;
      }
    }
    return binary;
  } finally {
    await Deno.remove(temporary).catch(() => undefined);
    await Deno.remove(compileLock, { recursive: true }).catch(() => undefined);
  }
}

async function sourceDigest(): Promise<string> {
  const chunks: string[] = [];
  for await (
    const entry of walk("src", { includeDirs: false, followSymlinks: false })
  ) {
    chunks.push(entry.path);
  }
  chunks.push("deno.lock");
  chunks.sort();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (const path of chunks) {
    const bytes = await Deno.readFile(path);
    const prefix = new TextEncoder().encode(`${path}\0${bytes.length}\0`);
    parts.push(prefix, bytes);
    size += prefix.length + bytes.length;
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return await sha256Hex(all);
}

async function launchServer(
  rootDir: string,
  env: Record<string, string>,
): Promise<RunningServer> {
  const log = boundedLog(join(rootDir, "server.log"));
  const process = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      "--allow-run",
      "src/main_server.ts",
    ],
    env,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const reader = process.stdout.getReader();
  const stderrPump = pipeToLog(process.stderr, log);
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      const next = await raceWithTimeout(
        reader.read(),
        Math.max(1, deadline - Date.now()),
        "server startup timed out",
      );
      if (next.done) {
        throw new Error(
          `server exited during startup: ${await process.status.then((status) =>
            status.code
          )}`,
        );
      }
      await log.write(next.value);
      buffered += decoder.decode(next.value, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.ok === true && typeof message.listening === "string") {
            const stdoutPump = pump(reader, log);
            return {
              process,
              url: message.listening,
              log,
              pumps: [stdoutPump, stderrPump],
            };
          }
        } catch {
          // Non-JSON startup diagnostics remain in the bounded log.
        }
      }
    }
    throw new Error("server startup timed out");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    try {
      process.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await process.status.catch(() => undefined);
    await stderrPump.catch(() => undefined);
    await log.close();
    throw error;
  }
}

async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: Pick<LogSink, "write">,
) {
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      await writer.write(next.value);
    }
  } catch {
    // Process shutdown closes the streams.
  }
}

async function pipeToLog(
  stream: ReadableStream<Uint8Array>,
  writer: Pick<LogSink, "write">,
) {
  const reader = stream.getReader();
  await pump(reader, writer);
}

async function stopServer(server: RunningServer): Promise<void> {
  try {
    server.process.kill("SIGTERM");
  } catch {
    // Already exited.
  }
  const stopped = await raceWithTimeout(
    server.process.status.then(() => true),
    10_000,
    "server stop timed out",
  ).catch(() => false);
  if (!stopped) {
    try {
      server.process.kill("SIGKILL");
    } catch {
      // Already exited.
    }
  }
  await server.process.status.catch(() => undefined);
  await Promise.all(server.pumps.map((pump) => pump.catch(() => undefined)));
  await server.log.close().catch(() => undefined);
}

function applyEnvironment(
  target: Record<string, string>,
  changes: Record<string, string | null> | undefined,
): void {
  for (const [name, value] of Object.entries(changes ?? {})) {
    if (value === null) delete target[name];
    else target[name] = value;
  }
}

function randomSecret(bytes: number): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...value));
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

function cliResult(
  argv: string[],
  startedAt: number,
  output: Deno.CommandOutput,
): CliResult {
  return {
    argv,
    code: output.code,
    signal: output.signal,
    stdout: new TextDecoder().decode(output.stdout).trimEnd(),
    stderr: new TextDecoder().decode(output.stderr).trimEnd(),
    startedAt,
    durationMs: Date.now() - startedAt,
  };
}

async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedLog(path: string): LogSink {
  let bytes = new Uint8Array();
  let writes = Promise.resolve();
  return {
    async write(chunk) {
      writes = writes.then(() => {
        const combined = new Uint8Array(bytes.length + chunk.length);
        combined.set(bytes);
        combined.set(chunk, bytes.length);
        bytes = combined.length <= MAX_DIAGNOSTIC_BYTES
          ? combined
          : combined.slice(combined.length - MAX_DIAGNOSTIC_BYTES);
      });
      await writes;
    },
    text() {
      return new TextDecoder().decode(bytes);
    },
    async close() {
      await writes;
      await Deno.writeFile(path, bytes, { create: true, mode: 0o600 });
    },
  };
}

function postgresLines(log: string): string {
  return log.split("\n").filter((line) =>
    /postgres|database system|\b(?:LOG|FATAL|PANIC|WARNING):/i.test(line)
  ).join("\n").slice(-MAX_DIAGNOSTIC_BYTES);
}

async function queryHookDiagnostics(sql: Sql): Promise<string> {
  try {
    const rows = await query<Record<string, unknown>>(
      sql,
      `select id, hook, phase, status, duration_ms, exit_code,
              left(logs, 8192) as logs, error_json
         from hook_executions order by created_at desc limit 50`,
    );
    return JSON.stringify(rows.rows).slice(-MAX_DIAGNOSTIC_BYTES);
  } catch (error) {
    return `hook diagnostics unavailable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

// Earlier auth tests deliberately inject credentials/nonces through the former
// monolithic fixture file. Keep that capability test-only while production CLI
// acceptance uses the partitioned store directly.
function testAuthStoreBridge(
  homeDir: string,
  xdgConfig: string,
  serverUrl: () => string,
) {
  const inspector = new LinuxProcessInspector();
  const store = new FilesystemLocalAuthStore(
    join(homeDir, ".local", "share", "operant", "auth"),
    inspector,
  );
  const legacyPath = join(xdgConfig, "operant", "auth.json");
  let lastProjection: string | undefined;
  let lastProjectionMtime = 0;
  let queue = Promise.resolve();

  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return {
    before: (pid: number) =>
      serialized(async () => {
        let text: string;
        try {
          text = await Deno.readTextFile(legacyPath);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return;
          throw error;
        }
        const mtime = (await Deno.stat(legacyPath)).mtime?.getTime() ?? 0;
        if (text === lastProjection && mtime === lastProjectionMtime) return;
        const origin = new URL(serverUrl()).origin;
        const legacy = JSON.parse(text).origins?.[origin];
        if (!legacy) return;
        await store.updateState(origin, {
          ...legacy,
          token: typeof legacy.token === "string" ? legacy.token : undefined,
          requestToken: typeof legacy.requestToken === "string"
            ? legacy.requestToken
            : undefined,
        }, await inspector.inspect(pid));
      }),
    after: (pid: number) =>
      serialized(async () => {
        const origin = new URL(serverUrl()).origin;
        const state = await store.readState(origin);
        const selected = await store.select(origin, pid);
        const request = await store.requestCredential(origin);
        const prior = lastProjection
          ? JSON.parse(lastProjection).origins?.[origin]
          : undefined;
        const legacyRevokedToken = typeof state.authorizationId === "string" &&
            typeof prior?.token === "string"
          ? prior.token
          : undefined;
        const projection = JSON.stringify({
          origins: {
            [origin]: {
              ...state,
              ...(selected
                ? { token: selected.token }
                : legacyRevokedToken
                ? { token: legacyRevokedToken }
                : {}),
              ...(request ? { requestToken: request.token } : {}),
            },
          },
        });
        await Deno.mkdir(join(xdgConfig, "operant"), {
          recursive: true,
          mode: 0o700,
        });
        await Deno.writeTextFile(legacyPath, projection, { mode: 0o600 });
        await Deno.chmod(legacyPath, 0o600);
        lastProjection = projection;
        lastProjectionMtime = legacyRevokedToken
          ? 0
          : (await Deno.stat(legacyPath)).mtime?.getTime() ?? 0;
      }),
  };
}

// deno-lint-ignore require-await
export async function makeProcessTreeLauncher(
  kind: ProcessTreeKind,
  binaryPath: string,
  env: Record<string, string>,
  serverUrl: () => string,
  authBridge?: {
    before(pid: number): Promise<void>;
    after(pid: number): Promise<void>;
  },
): Promise<CliLauncher> {
  const worker = `
    const binary = Deno.args[0];
    let buffered = "";
    for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      while (true) {
        const end = buffered.indexOf("\\n");
        if (end < 0) break;
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.close) Deno.exit(0);
        const process = new Deno.Command(binary, {
          args: message.argv,
          stdin: message.stdin === undefined ? "null" : "piped",
          stdout: "piped",
          stderr: "piped",
        }).spawn();
        if (message.stdin !== undefined) {
          const writer = process.stdin.getWriter();
          await writer.write(new TextEncoder().encode(message.stdin));
          await writer.close();
        }
        const output = await process.output();
        console.log(JSON.stringify({
          code: output.code,
          signal: output.signal,
          stdout: new TextDecoder().decode(output.stdout),
          stderr: new TextDecoder().decode(output.stderr),
        }));
      }
    }
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", worker, binaryPath],
    env,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const input = child.stdin.getWriter();
  const output = child.stdout.getReader();
  const errorOutput = child.stderr.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let stderr = "";
  let queue = Promise.resolve<unknown>(undefined);
  let closed = false;
  let finalized: Promise<void> | undefined;

  const stderrPump = (async () => {
    try {
      while (true) {
        const next = await errorOutput.read();
        if (next.done) return;
        stderr += new TextDecoder().decode(next.value);
        if (stderr.length > MAX_DIAGNOSTIC_BYTES) {
          stderr = stderr.slice(-MAX_DIAGNOSTIC_BYTES);
        }
      }
    } catch {
      // Cancellation and process termination close the stream.
    }
  })();

  async function readLine(): Promise<string> {
    while (true) {
      const end = buffered.indexOf("\n");
      if (end >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        return line;
      }
      const next = await output.read();
      if (next.done) {
        await stderrPump;
        throw new Error(`process-tree launcher exited: ${stderr}`);
      }
      buffered += decoder.decode(next.value, { stream: true });
    }
  }

  function finalize(graceful: boolean, waitForQueue: boolean): Promise<void> {
    if (finalized) return finalized;
    closed = true;
    finalized = (async () => {
      if (waitForQueue) await queue.catch(() => undefined);
      if (graceful) {
        await input.write(new TextEncoder().encode('{"close":true}\n')).catch(
          () => undefined,
        );
      }
      await input.close().catch(() => undefined);
      const exited = await raceWithTimeout(
        child.status,
        5_000,
        "launcher stop timed out",
      ).then(() => true, () => false);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already exited.
        }
      }
      await child.status.catch(() => undefined);
      await output.cancel().catch(() => undefined);
      await errorOutput.cancel().catch(() => undefined);
      await stderrPump.catch(() => undefined);
    })();
    return finalized;
  }

  return {
    kind,
    async runOptctl(args, stdin) {
      if (closed) throw new Error("process-tree launcher is closed");
      const argv = ["--server", serverUrl(), ...args];
      const startedAt = Date.now();
      const operation = queue.then(async () => {
        await authBridge?.before(child.pid);
        await input.write(
          new TextEncoder().encode(`${JSON.stringify({ argv, stdin })}\n`),
        );
        const result = JSON.parse(await readLine()) as {
          code: number;
          signal: Deno.Signal | null;
          stdout: string;
          stderr: string;
        };
        await authBridge?.after(child.pid);
        return result;
      });
      queue = operation.then(() => undefined, () => undefined);
      try {
        const result = await operation;
        return {
          argv,
          code: result.code,
          signal: result.signal,
          stdout: result.stdout.trimEnd(),
          stderr: result.stderr.trimEnd(),
          startedAt,
          durationMs: Date.now() - startedAt,
        };
      } catch (error) {
        await finalize(false, false);
        throw error;
      }
    },
    close: () => finalize(true, true),
  };
}
