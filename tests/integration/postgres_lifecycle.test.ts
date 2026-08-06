import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
  inspectMigrationStatus,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  assertPostgresLifecycleAvailable,
  findPostgresBins,
  planPostgresRuntime,
  startManagedPostgres,
  startPostgresRuntime,
  stopManagedPostgres,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test("Postgres runtime planning preserves external vs app-managed selection", async () => {
  const plan = planPostgresRuntime();
  if (plan.mode === "external") {
    assertEquals(Boolean(plan.databaseUrl), true);
    return;
  }
  const bins = await findPostgresBins();
  if (!bins) {
    await assertPostgresLifecycleAvailable().then(
      () => {
        throw new Error("expected missing binaries error");
      },
      (error) =>
        assertStringIncludes(String(error.message), "postgres binaries"),
    );
    return;
  }
  const available = await assertPostgresLifecycleAvailable();
  assertEquals(available.mode, "app_managed");
});

Deno.test("PG18.4 app-managed startup recovers a stale nonexistent postmaster PID", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    await Deno.writeTextFile(pidPath, "2147483647\nstale test fixture\n");

    const runtime = await startManagedPostgres(rootDir);
    try {
      assert(
        (await Deno.readTextFile(pidPath)).split("\n")[0] !== "2147483647",
      );
    } finally {
      await stopManagedPostgres(runtime);
    }
  });
});

Deno.test("PG18.4 app-managed startup recovers a PID reused by a non-Postgres process", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    await Deno.writeTextFile(pidPath, `${Deno.pid}\nPID reuse test fixture\n`);

    const runtime = await startManagedPostgres(rootDir);
    try {
      assert(
        (await Deno.readTextFile(pidPath)).split("\n")[0] !== String(Deno.pid),
      );
    } finally {
      await stopManagedPostgres(runtime);
    }
  });
});

Deno.test("PG18.4 app-managed startup refuses and preserves a live same-data-dir server", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    const runtime = await startManagedPostgres(rootDir);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    const livePidFile = await Deno.readTextFile(pidPath);
    try {
      await assertRejects(
        () => startManagedPostgres(rootDir),
        Error,
        "identifies a live PostgreSQL server for this data directory",
      );
      assertEquals(await Deno.readTextFile(pidPath), livePidFile);
      const sql = createPostgresClient(runtime.databaseUrl);
      try {
        assertEquals(
          (await query<{ value: number }>(sql, "select 1 value")).rows[0].value,
          1,
        );
      } finally {
        await closePostgresClient(sql);
      }
    } finally {
      await stopManagedPostgres(runtime);
    }
  });
});

Deno.test("PG18.4 app-managed startup resolves a live relative -D from the postmaster cwd", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const raw = await startRelativePostgres(rootDir);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    const livePidFile = await Deno.readTextFile(pidPath);
    try {
      assertEquals(
        await readProcCwd(raw.process.pid),
        `${rootDir}/postgres/data`,
      );
      assert(`${rootDir}/postgres/data` !== await Deno.realPath(Deno.cwd()));
      await assertRejects(
        () => startManagedPostgres(rootDir),
        Error,
        "identifies a live PostgreSQL server for this data directory",
      );
      assertEquals(await Deno.readTextFile(pidPath), livePidFile);
      await assertQueryable(raw.databaseUrl);
    } finally {
      await stopRawPostgres(raw);
    }
  });
});

Deno.test("PG18.4 app-managed startup recovers a relative -D postmaster PID for another directory", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const otherRoot = await Deno.makeTempDir({ prefix: "operant-pg-other-" });
    let raw: RawPostgres | undefined;
    let recovered: Awaited<ReturnType<typeof startManagedPostgres>> | undefined;
    try {
      await initializeAndStop(otherRoot);
      raw = await startRelativePostgres(otherRoot);
      const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
      await Deno.writeTextFile(
        pidPath,
        `${raw.process.pid}\nrelative other-dir fixture\n`,
      );

      recovered = await startManagedPostgres(rootDir);
      assert(
        (await Deno.readTextFile(pidPath)).split("\n")[0] !==
          String(raw.process.pid),
      );
      await assertQueryable(recovered.databaseUrl);
      await assertQueryable(raw.databaseUrl);
    } finally {
      if (recovered) await stopManagedPostgres(recovered);
      if (raw) await stopRawPostgres(raw);
      await Deno.remove(otherRoot, { recursive: true }).catch(() => undefined);
    }
  });
});

