// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { makePostgresQueryObjectRepository } from "../../src/adapters/outbound/postgres/repositories/query_object_repository.ts";
import { QueryCursorSigner } from "../../src/domain/queries/cursor.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("query pushes assigned ABAC before count and page on PostgreSQL", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
    throw new Error("PostgreSQL 18.4 binaries required");
  }
  const root = await Deno.makeTempDir({ prefix: "operant-query-policy-" }),
    previous = Deno.env.get("OPERANT_DATA_DIR");
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
      authId = uuidV7(),
      project = uuidV7(),
      projectTwo = uuidV7(),
      candidate = uuidV7(),
      roleVersion = uuidV7(),
      policyVersion = uuidV7(),
      assignment = uuidV7(),
      roleAssignment = uuidV7();
    await query(
      sql,
      "insert into principals(id,type,active) values($1,'human_user',true)",
      [principal],
    );
    await query(
      sql,
      "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'query-user','Query User','active')",
      [human, principal],
    );
    await query(
      sql,
      "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','query-token')",
      [session, principal, human],
    );
    await query(
      sql,
      "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{}',now())",
      [authId, principal, human, session],
    );
    await query(
      sql,
      "insert into projects(id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id) values($1,'query-project','Query Project',$3,$3),($2,'query-project-two','Query Project Two',$3,$3)",
      [project, projectTwo, authId],
    );
    const normalized = {
      resources: {
        lead: {
          kind: "Resource",
          spec: {
            fields: {
              name: { type: "string", required: true },
              score: { type: "integer", required: true },
            },
            axi: { list: { fields: ["name", "score"] } },
          },
        },
      },
    };
    await query(
      sql,
      `insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files) values($1,'operant','querytest','1.0.0',$2,$2,'{}',$3::text::jsonb,'{}')`,
      [candidate, `sha256:${"a".repeat(64)}`, JSON.stringify(normalized)],
    );
    await query(
      sql,
      "insert into pack_active_revisions values('operant','querytest',$1,now())",
      [candidate],
    );
    await query(
      sql,
      "insert into pack_runtime_tables values('operant','querytest','resource','lead','res_query_lead')",
    );
    await query(
      sql,
      "create table res_query_lead(id uuid primary key,project_id uuid not null,version bigint not null,current_object_version_id uuid,created_at timestamptz not null,updated_at timestamptz not null,archived_at timestamptz,name text,score bigint)",
    );
    await query(
      sql,
      "insert into res_query_lead values($1,$3,1,$4,now(),now(),null,'hidden',5),($2,$3,1,$5,now(),now(),null,'visible',15)",
      [uuidV7(), uuidV7(), project, uuidV7(), uuidV7()],
    );
    await query(
      sql,
      "insert into system_roles(id,display_name,active) values('operant/querytest:reader','Reader',true)",
    );
    await query(
      sql,
      "insert into role_definition_versions(id,role_id,version,active,candidate_revision_id,definition_name) values($1,'operant/querytest:reader',1,true,$2,'reader')",
      [roleVersion, candidate],
    );
    await query(
      sql,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active) values($1,$2,'operant/querytest:reader','project',$3,true)",
      [roleAssignment, principal, project],
    );
    await query(
      sql,
      "insert into policy_definition_versions(id,policy_id,version,active,candidate_revision_id,definition_name) values($1,'operant/querytest:read',1,true,$2,'read')",
      [policyVersion, candidate],
    );
    await query(
      sql,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,predicate,rule_name) values($1,$2,'operant/querytest:reader','read','operant/querytest:lead','abac','score >= 10','visible')",
      [uuidV7(), policyVersion],
    );
    await query(
      sql,
      "insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,source) values($1,$2,'project',$3,true,'operator')",
      [assignment, policyVersion, project],
    );
    const auth = {
      id: authId,
      principalId: principal,
      principalType: "human_user" as const,
      humanUserId: human,
      sessionId: session,
      credentialKind: "human_full" as const,
      roles: [],
      createdAt: new Date().toISOString(),
    };
    const service = makePostgresQueryObjectRepository({
      sql,
      cursors: () => new QueryCursorSigner("integration master key"),
    });
    const result = await service.query({
      project_id: project,
      definition: {
        kind: "resource",
        publisher: "operant",
        pack: "querytest",
        name: "lead",
      },
      fields: ["name", "score"],
      sort: [{ field: "score", direction: "asc" }],
      limit: 1,
      include_total: true,
    }, auth);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    assertEquals(result.value.items.length, 1);
    assertEquals(
      (result.value.items[0].data as Record<string, unknown>).name,
      "visible",
    );
    assertEquals(result.value.total, 1);
    assertEquals(result.value.has_more, false);

    const request = {
      project_id: project,
      definition: {
        kind: "resource" as const,
        publisher: "operant",
        pack: "querytest",
        name: "lead",
      },
    };
    await query(
      sql,
      "update role_assignments set boundary_type='system',project_id=null where id=$1",
      [roleAssignment],
    );
    await query(
      sql,
      "update policy_assignments set boundary_type='system',project_id=null where id=$1",
      [assignment],
    );
    assertEquals((await service.query(request, auth)).ok, false);
    assertEquals(
      (await service.query({ ...request, project_id: projectTwo }, auth)).ok,
      false,
    );

    await query(
      sql,
      "update role_assignments set boundary_type='all_projects',project_id=null where id=$1",
      [roleAssignment],
    );
    await query(
      sql,
      "update policy_assignments set boundary_type='all_projects',project_id=null where id=$1",
      [assignment],
    );
    assertEquals((await service.query(request, auth)).ok, true);
    const allProjectsEmpty = await service.query({
      ...request,
      project_id: projectTwo,
    }, auth);
    assertEquals(allProjectsEmpty.ok, true);
    if (allProjectsEmpty.ok) assertEquals(allProjectsEmpty.value.items, []);

    await query(
      sql,
      "update role_assignments set boundary_type='project',project_id=$2 where id=$1",
      [roleAssignment, project],
    );
    await query(
      sql,
      "update policy_assignments set boundary_type='project',project_id=$2 where id=$1",
      [assignment, project],
    );
    assertEquals((await service.query(request, auth)).ok, true);
    assertEquals(
      (await service.query({ ...request, project_id: projectTwo }, auth)).ok,
      false,
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});
