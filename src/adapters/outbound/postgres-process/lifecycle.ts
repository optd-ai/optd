export const MIN_POSTGRES_MAJOR = 17;
const POSTGRES_STARTUP_TIMEOUT_MS = 30_000;
const POSTGRES_SMART_SHUTDOWN_TIMEOUT_MS = 8_000;
const POSTGRES_FAST_SHUTDOWN_TIMEOUT_MS = 8_000;

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
  const databaseUrl = env.get("OPTD_DATABASE_URL") ?? undefined;
  if (databaseUrl) {
    assertSupportedPostgresUrl(databaseUrl);
    return {
      mode: "external",
      databaseUrl,
      binariesAvailable: true,
    };
  }

  const pgBinDir = env.get("OPTD_PG_BIN_DIR") ?? undefined;
  const dataDir = env.get("OPTD_DATA_DIR") ?? undefined;
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
      "postgres binaries not found; set OPTD_PG_BIN_DIR or enter nix shell",
    );
  }
  return { ...plan, binariesAvailable: true };
}

export async function startPostgresRuntime(
  env: Deno.Env = Deno.env,
): Promise<PostgresRuntime> {
  const databaseUrl = env.get("OPTD_DATABASE_URL") ?? undefined;
  if (databaseUrl) {
    assertSupportedPostgresUrl(databaseUrl);
    return {
      mode: "external",
      databaseUrl,
      async stop() {},
    };
  }

  const rootDir = env.get("OPTD_DATA_DIR") ?? ".optd-data";
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
  const binDir = env.get("OPTD_PG_BIN_DIR");
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
      "postgres binaries not found; set OPTD_PG_BIN_DIR or enter nix shell",
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
      "--username=optd",
    ]);
  }

  await removeDemonstrablyStalePostmasterPid(dataDir);

  const configuredPort = env.get("OPTD_PG_PORT");
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
    databaseUrl: `postgres://optd@127.0.0.1:${port}/postgres`,
  };

  try {
    await waitReady(bins.psql, managed);
  } catch (error) {
    await stopManagedPostgres(managed);
    throw error;
  }
  return managed;
}

type PostgresShutdownEscalation = {
  event: "postgres_shutdown_escalated";
  shutdownMode: "fast" | "immediate";
  signal: "SIGINT" | "SIGQUIT";
  reason: "smart_shutdown_timeout" | "fast_shutdown_timeout";
  graceMs: number;
};

type PostgresShutdownOptions = {
  /** Internal adapter controls used by deterministic lifecycle tests. */
  smartTimeoutMs?: number;
  fastTimeoutMs?: number;
  onEscalation?: (event: PostgresShutdownEscalation) => void;
};

export async function stopManagedPostgres(
  pg: ManagedPostgres,
  options: PostgresShutdownOptions = {},
): Promise<void> {
  const smartTimeoutMs = options.smartTimeoutMs ??
    POSTGRES_SMART_SHUTDOWN_TIMEOUT_MS;
  const fastTimeoutMs = options.fastTimeoutMs ??
    POSTGRES_FAST_SHUTDOWN_TIMEOUT_MS;
  const status = pg.process.status;
  try {
    pg.process.kill("SIGTERM");
  } catch {
    // Already stopped.
  }

  if (await processStoppedWithin(status, smartTimeoutMs)) {
    await status.catch(() => undefined);
    return;
  }

  const fastEvent: PostgresShutdownEscalation = {
    event: "postgres_shutdown_escalated",
    shutdownMode: "fast",
    signal: "SIGINT",
    reason: "smart_shutdown_timeout",
    graceMs: smartTimeoutMs,
  };
  console.warn(JSON.stringify(fastEvent));
  options.onEscalation?.(fastEvent);
  try {
    // PostgreSQL SIGINT is its documented fast shutdown: active
    // transactions are rolled back and clients are disconnected cleanly.
    pg.process.kill("SIGINT");
  } catch {
    // The postmaster exited at the smart-shutdown boundary.
  }

  if (await processStoppedWithin(status, fastTimeoutMs)) {
    await status.catch(() => undefined);
    return;
  }

  const immediateEvent: PostgresShutdownEscalation = {
    event: "postgres_shutdown_escalated",
    shutdownMode: "immediate",
    signal: "SIGQUIT",
    reason: "fast_shutdown_timeout",
    graceMs: fastTimeoutMs,
  };
  console.warn(JSON.stringify(immediateEvent));
  options.onEscalation?.(immediateEvent);
  try {
    // PostgreSQL SIGQUIT is its documented immediate shutdown. It deliberately
    // skips the clean checkpoint so crash recovery runs on the next start, and
    // is reserved for the final data-safe fallback before an orchestrator's
    // SIGKILL deadline.
    pg.process.kill("SIGQUIT");
  } catch {
    // The postmaster exited at the fast-shutdown boundary.
  }
  // Child status is authoritative: do not report the runtime stopped until the
  // postmaster has exited and Deno has reaped it.
  await status.catch(() => undefined);
}

