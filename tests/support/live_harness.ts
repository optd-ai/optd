import { assertEquals } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";
import { join } from "jsr:@std/path";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { sha256Hex } from "../../src/domain/ids/canonical_json.ts";
import {
  closePostgresClient,
  createPostgresClient,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";

export type CliResult = {
  argv: string[];
  code: number;
  stdout: string;
  stderr: string;
  startedAt: number;
  durationMs: number;
};

export type LiveHarness = {
  rootDir: string;
  dataDir: string;
  homeDir: string;
  baseUrl: string;
  binaryPath: string;
  /** Test-support SQL is only for focused setup/assertions, never acceptance actions. */
  server: { sql: Sql };
  runOptctl(args: string[]): Promise<CliResult>;
  restart(): Promise<void>;
  diagnostics(): Promise<{ server: string }>;
  close(options?: { retain?: boolean }): Promise<void>;
};

type RunningServer = {
  process: Deno.ChildProcess;
  url: string;
  log: WritableStreamDefaultWriter<Uint8Array>;
};

export async function startLiveHarness(
  options: { externalDatabaseUrl?: string } = {},
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
  env.OPERANT_PORT = "0";
  env.OPERANT_PG_PORT = String(freePort());
  env.OPERANT_HOST = "127.0.0.1";
  env.HOME = homeDir;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_STATE_HOME = xdgState;
  env.OPERANT_BOOTSTRAP_TOKEN = randomSecret(32);
  env.OPERANT_MASTER_KEY = randomSecret(32);
  if (options.externalDatabaseUrl) {
    env.OPERANT_DATABASE_URL = options.externalDatabaseUrl;
  } else delete env.OPERANT_DATABASE_URL;

  let running = await launchServer(rootDir, env);
  const databaseUrl = options.externalDatabaseUrl ??
    `postgres://operant@127.0.0.1:${env.OPERANT_PG_PORT}/postgres`;
  const sql = createPostgresClient(databaseUrl);
  const harness: LiveHarness = {
    rootDir,
    dataDir,
    homeDir,
    baseUrl: running.url,
    binaryPath,
    server: { sql },
    async runOptctl(args) {
      const argv = ["--server", running.url, ...args];
      const startedAt = Date.now();
      const output = await new Deno.Command(binaryPath, {
        args: argv,
        env,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return {
        argv,
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout).trimEnd(),
        stderr: new TextDecoder().decode(output.stderr).trimEnd(),
        startedAt,
        durationMs: Date.now() - startedAt,
      };
    },
    async restart() {
      await stopServer(running);
      running = await launchServer(rootDir, env);
      harness.baseUrl = running.url;
    },
    async diagnostics() {
      return {
        server: await Deno.readTextFile(join(rootDir, "server.log")).catch(() =>
          ""
        ),
      };
    },
    async close(closeOptions = {}) {
      await closePostgresClient(sql).catch(() => undefined);
      await stopServer(running);
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
  const temporary = `${binary}.${Deno.pid}.${crypto.randomUUID()}`;
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "compile",
      "--allow-read",
      "--allow-env",
      "--allow-net",
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
  const logFile = await Deno.open(join(rootDir, "server.log"), {
    create: true,
    append: true,
    write: true,
    mode: 0o600,
  });
  const log = logFile.writable.getWriter();
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
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("server startup timed out")),
          Math.max(1, deadline - Date.now()),
        )
      ),
    ]);
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
          void pump(reader, log);
          void pipeToLog(process.stderr, log);
          return { process, url: message.listening, log };
        }
      } catch {
        // Non-JSON startup diagnostics remain in the log.
      }
    }
  }
  throw new Error("server startup timed out");
}

async function pump(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  writer: WritableStreamDefaultWriter<Uint8Array>,
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
  writer: WritableStreamDefaultWriter<Uint8Array>,
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
  await Promise.race([
    server.process.status,
    new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
  ]);
  try {
    server.process.kill("SIGKILL");
  } catch {
    // Already exited.
  }
  await server.process.status.catch(() => undefined);
  await server.log.close().catch(() => undefined);
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
