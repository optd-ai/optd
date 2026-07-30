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
