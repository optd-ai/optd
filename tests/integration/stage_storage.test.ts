// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test({
  name:
    "PostgreSQL 18 immutable stage schema has complete constraints and triggers",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
      return;
    }
    const root = await Deno.makeTempDir({ prefix: "operant-stage-storage-" });
    const previous = Deno.env.get("OPERANT_DATA_DIR");
    Deno.env.set("OPERANT_DATA_DIR", root);
    let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
    let sql: ReturnType<typeof createPostgresClient> | undefined;
    try {
      runtime = await startPostgresRuntime();
      sql = createPostgresClient(runtime.databaseUrl);
      await sql.begin((tx) => applyPlatformMigrations(tx));
      const tables = (await query<{ table_name: string }>(
        sql,
        `select table_name from information_schema.tables where table_schema='public'
         and table_name like 'staged_%' order by table_name`,
      )).rows.map((row) => row.table_name);
      assertEquals(tables, [
        "staged_approval_audit_events",
        "staged_approval_decisions",
        "staged_approval_requirements",
        "staged_changeset_dependencies",
        "staged_changeset_lifecycle",
        "staged_changeset_operations",
        "staged_changesets",
        "staged_hook_executions",
        "staged_policy_decisions",
      ]);
      const immutableTriggers = await query<{ count: string }>(
        sql,
        `select count(*)::text count from pg_trigger where not tgisinternal
         and tgrelid in ('staged_changesets'::regclass,'staged_changeset_operations'::regclass,
          'staged_changeset_dependencies'::regclass,'staged_hook_executions'::regclass,
          'staged_policy_decisions'::regclass,'staged_approval_requirements'::regclass,
          'staged_approval_decisions'::regclass,'staged_approval_audit_events'::regclass)`,
      );
      assertEquals(immutableTriggers.rows[0].count, "8");
      const commitColumns = await query<
        { column_name: string; is_nullable: string }
      >(
        sql,
        `select column_name,is_nullable from information_schema.columns
         where table_name='changeset_commits' and column_name in
          ('stage_id','authorization_cutoff_at','operation_graph_digest') order by column_name`,
      );
      assertEquals(commitColumns.rows, [
        { column_name: "authorization_cutoff_at", is_nullable: "YES" },
        { column_name: "operation_graph_digest", is_nullable: "YES" },
        { column_name: "stage_id", is_nullable: "YES" },
      ]);
      const historyFks = await query<{ count: string }>(
        sql,
        `select count(*)::text count from pg_constraint where contype='f'
         and confrelid='changeset_commits'::regclass and conrelid in
          ('object_versions'::regclass,'comments'::regclass)`,
      );
      assertEquals(historyFks.rows[0].count, "2");
    } finally {
      if (sql) await closePostgresClient(sql).catch(() => undefined);
      if (runtime) await runtime.stop().catch(() => undefined);
      if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
      else Deno.env.set("OPERANT_DATA_DIR", previous);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});
