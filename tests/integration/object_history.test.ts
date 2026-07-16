import { assertEquals, assertRejects } from "jsr:@std/assert";
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

const ids = Array.from(
  { length: 14 },
  (_, index) =>
    `019a0000-0000-7${index.toString(16).padStart(3, "0")}-8000-000000000001`,
);

Deno.test("Project history is immutable, chained, unique, and comments do not bump versions", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-object-history-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
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
        [ids[11], project, object, v1, commit, revision, auth],
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
