export const MIN_POSTGRES_MAJOR = 17;
const POSTGRES_STARTUP_TIMEOUT_MS = 30_000;

export type PostgresRuntimeMode = "external" | "app_managed";

export type PostgresRuntimePlan = {
  mode: PostgresRuntimeMode;
  databaseUrl?: string;
  dataDir?: string;
  pgBinDir?: string;
  binariesAvailable: boolean;
  skipReason?: string;
};

export type PostgresBinaries = {
  initdb: string;
  postgres: string;
  psql: string;
};

export type ManagedPostgres = {
  mode: "app_managed";
  dataDir: string;
  runDir: string;
  port: number;
  databaseUrl: string;
  process: Deno.ChildProcess;
};

export type PostgresRuntime =
  | { mode: "external"; databaseUrl: string; stop(): Promise<void> }
  | (ManagedPostgres & { stop(): Promise<void> });

export function planPostgresRuntime(
  env: Deno.Env = Deno.env,
): PostgresRuntimePlan {
  const databaseUrl = env.get("OPERANT_DATABASE_URL") ?? undefined;
  if (databaseUrl) {
    assertSupportedPostgresUrl(databaseUrl);
    return {
      mode: "external",
      databaseUrl,
      binariesAvailable: true,
    };
  }

  const pgBinDir = env.get("OPERANT_PG_BIN_DIR") ?? undefined;
  const dataDir = env.get("OPERANT_DATA_DIR") ?? undefined;
  return {
    mode: "app_managed",
    dataDir,
    pgBinDir,
    binariesAvailable: false,
  };
}

