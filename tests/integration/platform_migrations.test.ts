// deno-lint-ignore-file no-import-prefix no-unversioned-import
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
  if (Deno.env.get("OPTD_DATABASE_URL")) {
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
    prefix: "optd-platform-migrations-",
  });
  const previousData = Deno.env.get("OPTD_DATA_DIR");
  Deno.env.set("OPTD_DATA_DIR", root);
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
    if (previousData === undefined) Deno.env.delete("OPTD_DATA_DIR");
    else Deno.env.set("OPTD_DATA_DIR", previousData);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("race-free commit migrations preserve populated legacy audit and events", async () => {
  if (Deno.env.get("OPTD_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({
    prefix: "op-pop-mig-",
  });
  const previousData = Deno.env.get("OPTD_DATA_DIR");
  Deno.env.set("OPTD_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    const prior = platformMigrations.filter((migration) =>
      migration.id <= "1025_frozen_approval_decisions"
    );
    await sql.begin((tx) => applyPlatformMigrations(tx, prior));
    await query(
      sql,
      `insert into changesets(id,actor_id,status,request_json,preview_json) values('legacy-change','legacy-actor','committed','{}','{}')`,
    );
    await query(
      sql,
      `insert into audit_events(id,changeset_id,actor_id,event_type,request_metadata_json) values('legacy-audit','legacy-change','legacy-actor','legacy.committed','{"retained":true}')`,
    );
    await query(
      sql,
      `insert into events(id,changeset_id,event_type,payload_json) values('legacy-event','legacy-change','legacy.committed','{"retained":true}')`,
    );
    const remaining = platformMigrations.filter((migration) =>
      migration.id > "1025_frozen_approval_decisions"
    );
    await sql.begin((tx) => applyPlatformMigrations(tx, remaining));
    assertEquals(
      (await query<{ id: string }>(
        sql,
        "select id from audit_events where id='legacy-audit'",
      )).rows[0].id,
      "legacy-audit",
    );
    assertEquals(
      (await query<{ id: string }>(
        sql,
        "select id from events where id='legacy-event'",
      )).rows[0].id,
      "legacy-event",
    );
    assertEquals(
      (await sql.begin((tx) => applyPlatformMigrations(tx))).applied,
      [],
    );
    await assertRejects(() =>
      query(sql!, "update events set payload_json='{}' where id='legacy-event'")
    );
    await assertRejects(() =>
      query(sql!, "delete from audit_events where id='legacy-audit'")
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previousData === undefined) Deno.env.delete("OPTD_DATA_DIR");
    else Deno.env.set("OPTD_DATA_DIR", previousData);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("platform baseline invalidates legacy development migration ids", async () => {
  if (Deno.env.get("OPTD_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "optd-legacy-schema-" });
  const previousData = Deno.env.get("OPTD_DATA_DIR");
  Deno.env.set("OPTD_DATA_DIR", root);
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
    assertStringIncludes(String(error), "create a fresh OPTD_DATA_DIR");
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previousData === undefined) Deno.env.delete("OPTD_DATA_DIR");
    else Deno.env.set("OPTD_DATA_DIR", previousData);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
