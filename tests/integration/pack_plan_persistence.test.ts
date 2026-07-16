import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "jsr:@std/assert";
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
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import { createPackMigrationPlan } from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("immutable candidates are reused while every preview persists a distinct inactive plan", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
    console.warn(
      "SKIP real Postgres pack plan persistence: app-managed binaries unavailable or external database configured",
    );
    return;
  }
  const root = await Deno.makeTempDir({ prefix: "operant-pack-plan-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const principal = uuidV7(),
      human = uuidV7(),
      session = uuidV7(),
      auth = uuidV7();
    await query(
      sql,
      "insert into principals(id,type,active) values ($1,'human_user',true)",
      [principal],
    );
    await query(
      sql,
      "insert into human_users(id,principal_id,username,display_name,status) values ($1,$2,'pack-test','Pack Test','active')",
      [human, principal],
    );
    await query(
      sql,
      "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values ($1,$2,$3,'human_full','pack-test-digest')",
      [session, principal, human],
    );
    await query(
      sql,
      "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values ($1,$2,$3,$4,'human_full','{system:super_admin}',now())",
      [auth, principal, human, session],
    );
    const candidate = await loadPackFromFiles(
      await packFiles("prototypes/crm-default-pack"),
    );
    const first = await createPackMigrationPlan(sql, candidate, auth);
    const second = await createPackMigrationPlan(sql, candidate, auth);
    assertEquals(first.candidate_reused, false);
    assertEquals(second.candidate_reused, true);
    assertEquals(
      first.plan.to_pack_revision_id,
      second.plan.to_pack_revision_id,
    );
    assertNotEquals(first.plan.id, second.plan.id);
    assertEquals(first.plan.from_pack_revision_id, null);
    assert(first.plan.steps.length > 2);
    assert(first.plan.dependency_graph.edges.length > 0);
    assertEquals(
      first.plan.dependency_graph.topological_order,
      first.plan.steps.map((step) => step.id),
    );
    const persistedSql = (await query<{ sql_preview: string[] | string }>(
      sql,
      "select sql_preview from pack_migration_plans_v1 where id=$1",
      [first.plan.id],
    )).rows[0].sql_preview;
    const statements = typeof persistedSql === "string"
      ? JSON.parse(persistedSql) as string[]
      : persistedSql;
    assert(
      statements.some((statement) => /^create table \"res_/.test(statement)),
    );
    assert(
      statements.some((statement) => /^create table \"rel_/.test(statement)),
    );
    assert(
      statements.some((statement) =>
        /^insert into pack_active_revisions/.test(statement)
      ),
    );
    assert(
      statements.every((statement) => !statement.trimStart().startsWith("--")),
    );
    assert(statements.every((statement) => !/\$[0-9]+/.test(statement)));
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text as count from pack_active_revisions",
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text as count from pack_migration_plans_v1",
      )).rows[0].count,
      "2",
    );
    await assertRejects(
      () =>
        query(
          sql!,
          "update pack_candidate_revisions set version='9.9.9' where id=$1",
          [first.plan.to_pack_revision_id],
        ),
      Error,
      "immutable",
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

async function packFiles(dir: string): Promise<UploadedPackFile[]> {
  const files: UploadedPackFile[] = [];
  async function collect(path: string, prefix = "") {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await collect(child, relative);
      else if (/\.(?:yaml|ts)$/.test(relative)) {
        files.push({ path: relative, text: await Deno.readTextFile(child) });
      }
    }
  }
  await collect(dir);
  return files;
}
