// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
} from "../../src/adapters/outbound/postgres/client.ts";
import { opaqueToken, tokenDigest } from "../../src/domain/auth/token.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { startCommitMatrix } from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "current root replacement remains canonical through read, action, stage, and commit policy flows",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const replacement = await createRootReplacement(matrix);
      const auth = replacement.auth;
      const token = replacement.token;
      const human = auth.humanUserId;
      const principal = auth.principalId;

      const identity = await api(matrix, token, "/api/v1/auth/me");
      assertEquals(identity.status, 200);
      assertEquals(identity.body.data.principal.id, principal);
      assertEquals(identity.body.data.human_user.id, human);
      assertEquals(identity.body.data.agent.authorization_id, replacement.id);
      assertEquals(
        identity.body.data.agent.root_authorization_id,
        replacement.rootId,
      );
      assertEquals(identity.body.data.agent.authorization_ancestry_ids, [
        replacement.id,
      ]);

      const source = await matrix.stage([
        alpha(matrix.projectId, "replacement-actor", principal),
        alpha(matrix.projectId, "replacement-human", human),
        alpha(matrix.projectId, "replacement-rebac", "unrelated"),
        alpha(matrix.projectId, "replacement-rebac-stale", "unrelated"),
      ], auth);
      assertEquals((await matrix.commit(source.id, auth)).ok, true);
      const [actorObject, humanObject, rebacObject, staleRebacObject] = source
        .operations.map((op) => String(op.object_id));
      const relationshipTable = await runtimeTable(
        matrix,
        "relationship",
        "alpha_owner",
      );
      await query(
        matrix.harness.server.sql,
        `insert into ${quoteIdentifier(relationshipTable)}
          (id,project_id,from_object_id,to_object_id,created_by,updated_by)
         values($1,$3,$4,$5,$6,$6),($2,$3,$7,$5,$6,$6)`,
        [
          uuidV7(),
          uuidV7(),
          matrix.projectId,
          rebacObject,
          principal,
          auth.id,
          staleRebacObject,
        ],
      );
      await installReplacementPolicies(matrix, replacement.id);
      await query(
        matrix.harness.server.sql,
        `delete from agent_authorization_roles
          where authorization_id=$1 and role_id='system:super_admin'`,
        [replacement.id],
      );

      const listed = await api(matrix, token, "/api/v1/queries", {
        project_id: matrix.projectId,
        definition: {
          kind: "resource",
          publisher: "test",
          pack: "commitmatrix",
          name: "alpha",
        },
        fields: ["key", "note"],
        sort: [{ field: "key", direction: "asc" }],
        include_total: true,
      });
      assertEquals(listed.status, 200, JSON.stringify(listed.body));
      assertEquals(listed.body.meta.total, 4);
      assertEquals(
        listed.body.data.items.map((item: { id: string }) => item.id).sort(),
        [actorObject, humanObject, rebacObject, staleRebacObject].sort(),
      );

      for (
        const objectId of [
          actorObject,
          humanObject,
          rebacObject,
          staleRebacObject,
        ]
      ) {
        const current = await api(
          matrix,
          token,
          objectPath(matrix.projectId, objectId),
        );
        assertEquals(current.status, 200, JSON.stringify(current.body));
      }
      const history = await api(
        matrix,
        token,
        `${objectPath(matrix.projectId, humanObject)}/history`,
      );
      assertEquals(history.status, 200, JSON.stringify(history.body));
      assertEquals(history.body.data.items.length, 1);

      const direct = await api(matrix, token, "/api/v1/changesets/stage", {
        operations: [alpha(matrix.projectId, "replacement-direct", human)],
      });
      assertEquals(direct.status, 201, JSON.stringify(direct.body));
      const directCommit = await api(
        matrix,
        token,
        `/api/v1/changesets/${direct.body.data.id}/commit`,
        { lock_timeout: "2s" },
      );
      assertEquals(directCommit.status, 200, JSON.stringify(directCommit.body));

      const action = await stageAction(matrix, token, rebacObject);
      assertEquals(action.status, 201, JSON.stringify(action.body));
      const actionStageId = String(action.body.data.id);
      assertEquals(
        (await query<{ source_kind: string; hooks: number }>(
          matrix.harness.server.sql,
          `select s.source_kind,
             (select count(*)::int from staged_hook_executions h where h.stage_id=s.id) hooks
             from staged_changesets s where s.id=$1`,
          [actionStageId],
        )).rows[0],
        { source_kind: "action", hooks: 1 },
      );
      const actionCommit = await api(
        matrix,
        token,
        `/api/v1/changesets/${actionStageId}/commit`,
        { lock_timeout: "2s" },
      );
      assertEquals(actionCommit.status, 200, JSON.stringify(actionCommit.body));
      const repeatedActionCommit = await api(
        matrix,
        token,
        `/api/v1/changesets/${actionStageId}/commit`,
        { lock_timeout: "2s" },
      );
      assertEquals(
        repeatedActionCommit.status,
        200,
        JSON.stringify(repeatedActionCommit.body),
      );
      assertEquals(
        repeatedActionCommit.body.data.id,
        actionCommit.body.data.id,
      );

      const substitution = await stageAction(
        matrix,
        token,
        staleRebacObject,
      );
      assertEquals(substitution.status, 201, JSON.stringify(substitution.body));
      const substitutionStageId = String(substitution.body.data.id);
      const effectRuleId = uuidV7();
      await query(
        matrix.harness.server.sql,
        `insert into policy_rules(
           id,policy_definition_version_id,role_id,capability,resource,
           condition_kind,predicate,rule_name,relation_relationship,
           relation_object_side,relation_subject_side,relation_subject)
         select $1,policy_definition_version_id,role_id,capability,
           'test/commitmatrix:gamma','unconditional',null,'substitution_effect_only',
           null,null,null,null
         from policy_rules where rule_name='action_rebac'`,
        [effectRuleId],
      );
      await query(
        matrix.harness.server.sql,
        `update policy_rules set capability='read'
          where rule_name='action_rebac'`,
      );
      const substituted = await api(
        matrix,
        token,
        `/api/v1/changesets/${substitutionStageId}/commit`,
        { lock_timeout: "2s" },
      );
      assertEquals(substituted.status, 403, JSON.stringify(substituted.body));
      assertEquals(substituted.body.error.code, "policy_changed");
      await assertNoCommitFacts(matrix, substitutionStageId);
      assertEquals(
        (await query<{ count: number }>(
          matrix.harness.server.sql,
          `select count(*)::int count from staged_hook_executions
            where stage_id=$1`,
          [substitutionStageId],
        )).rows[0].count,
        1,
      );
      await query(
        matrix.harness.server.sql,
        `update policy_rules
          set capability='action:test/commitmatrix:generate'
          where rule_name='action_rebac'`,
      );
      await query(
        matrix.harness.server.sql,
        "delete from policy_rules where id=$1",
        [effectRuleId],
      );

      const staleRelation = await api(
        matrix,
        token,
        "/api/v1/changesets/stage",
        {
          operations: [{
            op: "update",
            project_id: matrix.projectId,
            resource: "test/commitmatrix:alpha",
            object_id: staleRebacObject,
            set: { note: "still-related" },
          }],
        },
      );
      assertEquals(
        staleRelation.status,
        201,
        JSON.stringify(staleRelation.body),
      );
      const staleRelationId = String(staleRelation.body.data.id);
      await query(
        matrix.harness.server.sql,
        `update ${quoteIdentifier(relationshipTable)} set archived_at=now()
          where project_id=$1 and from_object_id=$2 and to_object_id=$3`,
        [matrix.projectId, staleRebacObject, principal],
      );
      const staleRelationCommit = await api(
        matrix,
        token,
        `/api/v1/changesets/${staleRelationId}/commit`,
        { lock_timeout: "2s" },
      );
      assertEquals(staleRelationCommit.status, 403);
      assertEquals(
        staleRelationCommit.body.error.code,
        "authorization_changed",
      );
      await assertNoCommitFacts(matrix, staleRelationId);
      await query(
        matrix.harness.server.sql,
        `update ${quoteIdentifier(relationshipTable)} set archived_at=null
          where project_id=$1 and from_object_id=$2 and to_object_id=$3`,
        [matrix.projectId, staleRebacObject, principal],
      );

      for (const mutation of ["revoked_at", "superseded_at"] as const) {
        const pending = await api(matrix, token, "/api/v1/changesets/stage", {
          operations: [
            alpha(matrix.projectId, `replacement-${mutation}`, human),
          ],
        });
        assertEquals(pending.status, 201, JSON.stringify(pending.body));
        const pendingId = String(pending.body.data.id);
        await query(
          matrix.harness.server.sql,
          `update agent_authorizations set ${mutation}=now() where id=$1`,
          [replacement.id],
        );
        const contextsBefore = await contextCount(
          matrix,
          replacement.sessionId,
        );
        const invalid = await api(
          matrix,
          token,
          `/api/v1/changesets/${pendingId}/commit`,
          { lock_timeout: "2s" },
        );
        assertEquals(invalid.status, 401);
        assertEquals(invalid.body.error.code, "credential_invalid");
        assertEquals(
          await contextCount(matrix, replacement.sessionId),
          contextsBefore,
        );
        await assertNoCommitFacts(matrix, pendingId);
        await query(
          matrix.harness.server.sql,
          `update agent_authorizations set ${mutation}=null where id=$1`,
          [replacement.id],
        );
      }
    } finally {
      await matrix.close();
    }
  },
});