Deno.test("PG18.4 app-managed startup fails closed for a postgres identity with a deleted cwd", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const deletedCwd = await Deno.makeTempDir({
      prefix: "operant-pg-deleted-cwd-",
    });
    const fixture = startPostgresIdentityFixture(deletedCwd, [
      "-D",
      "relative-data",
    ]);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    const pidFile = `${fixture.pid}\ndeleted cwd fixture\n`;
    try {
      await waitForProcCmdline(fixture.pid);
      await Deno.remove(deletedCwd);
      await Deno.writeTextFile(pidPath, pidFile);
      await assertRejects(
        () => startManagedPostgres(rootDir),
        Error,
        "cwd identity",
      );
      assertEquals(await Deno.readTextFile(pidPath), pidFile);
    } finally {
      fixture.kill("SIGTERM");
      await fixture.status;
      await Deno.remove(deletedCwd).catch(() => undefined);
    }
  });
});

Deno.test("PG18.4 app-managed startup fails closed for ambiguous postgres -D identity", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const fixtureCwd = await Deno.makeTempDir({
      prefix: "operant-pg-ambiguous-cwd-",
    });
    const fixture = startPostgresIdentityFixture(fixtureCwd, [
      "-D",
      "first",
      "-Dsecond",
    ]);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    const pidFile = `${fixture.pid}\nambiguous fixture\n`;
    try {
      await waitForProcCmdline(fixture.pid);
      await Deno.writeTextFile(pidPath, pidFile);
      await assertRejects(
        () => startManagedPostgres(rootDir),
        Error,
        "data-directory identity",
      );
      assertEquals(await Deno.readTextFile(pidPath), pidFile);
    } finally {
      fixture.kill("SIGTERM");
      await fixture.status;
      await Deno.remove(fixtureCwd, { recursive: true }).catch(() => undefined);
    }
  });
});

Deno.test("PG18.4 app-managed startup fails closed and preserves malformed postmaster.pid", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    await initializeAndStop(rootDir);
    const pidPath = `${rootDir}/postgres/data/postmaster.pid`;
    const malformed = "not-a-pid\nmalformed test fixture\n";
    await Deno.writeTextFile(pidPath, malformed);

    await assertRejects(
      () => startManagedPostgres(rootDir),
      Error,
      "refusing to remove malformed",
    );
    assertEquals(await Deno.readTextFile(pidPath), malformed);
  });
});

Deno.test("PG18.4 app-managed startup repeatedly recovers hard-stop postmaster.pid files", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    for (let recreation = 0; recreation < 3; recreation++) {
      const runtime = await startManagedPostgres(rootDir);
      runtime.process.kill("SIGKILL");
      await runtime.process.status;
      assert(
        await exists(`${rootDir}/postgres/data/postmaster.pid`),
        `hard recreation ${
          recreation + 1
        } must retain PostgreSQL's stale PID file`,
      );
    }
    const recovered = await startManagedPostgres(rootDir);
    await stopManagedPostgres(recovered);
  });
});

Deno.test("PG18.4 app-managed ordinary stop completes a clean smart shutdown", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    const bins = await findPostgresBins();
    if (!bins) throw new Error("postgres binaries unexpectedly unavailable");
    const runtime = await startManagedPostgres(rootDir);
    const postmasterPid = runtime.process.pid;
    const sql = createPostgresClient(runtime.databaseUrl);
    try {
      await query(
        sql,
        "create table lifecycle_smart_sentinel(id integer primary key, value text not null)",
      );
      await query(
        sql,
        "insert into lifecycle_smart_sentinel values (1, 'smart-persisted')",
      );
    } finally {
      await closePostgresClient(sql);
    }

    const escalations: string[] = [];
    await stopManagedPostgres(runtime, {
      smartTimeoutMs: 5_000,
      fastTimeoutMs: 5_000,
      onEscalation: (event) => escalations.push(event.shutdownMode),
    });
    assertEquals(escalations, []);
    assertEquals((await runtime.process.status).success, true);
    assertEquals(await processExists(postmasterPid), false);
    assertEquals(
      await exists(`${rootDir}/postgres/data/postmaster.pid`),
      false,
    );
    assertEquals(
      await readClusterState(bins.postgres, runtime.dataDir),
      "shut down",
    );
  });
});

