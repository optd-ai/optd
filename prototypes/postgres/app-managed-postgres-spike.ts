type ManagedPostgres = {
  dataDir: string;
  runDir: string;
  port: number;
  databaseUrl: string;
  process?: Deno.ChildProcess;
};

export async function findPostgresBins() {
  const binDir = Deno.env.get("OPERANT_PG_BIN_DIR");
  const candidates = binDir
    ? [binDir]
    : (Deno.env.get("PATH") ?? "").split(":");
  for (const dir of candidates) {
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
): Promise<ManagedPostgres> {
  const bins = await findPostgresBins();
  if (!bins) {
    throw new Error(
      "postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
  }
  const dataDir = `${rootDir}/data`;
  const runDir = `${rootDir}/run`;
  await Deno.mkdir(runDir, { recursive: true });
  if (!await exists(`${dataDir}/PG_VERSION`)) {
    await runChecked(bins.initdb, [
      "-D",
      dataDir,
      "--no-locale",
      "--encoding=UTF8",
    ]);
  }
  const port = Number(Deno.env.get("OPERANT_PG_PORT") ?? await freePort());
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
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const managed: ManagedPostgres = {
    dataDir,
    runDir,
    port,
    process: child,
    databaseUrl: `postgres://127.0.0.1:${port}/postgres`,
  };
  await waitReady(bins.psql, managed);
  return managed;
}

export async function stopManagedPostgres(pg: ManagedPostgres) {
  if (!pg.process) return;
  try {
    pg.process.kill("SIGTERM");
  } catch { /* already exited */ }
  await pg.process.status.catch(() => undefined);
}

export async function psql(pg: ManagedPostgres, sql: string) {
  const bins = await findPostgresBins();
  if (!bins) throw new Error("postgres binaries not found");
  const command = new Deno.Command(bins.psql, {
    args: [
      "-h",
      "127.0.0.1",
      "-p",
      String(pg.port),
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      sql,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await command.output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

async function waitReady(psqlBin: string, pg: ManagedPostgres) {
  const started = Date.now();
  let last = "";
  while (Date.now() - started < 10_000) {
    const out = await new Deno.Command(psqlBin, {
      args: [
        "-h",
        "127.0.0.1",
        "-p",
        String(pg.port),
        "-d",
        "postgres",
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
  await stopManagedPostgres(pg);
  throw new Error(`postgres did not become ready: ${last}`);
}

async function runChecked(command: string, args: string[]) {
  const out = await new Deno.Command(command, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

async function freePort() {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function exists(path: string) {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
