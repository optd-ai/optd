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
  platformMigrations,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test("durable outbox migration rejects populated incompatible legacy rows", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  await withPostgres("legacy", async (sql) => {
    await sql.begin((tx) =>
      applyPlatformMigrations(tx, platformMigrations.slice(0, -1))
    );
    await query(
      sql,
      `insert into outbox(id,hook,phase,status,payload_json)
       values('legacy-row','legacy/hook','event.after_commit','pending','{}')`,
    );
    const error = await assertRejects(() =>
      sql!.begin((tx) => applyPlatformMigrations(tx))
    );
    assertStringIncludes(
      error instanceof Error ? error.message : String(error),
      "incompatible populated legacy outbox",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from outbox",
      )).rows[0].count,
      "1",
    );
  });
});

Deno.test("durable outbox migration installs exact constraints, indexes and evidence guards", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  await withPostgres("shape", async (sql) => {
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const states = (await query<{ definition: string }>(
      sql,
      `select pg_get_constraintdef(oid) definition from pg_constraint
       where conrelid='outbox_deliveries'::regclass and contype='c'`,
    )).rows.map((row) => row.definition).join("\n");
    for (
      const state of [
        "pending",
        "running",
        "retry_wait",
        "succeeded",
        "dead_letter",
        "cancelled",
      ]
    ) assertStringIncludes(states, state);
    const indexes = (await query<{ indexname: string }>(
      sql,
      `select indexname from pg_indexes where tablename in
       ('outbox_deliveries','outbox_attempts','outbox_hook_executions')
       order by indexname`,
    )).rows.map((row) => row.indexname);
    for (
      const required of [
        "outbox_claim_idx",
        "outbox_expired_lease_idx",
        "outbox_delivery_event_idx",
        "outbox_attempt_timeline_idx",
      ]
    ) assertEquals(indexes.includes(required), true, required);
    const triggers = (await query<{ tgname: string }>(
      sql,
      `select tgname from pg_trigger where not tgisinternal and tgrelid in
       ('outbox_deliveries'::regclass,'outbox_attempts'::regclass,
        'outbox_hook_executions'::regclass) order by tgname`,
    )).rows.map((row) => row.tgname);
    assertEquals(triggers, [
      "outbox_attempt_guard",
      "outbox_delivery_guard",
      "outbox_execution_immutable",
    ]);
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pg_stat_activity where datname=current_database() and state='idle in transaction'",
      )).rows[0].count,
      "0",
    );
  });
});

async function withPostgres(
  suffix: string,
  fn: (sql: ReturnType<typeof createPostgresClient>) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: `operant-outbox-${suffix}-` });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await fn(sql);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
}
