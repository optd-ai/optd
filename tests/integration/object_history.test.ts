import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  closePostgresClient,
  createPostgresClient,
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
  platformMigrations,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) =>
    `019a0000-0000-7${index.toString(16).padStart(3, "0")}-8000-000000000001`,
);

Deno.test("populated 1015 to 1016 upgrade preserves shared immutable evidence", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-history-upgrade-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: Sql | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    const migration = platformMigrations.at(-1)!;
    assertEquals(migration.id, "1016_project_object_history");
    assertEquals(
      /drop table[^;]*object_versions[^;]*cascade/i.test(migration.sql),
      false,
    );
    await sql.begin((tx) =>
      applyPlatformMigrations(tx, platformMigrations.slice(0, -1))
    );
    const [
      principal,
      user,
      session,
      auth,
      project,
      candidate,
      plan,
      application,
      legacyChange,
      legacyVersion,
    ] = ids;
    await sql.begin(async (tx) => {
      await query(
        tx,
        "insert into principals(id,type,active) values($1,'human_user',true)",
        [principal],
      );
      await query(
        tx,
        "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'upgrade-test','Upgrade Test','active')",
        [user, principal],
      );
      await query(
        tx,
        "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','upgrade-token')",
        [session, principal, user],
      );
      await query(
        tx,
        "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{}',now())",
        [auth, principal, user, session],
      );
      await query(
        tx,
        "insert into projects(id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id) values($1,'upgrade-test','Upgrade Test',$2,$2)",
        [project, auth],
      );
      await query(
        tx,
        "insert into auth_audit_events(id,event_type,auth_context_id,principal_id,human_user_id,session_id,details) values($1,'auth.human_user.created',$2,$3,$4,$5,'{\"kept\":true}')",
        [ids[10], auth, principal, user, session],
      );
      await query(
        tx,
        "insert into authorization_audit_events(id,auth_context_id,event_type,details) values($1,$2,'policy.allowed','{\"kept\":true}')",
        [ids[11], auth],
      );
      await query(
        tx,
        "insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files) values($1,'operant','upgrade','1','sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'{}','{}','[]')",
        [candidate],
      );
      await query(
        tx,
        `insert into pack_migration_plans_v1(id,publisher,pack_name,to_pack_revision_id,candidate_source_digest,plan_digest,created_auth_context_id,class,status,live_facts_digest,plan_json,sql_preview) values($1,'operant','upgrade',$2,'sha256:'||repeat('1',64),'sha256:'||repeat('3',64),$3,'safe','applied','sha256:'||repeat('4',64),'{}','[]')`,
        [plan, candidate, auth],
      );
      await query(
        tx,
        "insert into pack_migration_applications(id,plan_id,plan_digest,candidate_revision_id,auth_context_id,principal_id,authorization_root_id) values($1,$2,'sha256:'||repeat('3',64),$3,$4,$5,'human:upgrade')",
        [application, plan, candidate, auth, principal],
      );
      await query(
        tx,
        "insert into pack_migration_audit_events(id,plan_id,application_id,auth_context_id,principal_id,authorization_root_id,action,decision,details) values($1,$2,$3,$4,$5,'human:upgrade','migration.apply','allowed','{\"kept\":true}')",
        [ids[12], plan, application, auth, principal],
      );
      await query(
        tx,
        "insert into changesets(id,actor_id,status,request_json) values($1,'legacy','committed','{}')",
        [legacyChange],
      );
      await query(
        tx,
        "insert into object_versions(id,resource,object_id,version,changeset_id,operation,resource_revision,snapshot_json,actor_id) values($1,'legacy.thing','legacy-object',1,$2,'create','legacy','{}','legacy')",
        [legacyVersion, legacyChange],
      );
      await query(
        tx,
        "insert into audit_events(id,changeset_id,object_version_id,actor_id,event_type,request_metadata_json) values('legacy-audit',$1,$2,'legacy','object.created','{\"kept\":true}')",
        [legacyChange, legacyVersion],
      );
      await query(
        tx,
        "insert into events(id,changeset_id,object_version_id,event_type,payload_json) values('legacy-event',$1,$2,'object.created','{\"kept\":true}')",
        [legacyChange, legacyVersion],
      );
    });
    const before = await sharedEvidence(sql);
    const ownership = await sharedOwnership(sql);
    const triggers = await immutableTriggerCount(sql);
    assertEquals(
      (await sql.begin((tx) => applyPlatformMigrations(tx, [migration])))
        .applied,
      [migration.id],
    );
    assertEquals(await sharedEvidence(sql), before);
    assertEquals(await sharedOwnership(sql), ownership);
    assertEquals(await immutableTriggerCount(sql), triggers);
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from audit_events where id='legacy-audit' and object_version_id is null and request_metadata_json->>'kept'='true'",
      )).rows[0].count,
      "1",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from events where id='legacy-event' and object_version_id is null and payload_json->>'kept'='true'",
      )).rows[0].count,
      "1",
    );
    assertEquals(
      (await query<{ type: string; fks: string }>(
        sql,
        `select format_type(a.atttypid,a.atttypmod) type,(select count(*)::text from pg_constraint where conname in ('audit_events_object_version_id_fkey','events_object_version_id_fkey')) fks from pg_attribute a where a.attrelid='audit_events'::regclass and a.attname='object_version_id'`,
      )).rows[0],
      { type: "uuid", fks: "2" },
    );
    await closePostgresClient(sql);
    sql = undefined;
    await runtime.stop();
    runtime = undefined;
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    assertEquals(
      (await sql.begin((tx) => applyPlatformMigrations(tx, [migration])))
        .applied,
      [],
    );
    assertEquals(await sharedEvidence(sql), before);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("Project history is immutable, chained, unique, and comments do not bump versions", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-object-history-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: Sql | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const [
      principal,
      user,
      session,
      auth,
      project,
      revision,
      commit,
      object,
      v1,
      v2,
      comment,
    ] = ids;
    await sql.begin(async (tx) => {
      await query(
        tx,
        "insert into principals(id,type,active) values($1,'human_user',true)",
        [principal],
      );
      await query(
        tx,
        "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'history-test','History Test','active')",
        [user, principal],
      );
      await query(
        tx,
        "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','history-test-token')",
        [session, principal, user],
      );
      await query(
        tx,
        "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{}',now())",
        [auth, principal, user, session],
      );
      await query(
        tx,
        "insert into projects(id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id) values($1,'history-test','History Test',$2,$2)",
        [project, auth],
      );
      await query(
        tx,
        "insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files) values($1,'operant','test','1','sha256:'||repeat('1',64),'sha256:'||repeat('2',64),'{}','{}','[]')",
        [revision],
      );
      await query(
        tx,
        "insert into changeset_commits(id,committed_auth_context_id) values($1,$2)",
        [commit, auth],
      );
      await query(
        tx,
        `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,auth_context_id) values($1,$2,'resource','operant/test:thing',$3,1,$4,'create',$5,'{"data":{},"archived_at":null}',$6)`,
        [v1, project, object, commit, revision, auth],
      );
      await query(
        tx,
        `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,previous_version_id,changeset_commit_id,operation,resource_revision,snapshot_json,auth_context_id) values($1,$2,'resource','operant/test:thing',$3,2,$4,$5,'update',$6,'{"data":{},"archived_at":null}',$7)`,
        [v2, project, object, v1, commit, revision, auth],
      );
      await query(
        tx,
        `insert into comments(id,project_id,definition_kind,resource_identity,object_id,target_object_version_id,changeset_commit_id,auth_context_id,body) values($1,$2,'resource','operant/test:thing',$3,$4,$5,$6,'observed')`,
        [comment, project, object, v2, commit, auth],
      );
    });
    assertEquals(
      Number(
        (await query<{ max: number }>(
          sql,
          "select max(version) max from object_versions where project_id=$1 and object_id=$2",
          [project, object],
        )).rows[0].max,
      ),
      2,
    );
    await assertRejects(() =>
      query(
        sql!,
        "update object_versions set operation='archive' where id=$1",
        [v2],
      )
    );
    await assertRejects(() =>
      query(sql!, "delete from comments where id=$1", [comment])
    );
    await assertRejects(() =>
      query(
        sql!,
        `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,previous_version_id,changeset_commit_id,operation,resource_revision,snapshot_json,auth_context_id) values($1,$2,'resource','operant/test:thing',$3,3,$4,$5,'update',$6,'{}',$7)`,
        [ids[13], project, object, v1, commit, revision, auth],
      )
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

async function sharedEvidence(sql: Sql) {
  return (await query<{ value: string }>(
    sql,
    `select md5(string_agg(value,'|' order by value)) value from (select 'auth:'||id::text||':'||details::text value from auth_audit_events union all select 'authorization:'||id::text||':'||details::text from authorization_audit_events union all select 'migration:'||id::text||':'||details::text from pack_migration_audit_events) evidence`,
  )).rows[0].value;
}
async function sharedOwnership(sql: Sql) {
  return (await query<{ value: string }>(
    sql,
    `select string_agg(c.relname||':'||r.rolname,',' order by c.relname) value from pg_class c join pg_roles r on r.oid=c.relowner where c.relname in ('audit_events','events','auth_audit_events','authorization_audit_events','pack_migration_audit_events')`,
  )).rows[0].value;
}
async function immutableTriggerCount(sql: Sql) {
  return (await query<{ count: string }>(
    sql,
    `select count(*)::text count from pg_trigger where not tgisinternal and tgrelid in ('auth_audit_events'::regclass,'authorization_audit_events'::regclass,'pack_migration_audit_events'::regclass)`,
  )).rows[0].count;
}
