// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
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
import {
  createPackMigrationPlan,
  validateMigrationPlan,
} from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("immutable candidates are reused while every preview persists a distinct inactive plan", async () => {
  if (Deno.env.get("OPTD_DATABASE_URL") || !await findPostgresBins()) {
    console.warn(
      "SKIP real Postgres pack plan persistence: app-managed binaries unavailable or external database configured",
    );
    return;
  }
  const root = await Deno.makeTempDir({ prefix: "optd-pack-plan-" });
  const previous = Deno.env.get("OPTD_DATA_DIR");
  Deno.env.set("OPTD_DATA_DIR", root);
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
    const projectId = uuidV7();
    await query(
      sql,
      `insert into projects(
         id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id)
       values($1,'pack-plan-test','Pack Plan Test',$2,$2)`,
      [projectId, auth],
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        `select count(*)::text count from projects p
         join auth_contexts c on c.id=$2 where p.id=$1`,
        [projectId, auth],
      )).rows[0].count,
      "1",
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
    class ExpectedRollback extends Error {}
    await assertRejects(
      () =>
        sql!.begin(async (tx) => {
          const byId = new Map(first.plan.steps.map((step) => [step.id, step]));
          for (const stepId of first.plan.dependency_graph.topological_order) {
            const step = byId.get(stepId)!;
            for (const index of step.statement_indexes) {
              await query(tx, statements[index]);
            }
          }
          const tables = await query<
            {
              definition_kind: string;
              definition_name: string;
              table_name: string;
            }
          >(
            tx,
            "select definition_kind,definition_name,table_name from pack_runtime_tables where publisher='optd' and pack_name='crm' order by definition_kind,definition_name",
          );
          assert(tables.rows.some((row) => row.definition_kind === "resource"));
          assert(
            tables.rows.some((row) => row.definition_kind === "relationship"),
          );
          for (const row of tables.rows) {
            assert(
              /^(?:res|rel)_optd_crm_.*_[0-9a-f]{16}$/.test(row.table_name),
            );
            assertEquals(
              (await query<{ exists: boolean }>(
                tx,
                "select to_regclass($1) is not null as exists",
                [`public.${row.table_name}`],
              )).rows[0].exists,
              true,
            );
          }
          const resourceTables = new Map(
            tables.rows.filter((row) => row.definition_kind === "resource")
              .map((row) => [row.definition_name, row.table_name]),
          );
          const declaredActiveIndexes = [
            ["activity_type", "activity_type_active_name", "name"],
            ["lead_status", "lead_status_active_name", "name"],
            ["lost_reason", "lost_reason_active_name", "name"],
            [
              "opportunity_stage",
              "opportunity_stage_active_name",
              "name",
            ],
            ["sales_team", "sales_team_active_name", "name"],
          ] as const;
          const indexes = await query<{
            indexname: string;
            tablename: string;
            indexdef: string;
          }>(
            tx,
            `select indexname,tablename,indexdef from pg_indexes
             where schemaname='public' and indexname=any($1::text[])
             order by indexname`,
            [declaredActiveIndexes.map(([, name]) => name)],
          );
          assertEquals(
            indexes.rows,
            declaredActiveIndexes.map(([resource, indexname, field]) => {
              const tablename = resourceTables.get(resource)!;
              return {
                indexname,
                tablename,
                indexdef:
                  `CREATE UNIQUE INDEX ${indexname} ON public.${tablename} USING btree (project_id, ${field}) WHERE (archived_at IS NULL)`,
              };
            }).sort((left, right) =>
              left.indexname.localeCompare(right.indexname)
            ),
          );

          const declaredFullConstraints = Object.entries(candidate.resources)
            .flatMap(([resource, definition]) => {
              const constraints = Array.isArray(definition.spec.constraints)
                ? definition.spec.constraints as Array<
                  Record<string, unknown>
                >
                : [];
              return constraints.filter((constraint) =>
                constraint.kind === "unique" && constraint.where === undefined
              ).map((constraint) => ({
                definition_name: resource,
                conname: String(constraint.name),
                definition: `UNIQUE (project_id, ${
                  (constraint.fields as unknown[]).map(String).join(", ")
                })`,
              }));
            }).sort((left, right) => left.conname.localeCompare(right.conname));
          const fullConstraints = await query<{
            definition_name: string;
            conname: string;
            definition: string;
          }>(
            tx,
            `select t.definition_name,c.conname,pg_get_constraintdef(c.oid) definition
             from pg_constraint c
             join pack_runtime_tables t on c.conrelid=t.table_name::regclass
             where t.publisher='optd' and t.pack_name='crm'
               and t.definition_kind='resource'
               and c.conname=any($1::text[])
             order by c.conname`,
            [declaredFullConstraints.map((constraint) => constraint.conname)],
          );
          assertEquals(fullConstraints.rows, declaredFullConstraints);
          throw new ExpectedRollback("rollback executable preview");
        }),
      ExpectedRollback,
      "rollback executable preview",
    );
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

    await sql.begin(async (tx) => {
      const byId = new Map(first.plan.steps.map((step) => [step.id, step]));
      for (const stepId of first.plan.dependency_graph.topological_order) {
        for (const index of byId.get(stepId)!.statement_indexes) {
          await query(tx, statements[index]);
        }
      }
    });
    const leadTable = (await query<{ table_name: string }>(
      sql,
      "select table_name from pack_runtime_tables where publisher='optd' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    const candidateV2 = structuredClone(candidate);
    candidateV2.version = "0.2.0";
    candidateV2.sourceDigest = `sha256:${"a".repeat(64)}`;
    candidateV2.revision = `optd/crm@0.2.0:sha256:${"b".repeat(64)}`;
    delete (candidateV2.resources.lead.spec.fields as Record<string, unknown>)
      .phone;
    delete ((candidateV2.resources.lead.document.spec as Record<
      string,
      unknown
    >).fields as Record<string, unknown>).phone;
    delete ((((candidateV2.normalized.resources as Record<string, any>).lead
      .spec as Record<string, unknown>).fields) as Record<string, unknown>)
      .phone;
    const removal = await createPackMigrationPlan(sql, candidateV2, auth);
    const removeChange = removal.plan.changes.find((change) =>
      change.kind === "remove_field" && change.target.field === "phone"
    )!;
    assertEquals(removeChange.status, "ready");
    const rowId = uuidV7();
    await query(
      sql,
      `insert into "${leadTable}"(id,project_id,created_by,updated_by,name,status,phone) values ($1,$2,$3,$3,'Lead','new','555')`,
      [rowId, projectId, auth],
    );
    const blocked = await sql.begin((tx) =>
      validateMigrationPlan(tx, removal.plan.id, auth)
    ) as any;
    assertEquals(blocked.status, "blocked");
    assertEquals(blocked.confirmation_token, null);
    assertEquals(blocked.blockers, [{
      change_id: removeChange.id,
      code: "PRESENT_VALUES",
      count: 1,
      message: "remove_field cannot be applied against current live facts",
    }]);
    await query(sql, `delete from "${leadTable}" where id=$1`, [rowId]);
    const ready = await sql.begin((tx) =>
      validateMigrationPlan(tx, removal.plan.id, auth)
    ) as any;
    assertEquals(ready.status, "ready");
    assert(typeof ready.confirmation_token === "string");
    let concurrentInsert: Promise<unknown> | undefined;
    await sql.begin(async (tx) => {
      await query(tx, `lock table "${leadTable}" in share mode`);
      concurrentInsert = query(
        sql!,
        `insert into "${leadTable}"(id,project_id,created_by,updated_by,name,status,phone) values ($1,$2,$3,$3,'Concurrent','new','777')`,
        [uuidV7(), projectId, auth],
      );
      const validation = await validateMigrationPlan(
        tx,
        removal.plan.id,
        auth,
      ) as any;
      assertEquals(validation.status, "ready");
    });
    await concurrentInsert;
    const stale = await sql.begin((tx) =>
      validateMigrationPlan(tx, removal.plan.id, auth)
    ) as any;
    assertEquals(stale.status, "blocked");
    assertEquals(stale.confirmation_token, null);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPTD_DATA_DIR");
    else Deno.env.set("OPTD_DATA_DIR", previous);
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