Deno.test("PG18.4 app-managed blocked client reaches fast shutdown and restarts cleanly", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    const bins = await findPostgresBins();
    if (!bins) throw new Error("postgres binaries unexpectedly unavailable");
    const runtime = await startManagedPostgres(rootDir);
    let restarted:
      | Awaited<ReturnType<typeof startManagedPostgres>>
      | undefined;
    let observer = createPostgresClient(runtime.databaseUrl);
    const postmasterPid = runtime.process.pid;
    const blockerUrl = new URL(runtime.databaseUrl);
    blockerUrl.searchParams.set(
      "application_name",
      "operant_shutdown_blocker",
    );
    const blocker = new Deno.Command(bins.psql, {
      args: [
        blockerUrl.toString(),
        "-X",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "begin; select pg_sleep(60); commit;",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const blockerOutput = Promise.all([
      blocker.status,
      new Response(blocker.stdout).text(),
      new Response(blocker.stderr).text(),
    ]);
    try {
      await query(
        observer,
        "create table lifecycle_shutdown_sentinel (id integer primary key, value text not null)",
      );
      await query(
        observer,
        "insert into lifecycle_shutdown_sentinel(id, value) values (1, 'persisted')",
      );
      await waitForShutdownBlocker(observer);

      const escalations: string[] = [];
      const started = performance.now();
      await stopManagedPostgres(runtime, {
        smartTimeoutMs: 100,
        fastTimeoutMs: 5_000,
        onEscalation: (event) => escalations.push(event.shutdownMode),
      });
      const elapsed = performance.now() - started;
      if (elapsed >= 6_000) {
        throw new Error(`managed PostgreSQL fast stop took ${elapsed}ms`);
      }
      assertEquals(escalations, ["fast"]);
      assertEquals(
        await readClusterState(bins.postgres, runtime.dataDir),
        "shut down",
      );
      const [blockerStatus] = await blockerOutput;
      assertEquals(blockerStatus.success, false);
      assertEquals(await processExists(postmasterPid), false);
      assertEquals(
        await exists(`${rootDir}/postgres/data/postmaster.pid`),
        false,
      );
      await closePostgresClient(observer).catch(() => undefined);

      restarted = await startManagedPostgres(rootDir);
      observer = createPostgresClient(restarted.databaseUrl);
      const persisted = await query<{ value: string }>(
        observer,
        "select value from lifecycle_shutdown_sentinel where id = 1",
      );
      assertEquals(persisted.rows[0]?.value, "persisted");
      await closePostgresClient(observer);
      await stopManagedPostgres(restarted);
      restarted = undefined;
    } finally {
      await closePostgresClient(observer).catch(() => undefined);
      if (restarted) {
        await stopManagedPostgres(restarted).catch(() => undefined);
      }
      try {
        runtime.process.kill("SIGINT");
      } catch { /* already stopped */ }
      await runtime.process.status.catch(() => undefined);
      try {
        blocker.kill("SIGTERM");
      } catch { /* already stopped */ }
      await blockerOutput.catch(() => undefined);
    }
  });
});