function alpha(projectId: string, key: string, note: string) {
  return {
    op: "create",
    project_id: projectId,
    resource: "test/commitmatrix:alpha",
    fields: { key, status: "ready", note },
  };
}

async function createRootReplacement(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
) {
  const principalId = uuidV7();
  const agentUserId = uuidV7();
  const rootId = uuidV7();
  const id = uuidV7();
  const sessionId = uuidV7();
  const contextId = uuidV7();
  const token = opaqueToken();
  await query(
    matrix.harness.server.sql,
    "insert into principals(id,type,active) values($1,'agent_user',true)",
    [principalId],
  );
  await query(
    matrix.harness.server.sql,
    `insert into agent_users(id,principal_id,human_user_id,name)
     values($1,$2,$3,'Root replacement matrix agent')`,
    [agentUserId, principalId, matrix.auth.humanUserId],
  );
  await matrix.harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into agent_authorizations(
         id,agent_user_id,human_user_id,root_authorization_id,
         approved_by_auth_context_id,superseded_at)
       values($1,$2,$3,$1,$4,now())`,
      [rootId, agentUserId, matrix.auth.humanUserId, matrix.auth.id],
    );
    await query(
      tx,
      `insert into agent_authorizations(
         id,agent_user_id,human_user_id,parent_authorization_id,
         root_authorization_id,approved_by_auth_context_id)
       values($1,$2,$3,null,$4,$5)`,
      [id, agentUserId, matrix.auth.humanUserId, rootId, matrix.auth.id],
    );
  });
  await query(
    matrix.harness.server.sql,
    `insert into agent_authorization_roles(
       id,authorization_id,role_id,boundary_type)
     values($1,$2,'system:super_admin','system')`,
    [uuidV7(), id],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_sessions(
       id,principal_id,human_user_id,credential_kind,token_digest,authorization_id)
     values($1,$2,$3,'agent_authorization',$4,$5)`,
    [
      sessionId,
      principalId,
      matrix.auth.humanUserId,
      await tokenDigest(token),
      id,
    ],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_contexts(
       id,principal_id,human_user_id,session_id,credential_kind,roles,
       created_at,authorization_id)
     values($1,$2,$3,$4,'agent_authorization','{system:super_admin}',now(),$5)`,
    [contextId, principalId, matrix.auth.humanUserId, sessionId, id],
  );
  return {
    id,
    rootId,
    sessionId,
    token,
    auth: {
      id: contextId,
      principalId,
      principalType: "agent_user" as const,
      humanUserId: matrix.auth.humanUserId,
      sessionId,
      authorizationId: id,
      credentialKind: "agent_authorization" as const,
      roles: ["system:super_admin"],
      createdAt: new Date().toISOString(),
    },
  };
}

async function installReplacementPolicies(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  authorizationId: string,
) {
  const policy = uuidV7();
  const revision = (await query<{ id: string }>(
    matrix.harness.server.sql,
    `select candidate_revision_id id from pack_active_revisions
      where publisher='test' and pack_name='commitmatrix'`,
  )).rows[0].id;
  await query(
    matrix.harness.server.sql,
    `insert into agent_authorization_roles(
       id,authorization_id,role_id,boundary_type,project_id)
     values($1,$2,'test/commitmatrix:reviewer','project',$3)`,
    [uuidV7(), authorizationId, matrix.projectId],
  );
  await query(
    matrix.harness.server.sql,
    `insert into policy_definition_versions(
       id,policy_id,version,active,candidate_revision_id,definition_name)
     values($1,'test:root_replacement_policy',1,true,$2,'root_replacement_policy')`,
    [policy, revision],
  );
  const rules = [
    [
      "read_actor",
      "read",
      "test/commitmatrix:alpha",
      "abac",
      "note == actor.id",
      null,
      null,
    ],
    [
      "read_human",
      "read",
      "test/commitmatrix:alpha",
      "abac",
      "note == actor.human_user_id",
      null,
      null,
    ],
    [
      "read_rebac",
      "read",
      "test/commitmatrix:alpha",
      "rebac",
      null,
      "test/commitmatrix:alpha_owner",
      "actor.id",
    ],
    [
      "history_human",
      "history.read",
      "test/commitmatrix:alpha",
      "abac",
      "note == actor.human_user_id",
      null,
      null,
    ],
    [
      "create_human",
      "create",
      "test/commitmatrix:alpha",
      "unconditional",
      null,
      null,
      null,
    ],
    [
      "update_rebac",
      "update",
      "test/commitmatrix:alpha",
      "rebac",
      null,
      "test/commitmatrix:alpha_owner",
      "actor.id",
    ],
    [
      "action_rebac",
      "action:test/commitmatrix:generate",
      "test/commitmatrix:alpha",
      "rebac",
      null,
      "test/commitmatrix:alpha_owner",
      "actor.id",
    ],
    [
      "create_effect",
      "create",
      "test/commitmatrix:gamma",
      "unconditional",
      null,
      null,
      null,
    ],
  ];
  for (
    const [name, capability, resource, kind, predicate, relation, subject]
      of rules
  ) {
    await query(
      matrix.harness.server.sql,
      `insert into policy_rules(
         id,policy_definition_version_id,role_id,capability,resource,
         condition_kind,predicate,rule_name,relation_relationship,
         relation_object_side,relation_subject_side,relation_subject)
       values($1,$2,'test/commitmatrix:reviewer',$3,$4,$5,$6,$7,$8,
         case when $8::text is null then null else 'from' end,
         case when $8::text is null then null else 'to' end,$9)`,
      [
        uuidV7(),
        policy,
        capability,
        resource,
        kind,
        predicate,
        name,
        relation,
        subject,
      ],
    );
  }
  await query(
    matrix.harness.server.sql,
    `insert into policy_assignments(
       id,policy_definition_version_id,boundary_type,project_id,active,source)
     values($1,$2,'project',$3,true,'operator')`,
    [uuidV7(), policy, matrix.projectId],
  );
}

async function stageAction(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  token: string,
  sourceId: string,
) {
  return await api(
    matrix,
    token,
    "/api/v1/actions/test/commitmatrix/generate/stage",
    {
      project_id: matrix.projectId,
      input: { project_id: matrix.projectId, source_id: sourceId },
    },
  );
}

function objectPath(projectId: string, objectId: string): string {
  return `/api/v1/projects/${projectId}/objects/test/commitmatrix/alpha/${objectId}`;
}

async function runtimeTable(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  kind: string,
  name: string,
): Promise<string> {
  return (await query<{ table_name: string }>(
    matrix.harness.server.sql,
    `select table_name from pack_runtime_tables
      where publisher='test' and pack_name='commitmatrix'
        and definition_kind=$1 and definition_name=$2`,
    [kind, name],
  )).rows[0].table_name;
}

async function contextCount(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  sessionId: string,
): Promise<number> {
  return (await query<{ count: number }>(
    matrix.harness.server.sql,
    "select count(*)::int count from auth_contexts where session_id=$1",
    [sessionId],
  )).rows[0].count;
}

async function assertNoCommitFacts(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
) {
  assertEquals(
    (await query<{ commits: number; versions: number }>(
      matrix.harness.server.sql,
      `select
         (select count(*)::int from changeset_commits where stage_id=$1) commits,
         (select count(*)::int from object_versions where changeset_commit_id in
           (select id from changeset_commits where stage_id=$1)) versions`,
      [stageId],
    )).rows[0],
    { commits: 0, versions: 0 },
  );
}

type ApiBody = {
  data: {
    id: string;
    principal: { id: string };
    human_user: { id: string };
    agent: {
      authorization_id: string;
      root_authorization_id: string;
      authorization_ancestry_ids: string[];
    };
    items: Array<{ id: string }>;
  };
  meta: { total: number };
  error: { code: string };
};

async function api(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  token: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: ApiBody }> {
  const response = await fetch(`${matrix.harness.baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: await response.json() as ApiBody,
  };
}
