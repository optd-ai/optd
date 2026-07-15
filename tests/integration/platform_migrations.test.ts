import {
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
  platformMigrations,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test("fresh platform baseline is idempotent across real Postgres restart", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL")) {
    console.warn(
      "SKIP app-managed migration restart test: external database configured",
    );
    return;
  }
  if (!await findPostgresBins()) {
    console.warn(
      "SKIP real Postgres platform migrations: binaries unavailable",
    );
    return;
  }
  const root = await Deno.makeTempDir({
    prefix: "operant-platform-migrations-",
  });
  const previousData = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    const first = await sql.begin((tx) => applyPlatformMigrations(tx));
    assertEquals(first.applied.length, platformMigrations.length);
    const second = await sql.begin((tx) => applyPlatformMigrations(tx));
    assertEquals(second.applied, []);
    await closePostgresClient(sql);
    sql = undefined;
    await runtime.stop();
    runtime = undefined;

    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    assertEquals((await inspectMigrationStatus(sql)).ok, true);
    assertEquals(
      (await sql.begin((tx) => applyPlatformMigrations(tx))).applied,
      [],
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previousData === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousData);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("platform baseline invalidates legacy development migration ids", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-legacy-schema-" });
  const previousData = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await query(
      sql,
      `create table platform_schema_migrations (
      id text primary key, checksum text not null, applied_at timestamptz not null default now()
    )`,
    );
    await query(
      sql,
      "insert into platform_schema_migrations(id, checksum) values ('0001_platform_core', 'legacy')",
    );
    const error = await assertRejects(() =>
      sql!.begin((tx) => applyPlatformMigrations(tx))
    );
    assertStringIncludes(String(error), "create a fresh OPERANT_DATA_DIR");
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previousData === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousData);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