Deno.test("PG18.4 app-managed delayed stop reaches immediate fallback and crash-recovers", async () => {
  if (!await hasPostgres18_4()) return;
  await withManagedDataDir(async (rootDir) => {
    const bins = await findPostgresBins();
    if (!bins) throw new Error("postgres binaries unexpectedly unavailable");
    const runtime = await startManagedPostgres(rootDir);
    const postmasterPid = runtime.process.pid;
    let restarted:
      | Awaited<ReturnType<typeof startManagedPostgres>>
      | undefined;
    let observer = createPostgresClient(runtime.databaseUrl);
    const blockerUrl = new URL(runtime.databaseUrl);
    blockerUrl.searchParams.set(
      "application_name",
      "operant_shutdown_blocker",
    );
    const blocker = new Deno.Command(bins.psql, {
      args: [
        blockerUrl.toString(),
        "-X",
        "--set",
        "ON_ERROR_STOP=1",
        "--command",
        "begin; select pg_sleep(60); commit;",
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const blockerOutput = Promise.all([
      blocker.status,
      new Response(blocker.stdout).text(),
      new Response(blocker.stderr).text(),
    ]);
    try {
      await query(
        observer,
        "create table lifecycle_immediate_sentinel (id integer primary key, value text not null)",
      );
      await query(
        observer,
        "insert into lifecycle_immediate_sentinel values (1, 'committed-before-immediate')",
      );
      await waitForShutdownBlocker(observer);

      const escalations: string[] = [];
      const started = performance.now();
      await stopManagedPostgres(runtime, {
        smartTimeoutMs: 50,
        fastTimeoutMs: 0,
        onEscalation: (event) => escalations.push(event.shutdownMode),
      });
      const elapsed = performance.now() - started;
      assert(elapsed < 25_000, `immediate fallback took ${elapsed}ms`);
      assertEquals(escalations, ["fast", "immediate"]);
      assertEquals(await processExists(postmasterPid), false);
      assertEquals(
        await exists(`${rootDir}/postgres/data/postmaster.pid`),
        false,
      );
      assertEquals(
        await readClusterState(bins.postgres, runtime.dataDir),
        "in production",
      );
      const [blockerStatus] = await blockerOutput;
      assertEquals(blockerStatus.success, false);
      await closePostgresClient(observer).catch(() => undefined);

      restarted = await startManagedPostgres(rootDir);
      observer = createPostgresClient(restarted.databaseUrl);
      const persisted = await query<{ value: string }>(
        observer,
        "select value from lifecycle_immediate_sentinel where id = 1",
      );
      assertEquals(persisted.rows[0]?.value, "committed-before-immediate");
      await closePostgresClient(observer);
      await stopManagedPostgres(restarted);
      restarted = undefined;
      assertEquals(
        await readClusterState(bins.postgres, runtime.dataDir),
        "shut down",
      );
    } finally {
      await closePostgresClient(observer).catch(() => undefined);
      if (restarted) {
        await stopManagedPostgres(restarted).catch(() => undefined);
      }
      try {
        runtime.process.kill("SIGQUIT");
      } catch { /* already stopped */ }
      await runtime.process.status.catch(() => undefined);
      try {
        blocker.kill("SIGTERM");
      } catch { /* already stopped */ }
      await blockerOutput.catch(() => undefined);
    }
  });
});

Deno.test("app-managed Postgres starts, migrates, persists sentinel across restart", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP app-managed Postgres integration: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "operant-pg-lifecycle-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  const previousDatabaseUrl = Deno.env.get("OPERANT_DATABASE_URL");
  if (!previousDatabaseUrl) Deno.env.set("OPERANT_DATA_DIR", dataDir);

  let firstRuntime:
    | Awaited<ReturnType<typeof startPostgresRuntime>>
    | undefined;
  let secondRuntime:
    | Awaited<ReturnType<typeof startPostgresRuntime>>
    | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    firstRuntime = await startPostgresRuntime();
    sql = createPostgresClient(firstRuntime.databaseUrl);
    await sql.begin(async (tx) => await applyPlatformMigrations(tx));
    await query(
      sql,
      "insert into platform_kv(key, value) values ($1, jsonb_build_object('ok', true)) on conflict (key) do update set value = excluded.value, updated_at = now()",
      ["postgres_lifecycle_sentinel"],
    );
    await closePostgresClient(sql);
    sql = undefined;
    await firstRuntime.stop();
    firstRuntime = undefined;

    secondRuntime = await startPostgresRuntime();
    sql = createPostgresClient(secondRuntime.databaseUrl);
    const sentinel = await query<{ ok: boolean }>(
      sql,
      "select (value->>'ok')::boolean as ok from platform_kv where key = $1",
      ["postgres_lifecycle_sentinel"],
    );
    assertEquals(sentinel.rows[0]?.ok, true);
    const migrations = await inspectMigrationStatus(sql);
    assertEquals(migrations.ok, true);
    assert(migrations.appliedCount >= 2);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (firstRuntime) await firstRuntime.stop().catch(() => undefined);
    if (secondRuntime) await secondRuntime.stop().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});

type RawPostgres = {
  process: Deno.ChildProcess;
  databaseUrl: string;
};

async function startRelativePostgres(rootDir: string): Promise<RawPostgres> {
  const bins = await findPostgresBins();
  if (!bins) throw new Error("postgres binaries unexpectedly unavailable");
  const runDir = `${rootDir}/postgres/relative-run`;
  await Deno.mkdir(runDir, { recursive: true });
  const port = freePort();
  const process = new Deno.Command(bins.postgres, {
    args: [
      "-D",
      ".",
      "-k",
      runDir,
      "-p",
      String(port),
      "-c",
      "listen_addresses=127.0.0.1",
    ],
    cwd: `${rootDir}/postgres/data`,
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const raw = {
    process,
    databaseUrl: `postgres://operant@127.0.0.1:${port}/postgres`,
  };
  try {
    await waitForPostgres(bins.psql, port, process);
    return raw;
  } catch (error) {
    try {
      process.kill("SIGTERM");
    } catch { /* already stopped */ }
    await process.status.catch(() => undefined);
    throw error;
  }
}

async function waitForPostgres(
  psql: string,
  port: number,
  process: Deno.ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "";
  while (Date.now() < deadline) {
    const status = await Promise.race([
      process.status.then((value) => ({ exited: true as const, value })),
      new Promise<{ exited: false }>((resolve) =>
        setTimeout(() => resolve({ exited: false }), 0)
      ),
    ]);
    if (status.exited) {
      throw new Error(
        `relative postgres exited during startup: ${status.value.code}`,
      );
    }
    const output = await new Deno.Command(psql, {
      args: [
        "-h",
        "127.0.0.1",
        "-p",
        String(port),
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
    if (
      output.success && new TextDecoder().decode(output.stdout).trim() === "1"
    ) {
      return;
    }
    lastError = new TextDecoder().decode(output.stderr).trim();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`relative postgres did not become ready: ${lastError}`);
}

async function stopRawPostgres(raw: RawPostgres): Promise<void> {
  try {
    raw.process.kill("SIGTERM");
  } catch { /* already stopped */ }
  await raw.process.status.catch(() => undefined);
}

async function assertQueryable(databaseUrl: string): Promise<void> {
  const sql = createPostgresClient(databaseUrl);
  try {
    assertEquals(
      (await query<{ value: number }>(sql, "select 1 value")).rows[0].value,
      1,
    );
  } finally {
    await closePostgresClient(sql);
  }
}

async function waitForShutdownBlocker(
  sql: ReturnType<typeof createPostgresClient>,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const active = await query<{ active: number }>(
      sql,
      `select count(*)::int active
         from pg_stat_activity
        where application_name = 'operant_shutdown_blocker'
          and state = 'active'
          and query like '%pg_sleep%'`,
    );
    if (active.rows[0]?.active === 1) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("independent PostgreSQL blocker transaction did not start");
}

function startPostgresIdentityFixture(
  cwd: string,
  postgresArgs: string[],
): Deno.ChildProcess {
  const shellArgs = postgresArgs.map(shellQuote).join(" ");
  return new Deno.Command("/bin/bash", {
    args: [
      "-c",
      `exec -a postgres /usr/bin/perl -e '$SIG{TERM}=sub{exit}; sleep 60' -- ${shellArgs}`,
    ],
    cwd,
    stdout: "null",
    stderr: "null",
  }).spawn();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitForProcCmdline(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const output = await new Deno.Command("/bin/cat", {
      args: [`/proc/${pid}/cmdline`],
      stdout: "piped",
      stderr: "null",
    }).output();
    const cmdline = new TextDecoder().decode(output.stdout);
    if (output.success && cmdline.startsWith("postgres\0")) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`postgres identity fixture ${pid} did not start`);
}

async function readProcCwd(pid: number): Promise<string> {
  const output = await new Deno.Command("/bin/readlink", {
    args: ["-e", `/proc/${pid}/cwd`],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(`cannot read cwd for PID ${pid}`);
  return new TextDecoder().decode(output.stdout).trimEnd();
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function readClusterState(
  postgresBin: string,
  dataDir: string,
): Promise<string> {
  const pgControlData = `${
    postgresBin.slice(0, postgresBin.lastIndexOf("/") + 1)
  }pg_controldata`;
  const output = await new Deno.Command(pgControlData, {
    args: [dataDir],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(
      `pg_controldata failed: ${new TextDecoder().decode(output.stderr)}`,
    );
  }
  const state = new TextDecoder().decode(output.stdout).match(
    /^Database cluster state:\s+(.+)$/m,
  )?.[1]?.trim();
  if (!state) throw new Error("pg_controldata did not report cluster state");
  return state;
}

async function hasPostgres18_4(): Promise<boolean> {
  const bins = await findPostgresBins();
  if (!bins) {
    console.warn(
      "SKIP PG18.4 lifecycle integration: postgres binaries not found",
    );
    return false;
  }
  const output = await new Deno.Command(bins.postgres, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const version = new TextDecoder().decode(output.stdout);
  if (!output.success || !version.includes("18.4")) {
    console.warn(`SKIP PG18.4 lifecycle integration: found ${version.trim()}`);
    return false;
  }
  return true;
}

async function withManagedDataDir(
  run: (rootDir: string) => Promise<void>,
): Promise<void> {
  const rootDir = await Deno.makeTempDir({ prefix: "operant-pg-pid-" });
  try {
    await run(rootDir);
  } finally {
    await Deno.remove(rootDir, { recursive: true }).catch(() => undefined);
  }
}

async function initializeAndStop(rootDir: string): Promise<void> {
  const runtime = await startManagedPostgres(rootDir);
  await stopManagedPostgres(runtime);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function processExists(pid: number): Promise<boolean> {
  const output = await new Deno.Command("/bin/sh", {
    args: ["-c", 'kill -0 "$1" 2>/dev/null', "sh", String(pid)],
    stdout: "null",
    stderr: "null",
  }).output();
  return output.success;
}
