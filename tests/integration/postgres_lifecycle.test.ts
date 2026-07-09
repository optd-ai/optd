import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
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
  startPostgresRuntime,
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