async function processStoppedWithin(
  status: Promise<Deno.CommandStatus>,
  timeoutMs: number,
): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("PostgreSQL shutdown grace must be a non-negative number");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      status.then(() => true, () => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
      `unsupported PostgreSQL server version: Optd requires PostgreSQL ${MIN_POSTGRES_MAJOR} or newer`,
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
      "OPTD_DATABASE_URL must be a valid postgres:// or postgresql:// URL",
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
        "optd",
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

const PROC_CMDLINE_MAX_BYTES = 4 * 1024 * 1024;
const PROC_CWD_MAX_BYTES = 8192;

type DirectoryIdentity = {
  canonicalPath: string;
  dev: number | null;
  ino: number | null;
};

type PostmasterPidInspection = {
  kind:
    | "missing"
    | "non_postgres"
    | "postgres_other_data_dir"
    | "live_same_data_dir";
  managedTarget: DirectoryIdentity;
  cmdline?: Uint8Array;
  cwd?: DirectoryIdentity;
  postgresTarget?: DirectoryIdentity;
};

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

  let priorEvidence: PostmasterPidInspection | undefined;
  for (let inspection = 0; inspection < 2; inspection++) {
    const identity = await inspectPostmasterPid(pid, dataDir, pidPath);
    if (priorEvidence && !sameInspectionEvidence(priorEvidence, identity)) {
      throw new Error(
        `refusing to remove ${pidPath}: process or data-directory identity for PID ${pid} changed during inspection`,
      );
    }
    priorEvidence = identity;

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

  if (priorEvidence?.kind === "live_same_data_dir") {
    throw new Error(
      `refusing to start app-managed PostgreSQL: ${pidPath} identifies a live PostgreSQL server for this data directory (PID ${pid})`,
    );
  }
  await Deno.remove(pidPath);
}

async function inspectPostmasterPid(
  pid: number,
  dataDir: string,
  pidPath: string,
): Promise<PostmasterPidInspection> {
  const managedTarget = await readDirectoryIdentity(
    dataDir,
    "managed PostgreSQL data directory",
  );
  const bytes = await readProcCmdline(pid);
  if (!bytes) return { kind: "missing", managedTarget };
  if (bytes.length === 0) {
    throw new Error(
      `refusing to remove ${pidPath}: process identity for PID ${pid} is unreadable`,
    );
  }

  const argv = new TextDecoder().decode(bytes).split("\0").filter(Boolean);
  const executable = argv[0]?.split("/").at(-1);
  if (executable !== "postgres") {
    return { kind: "non_postgres", managedTarget, cmdline: bytes };
  }

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

  const cwd = await readProcCwdIdentity(pid);
  if (!cwd) return { kind: "missing", managedTarget };
  const candidatePath = candidates[0].startsWith("/")
    ? candidates[0]
    : `${cwd.canonicalPath}/${candidates[0]}`;
  const postgresTarget = await readDirectoryIdentity(
    candidatePath,
    `PostgreSQL data directory for PID ${pid}`,
  );

  if (directoriesIdentifySameTarget(postgresTarget, managedTarget)) {
    return {
      kind: "live_same_data_dir",
      managedTarget,
      cmdline: bytes,
      cwd,
      postgresTarget,
    };
  }
  return {
    kind: "postgres_other_data_dir",
    managedTarget,
    cmdline: bytes,
    cwd,
    postgresTarget,
  };
}

async function readProcCmdline(pid: number): Promise<Uint8Array | null> {
  const fixedPid = fixedNumericPid(pid);
  const path = `/proc/${fixedPid}/cmdline`;
  let directError: unknown;
  try {
    return await readBoundedFile(path, PROC_CMDLINE_MAX_BYTES);
  } catch (error) {
    directError = error;
  }

  const output = await new Deno.Command("/bin/sh", {
    args: [
      "-c",
      `if [ "$$" -eq ${fixedPid} ]; then exit 2; fi; exec /bin/cat /proc/${fixedPid}/cmdline`,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.success) {
    if (output.stdout.length > PROC_CMDLINE_MAX_BYTES) {
      throw new Error(`process cmdline for PID ${pid} exceeds safe bounds`);
    }
    return output.stdout;
  }
  if (!await procPidExists(pid)) return null;
  throw new Error(`process identity for PID ${pid} is unreadable`, {
    cause: directError,
  });
}

async function readProcCwdIdentity(
  pid: number,
): Promise<DirectoryIdentity | null> {
  const fixedPid = fixedNumericPid(pid);
  const path = `/proc/${fixedPid}/cwd`;
  let canonicalPath: string;
  let directError: unknown;
  try {
    canonicalPath = await Deno.realPath(path);
  } catch (error) {
    directError = error;
    const output = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        `if [ "$$" -eq ${fixedPid} ]; then exit 2; fi; exec /bin/readlink -e /proc/${fixedPid}/cwd`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!output.success) {
      if (!await procPidExists(pid)) return null;
      throw new Error(
        `process cwd identity for PID ${pid} is unreadable or deleted`,
        { cause: directError },
      );
    }
    if (
      output.stdout.length === 0 || output.stdout.length > PROC_CWD_MAX_BYTES
    ) {
      throw new Error(`process cwd identity for PID ${pid} is ambiguous`);
    }
    const decoded = new TextDecoder().decode(output.stdout);
    canonicalPath = decoded.endsWith("\n") ? decoded.slice(0, -1) : decoded;
    if (
      !canonicalPath.startsWith("/") || canonicalPath.includes("\n") ||
      canonicalPath.includes("\r") || canonicalPath.includes("\0")
    ) {
      throw new Error(`process cwd identity for PID ${pid} is ambiguous`);
    }
  }

  try {
    return await readDirectoryIdentity(canonicalPath, `cwd for PID ${pid}`);
  } catch (error) {
    if (!await procPidExists(pid)) return null;
    throw new Error(
      `process cwd identity for PID ${pid} is unreadable or deleted`,
      { cause: error },
    );
  }
}

async function readDirectoryIdentity(
  path: string,
  description: string,
): Promise<DirectoryIdentity> {
  try {
    const canonicalPath = await Deno.realPath(path);
    const info = await Deno.stat(canonicalPath);
    if (!info.isDirectory) throw new Error(`${description} is not a directory`);
    return {
      canonicalPath,
      dev: info.dev ?? null,
      ino: info.ino ?? null,
    };
  } catch (error) {
    throw new Error(`cannot safely resolve ${description}`, { cause: error });
  }
}

function directoriesIdentifySameTarget(
  left: DirectoryIdentity,
  right: DirectoryIdentity,
): boolean {
  const haveUnixIdentity = left.dev !== null && left.ino !== null &&
    right.dev !== null && right.ino !== null;
  if (haveUnixIdentity) {
    const sameUnixIdentity = left.dev === right.dev && left.ino === right.ino;
    if (left.canonicalPath === right.canonicalPath && !sameUnixIdentity) {
      throw new Error(
        "cannot safely resolve PostgreSQL data-directory identity: canonical target was replaced",
      );
    }
    return sameUnixIdentity;
  }
  return left.canonicalPath === right.canonicalPath;
}

function sameInspectionEvidence(
  left: PostmasterPidInspection,
  right: PostmasterPidInspection,
): boolean {
  if (
    left.kind !== right.kind ||
    !sameDirectoryIdentity(left.managedTarget, right.managedTarget)
  ) return false;
  if (left.kind === "missing") return true;
  if (!sameBytes(left.cmdline, right.cmdline)) return false;
  if (left.kind === "non_postgres") return true;
  return sameDirectoryIdentity(left.cwd, right.cwd) &&
    sameDirectoryIdentity(left.postgresTarget, right.postgresTarget);
}

function sameDirectoryIdentity(
  left: DirectoryIdentity | undefined,
  right: DirectoryIdentity | undefined,
): boolean {
  return left !== undefined && right !== undefined &&
    left.canonicalPath === right.canonicalPath && left.dev === right.dev &&
    left.ino === right.ino;
}

function sameBytes(
  left: Uint8Array | undefined,
  right: Uint8Array | undefined,
): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

async function readBoundedFile(
  path: string,
  maximumBytes: number,
): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    const buffer = new Uint8Array(maximumBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer.subarray(length));
      if (read === null) break;
      length += read;
    }
    if (length > maximumBytes) throw new Error(`${path} exceeds safe bounds`);
    return buffer.slice(0, length);
  } finally {
    file.close();
  }
}

async function procPidExists(pid: number): Promise<boolean> {
  const fixedPid = fixedNumericPid(pid);
  const path = `/proc/${fixedPid}`;
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    const output = await new Deno.Command("/bin/sh", {
      args: [
        "-c",
        `if [ "$$" -eq ${fixedPid} ]; then exit 1; fi; test -d /proc/${fixedPid}`,
      ],
      stdout: "null",
      stderr: "null",
    }).output();
    return output.success;
  }
}

function fixedNumericPid(pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("invalid process ID for procfs inspection");
  }
  return String(pid);
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