export async function assertPostgresLifecycleAvailable(
  env: Deno.Env = Deno.env,
): Promise<PostgresRuntimePlan> {
  const plan = planPostgresRuntime(env);
  if (plan.mode === "external") return plan;

  const bins = await findPostgresBins(env);
  if (!bins) {
    throw new Error(
      "postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
  }
  return { ...plan, binariesAvailable: true };
}

export async function startPostgresRuntime(
  env: Deno.Env = Deno.env,
): Promise<PostgresRuntime> {
  const databaseUrl = env.get("OPERANT_DATABASE_URL") ?? undefined;
  if (databaseUrl) {
    assertSupportedPostgresUrl(databaseUrl);
    return {
      mode: "external",
      databaseUrl,
      async stop() {},
    };
  }

  const rootDir = env.get("OPERANT_DATA_DIR") ?? ".operant-data";
  const managed = await startManagedPostgres(rootDir, env);
  return {
    ...managed,
    async stop() {
      await stopManagedPostgres(managed);
    },
  };
}

export async function findPostgresBins(
  env: Deno.Env = Deno.env,
): Promise<PostgresBinaries | null> {
  const binDir = env.get("OPERANT_PG_BIN_DIR");
  const candidates = binDir ? [binDir] : (env.get("PATH") ?? "").split(":");
  for (const dir of candidates.filter(Boolean)) {
    const initdb = `${dir}/initdb`;
    const postgres = `${dir}/postgres`;
    const psql = `${dir}/psql`;
    if (await exists(initdb) && await exists(postgres) && await exists(psql)) {
      return { initdb, postgres, psql };
    }
  }
  return null;
}

export async function startManagedPostgres(
  rootDir: string,
  env: Deno.Env = Deno.env,
): Promise<ManagedPostgres> {
  const bins = await findPostgresBins(env);
  if (!bins) {
    throw new Error(
      "postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
  }

  const dataDir = `${rootDir}/postgres/data`;
  const runDir = `${rootDir}/postgres/run`;
  await Deno.mkdir(runDir, { recursive: true });
  if (!await exists(`${dataDir}/PG_VERSION`)) {
    await runChecked(bins.initdb, [
      "-D",
      dataDir,
      "--no-locale",
      "--encoding=UTF8",
      "--auth=trust",
      "--username=operant",
    ]);
  }

  await removeDemonstrablyStalePostmasterPid(dataDir);

  const configuredPort = env.get("OPERANT_PG_PORT");
  const port = configuredPort && configuredPort !== "0"
    ? Number(configuredPort)
    : await freePort();
  const child = new Deno.Command(bins.postgres, {
    args: [
      "-D",
      dataDir,
      "-k",
      runDir,
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
    ],
    // Inherit into the server process so lifecycle owners can capture bounded
    // startup/runtime diagnostics instead of losing Postgres failures.
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();

  const managed: ManagedPostgres = {
    mode: "app_managed",
    dataDir,
    runDir,
    port,
    process: child,
    databaseUrl: `postgres://operant@127.0.0.1:${port}/postgres`,
  };

  try {
    await waitReady(bins.psql, managed);
  } catch (error) {
    await stopManagedPostgres(managed);
    throw error;
  }
  return managed;
}

export async function stopManagedPostgres(pg: ManagedPostgres): Promise<void> {
  try {
    pg.process.kill("SIGTERM");
  } catch {
    // Already stopped.
  }
  await pg.process.status.catch(() => undefined);
}

export function assertSupportedPostgresVersionNumber(
  serverVersionNum: string | number,
): number {
  const numeric = typeof serverVersionNum === "number"
    ? serverVersionNum
    : Number(serverVersionNum);
  const major = Math.floor(numeric / 10_000);
  if (
    !Number.isSafeInteger(numeric) || numeric <= 0 || major < MIN_POSTGRES_MAJOR
  ) {
    throw new Error(
      `unsupported PostgreSQL server version: Operant requires PostgreSQL ${MIN_POSTGRES_MAJOR} or newer`,
    );
  }
  return major;
}

export function assertSupportedPostgresUrl(databaseUrl: string): void {
  let protocol: string;
  try {
    protocol = new URL(databaseUrl).protocol;
  } catch {
    throw new Error(
      "OPERANT_DATABASE_URL must be a valid postgres:// or postgresql:// URL",
    );
  }
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error(
      "unsupported runtime database URL: MVP runtime is Postgres-only; PGlite, SQLite, file, and in-memory URLs are not allowed",
    );
  }
}

async function waitReady(psqlBin: string, pg: ManagedPostgres): Promise<void> {
  const started = Date.now();
  let last = "";
  // Recovery and checkpoint replay can legitimately exceed ten seconds on a
  // saturated release host. Keep this inner bound below the server's bounded
  // startup deadline instead of terminating a healthy postmaster mid-recovery.
  while (Date.now() - started < POSTGRES_STARTUP_TIMEOUT_MS) {
    const out = await new Deno.Command(psqlBin, {
      args: [
        "-h",
        "127.0.0.1",
        "-p",
        String(pg.port),
        "-d",
        "postgres",
        "-U",
        "operant",
        "-Atc",
        "select 1",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.success && new TextDecoder().decode(out.stdout).trim() === "1") {
      return;
    }
    last = new TextDecoder().decode(out.stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`postgres did not become ready: ${last}`);
}

async function runChecked(command: string, args: string[]): Promise<void> {
  const out = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

type PostmasterPidIdentity = "stale" | "live_same_data_dir";

async function removeDemonstrablyStalePostmasterPid(
  dataDir: string,
): Promise<void> {
  const pidPath = `${dataDir}/postmaster.pid`;
  let original: string;
  try {
    original = await Deno.readTextFile(pidPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw new Error(`cannot safely inspect ${pidPath}`, { cause: error });
  }

  const pidText = original.split(/\r?\n/, 1)[0];
  if (!/^[1-9][0-9]*$/.test(pidText)) {
    throw new Error(`refusing to remove malformed ${pidPath}`);
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid)) {
    throw new Error(`refusing to remove malformed ${pidPath}`);
  }

  for (let inspection = 0; inspection < 2; inspection++) {
    const identity = await inspectPostmasterPid(pid, dataDir, pidPath);
    if (identity === "live_same_data_dir") {
      throw new Error(
        `refusing to start app-managed PostgreSQL: ${pidPath} identifies a live PostgreSQL server for this data directory (PID ${pid})`,
      );
    }
    let current: string;
    try {
      current = await Deno.readTextFile(pidPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw new Error(`cannot safely recheck ${pidPath}`, { cause: error });
    }
    if (current !== original) {
      throw new Error(`refusing to remove changed ${pidPath}`);
    }
  }

  await Deno.remove(pidPath);
}

async function inspectPostmasterPid(
  pid: number,
  dataDir: string,
  pidPath: string,
): Promise<PostmasterPidIdentity> {
  const procDir = `/proc/${pid}`;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(`${procDir}/cmdline`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "stale";
    const output = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        'if [ ! -d "$1" ]; then exit 2; fi; exec /bin/cat "$1/cmdline"',
        "sh",
        procDir,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (output.success) bytes = output.stdout;
    else {
      if (output.code === 2) return "stale";
      throw new Error(
        `refusing to remove ${pidPath}: process identity for PID ${pid} is unreadable`,
        { cause: error },
      );
    }
  }
  if (bytes.length === 0) {
    throw new Error(
      `refusing to remove ${pidPath}: process identity for PID ${pid} is unreadable`,
    );
  }

  const argv = new TextDecoder().decode(bytes).split("\0").filter(Boolean);
  const executable = argv[0]?.split("/").at(-1);
  if (executable !== "postgres") return "stale";

  const candidates: string[] = [];
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === "-D") {
      if (!argv[index + 1]) {
        throw new Error(
          `refusing to remove ${pidPath}: PostgreSQL data-directory identity for PID ${pid} is ambiguous`,
        );
      }
      candidates.push(argv[++index]);
    } else if (argv[index].startsWith("-D") && argv[index].length > 2) {
      candidates.push(argv[index].slice(2));
    }
  }
  if (candidates.length !== 1) {
    throw new Error(
      `refusing to remove ${pidPath}: PostgreSQL data-directory identity for PID ${pid} is ambiguous`,
    );
  }

  return await pathsIdentifySameDirectory(candidates[0], dataDir)
    ? "live_same_data_dir"
    : "stale";
}

async function pathsIdentifySameDirectory(
  candidate: string,
  dataDir: string,
): Promise<boolean> {
  if (candidate === dataDir) return true;
  try {
    return await Deno.realPath(candidate) === await Deno.realPath(dataDir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw new Error(
      "cannot safely resolve PostgreSQL data-directory identity",
      {
        cause: error,
      },
    );
  }
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
