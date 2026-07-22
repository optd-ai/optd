// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  assertNoIdleClients,
  commitAfterObservedLifecycleBarrier,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production authorization facts mutate only after the exact lifecycle waiter is observed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      for (const mutation of ["session", "principal", "human"] as const) {
        const stage = await matrix.stage([{
          op: "create",
          project_id: matrix.projectId,
          resource: "test/commitmatrix:gamma",
          fields: { key: `observed-actor-${mutation}`, status: "ready" },
        }]);
        const result = await commitAfterObservedLifecycleBarrier(
          matrix,
          stage.id,
          async () => {
            if (mutation === "session") {
              await query(
                matrix.harness.server.sql,
                "update auth_sessions set revoked_at=now() where id=$1",
                [matrix.auth.sessionId],
              );
            } else if (mutation === "principal") {
              await query(
                matrix.harness.server.sql,
                "update principals set active=false where id=$1",
                [matrix.auth.principalId],
              );
            } else {await query(
                matrix.harness.server.sql,
                "update human_users set status='disabled',disabled_at=now() where id=$1",
                [matrix.auth.humanUserId],
              );}
          },
        );
        await assertAuthFailure(
          matrix,
          stage.id,
          result,
          "authorization_changed",
        );
        await restoreHuman(matrix, matrix.auth);
      }

      const actionSource = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "observed-source-action-object", status: "ready" },
      }]);
      assertEquals((await matrix.commit(actionSource.id)).ok, true);
      const actionSourceId = String(actionSource.operations[0].object_id);
      const sourceStages: Array<{ kind: string; id: string }> = [];
      const directSource = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "observed-source-direct", status: "ready" },
      }]);
      sourceStages.push({ kind: "direct", id: directSource.id });
      const actionResult = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "action",
        "stage",
        "test/commitmatrix:generate",
        "--input",
        JSON.stringify({
          project_id: matrix.projectId,
          source_id: actionSourceId,
        }),
      ]);
      assertEquals(actionResult.code, 0, actionResult.stderr);
      sourceStages.push({
        kind: "action",
        id: JSON.parse(actionResult.stdout).data.id,
      });
      const seedResult = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "seed",
        "stage",
        "test/commitmatrix",
        "--seed",
        "alpha",
      ]);
      assertEquals(seedResult.code, 0, seedResult.stderr);
      sourceStages.push({
        kind: "seed",
        id: JSON.parse(seedResult.stdout).data.stage.id,
      });
      const superAssignment = (await query<{ id: string }>(
        matrix.harness.server.sql,
        `select id from role_assignments where principal_id=$1 and role_id='system:super_admin' and active limit 1`,
        [matrix.auth.principalId],
      )).rows[0].id;
      for (const source of sourceStages) {
        const result = await commitAfterObservedLifecycleBarrier(
          matrix,
          source.id,
          async () => {
            await query(
              matrix.harness.server.sql,
              "update role_assignments set active=false where id=$1",
              [superAssignment],
            );
          },
        );
        await assertAuthFailure(
          matrix,
          source.id,
          result,
          "authorization_changed",
        );
        await query(
          matrix.harness.server.sql,
          "update role_assignments set active=true where id=$1",
          [superAssignment],
        );
      }

      const agent = await createAgent(matrix);
      for (const authorization of [agent.root, agent.leaf]) {
        const stage = await matrix.stage([{
          op: "create",
          project_id: matrix.projectId,
          resource: "test/commitmatrix:gamma",
          fields: {
            key: `observed-agent-${authorization.slice(-8)}`,
            status: "ready",
          },
        }], agent.auth);
        const result = await commitAfterObservedLifecycleBarrier(
          matrix,
          stage.id,
          async () => {
            await query(
              matrix.harness.server.sql,
              "update agent_authorizations set revoked_at=now() where id=$1",
              [authorization],
            );
          },
          agent.auth,
        );
        await assertAuthFailure(
          matrix,
          stage.id,
          result,
          "authorization_ancestor_invalid",
        );
        await query(
          matrix.harness.server.sql,
          "update agent_authorizations set revoked_at=null where id=$1",
          [authorization],
        );
      }

      const ordinary = await createHuman(matrix, false);
      const authority = await grantWriter(matrix, ordinary.principalId);
      const cases: Array<
        { name: string; mutate(): Promise<void>; restore(): Promise<void> }
      > = [{
        name: "role-assignment",
        mutate: () =>
          query(
            matrix.harness.server.sql,
            "update role_assignments set active=false where id=$1",
            [authority.roleAssignment],
          ).then(() => undefined),
        restore: () =>
          query(
            matrix.harness.server.sql,
            "update role_assignments set active=true where id=$1",
            [authority.roleAssignment],
          ).then(() => undefined),
      }, {
        name: "role-definition",
        mutate: () =>
          query(
            matrix.harness.server.sql,
            "update role_definition_versions set active=false where role_id=$1",
            [authority.role],
          ).then(() => undefined),
        restore: () =>
          query(
            matrix.harness.server.sql,
            "update role_definition_versions set active=true where role_id=$1",
            [authority.role],
          ).then(() => undefined),
      }, {
        name: "policy-assignment",
        mutate: () =>
          query(
            matrix.harness.server.sql,
            "update policy_assignments set active=false where id=$1",
            [authority.policyAssignment],
          ).then(() => undefined),
        restore: () =>
          query(
            matrix.harness.server.sql,
            "update policy_assignments set active=true where id=$1",
            [authority.policyAssignment],
          ).then(() => undefined),
      }, {
        name: "policy-definition",
        mutate: () =>
          query(
            matrix.harness.server.sql,
            "update policy_definition_versions set active=false where id=$1",
            [authority.policyDefinition],
          ).then(() => undefined),
        restore: () =>
          query(
            matrix.harness.server.sql,
            "update policy_definition_versions set active=true where id=$1",
            [authority.policyDefinition],
          ).then(() => undefined),
      }, {
        name: "abac",
        mutate: () =>
          query(
            matrix.harness.server.sql,
            "update policy_rules set predicate='note == \"deny\"' where id=$1",
            [authority.abacRule],
          ).then(() => undefined),
        restore: () =>
          query(
            matrix.harness.server.sql,
            "update policy_rules set predicate='note == \"allow\"' where id=$1",
            [authority.abacRule],
          ).then(() => undefined),
      }];
      for (const authorityCase of cases) {
        const stage = await matrix.stage([{
          op: "create",
          project_id: matrix.projectId,
          resource: "test/commitmatrix:alpha",
          fields: {
            key: `observed-${authorityCase.name}`,
            status: "ready",
            note: "allow",
          },
        }], ordinary);
        const result = await commitAfterObservedLifecycleBarrier(
          matrix,
          stage.id,
          authorityCase.mutate,
          ordinary,
        );
        await assertAuthFailure(
          matrix,
          stage.id,
          result,
          "authorization_changed",
        );
        await authorityCase.restore();
      }

      const unconditionalStage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "observed-unconditional", status: "ready" },
      }], ordinary);
      const unconditionalResult = await commitAfterObservedLifecycleBarrier(
        matrix,
        unconditionalStage.id,
        async () => {
          await query(
            matrix.harness.server.sql,
            "update policy_rules set capability='archive' where id=$1",
            [authority.unconditionalRule],
          );
        },
        ordinary,
      );
      await assertAuthFailure(
        matrix,
        unconditionalStage.id,
        unconditionalResult,
        "authorization_changed",
      );

      const secondProject = await matrix.harness.runOptctl([
        "--json",
        "project",
        "create",
        `matrix-second-${crypto.randomUUID().slice(0, 8)}`,
        "--display-name",
        "Matrix Second Project",
      ]);
      assertEquals(secondProject.code, 0, secondProject.stderr);
      const secondProjectId = JSON.parse(secondProject.stdout).data
        .id as string;
      await query(
        matrix.harness.server.sql,
        "update role_assignments set boundary_type='all_projects',project_id=null where id=$1",
        [authority.roleAssignment],
      );
      await query(
        matrix.harness.server.sql,
        "update policy_assignments set boundary_type='all_projects',project_id=null where id=$1",
        [authority.policyAssignment],
      );
      const multiProject = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "observed-multi-first", status: "ready", note: "allow" },
      }, {
        op: "create",
        project_id: secondProjectId,
        resource: "test/commitmatrix:alpha",
        fields: {
          key: "observed-multi-second",
          status: "ready",
          note: "allow",
        },
      }], ordinary);
      const multiResult = await commitAfterObservedLifecycleBarrier(
        matrix,
        multiProject.id,
        async () => {
          await query(
            matrix.harness.server.sql,
            "update role_assignments set boundary_type='project',project_id=$2 where id=$1",
            [authority.roleAssignment, matrix.projectId],
          );
        },
        ordinary,
      );
      await assertAuthFailure(
        matrix,
        multiProject.id,
        multiResult,
        "authorization_changed",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production one-statement cutoff rejects current session principal and human changes with zero facts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      for (const mutation of ["session", "principal", "human"] as const) {
        const stage = await matrix.stage([{
          op: "create",
          project_id: matrix.projectId,
          resource: "test/commitmatrix:alpha",
          fields: { key: `current-${mutation}`, status: "ready" },
        }]);
        if (mutation === "session") {
          await query(
            matrix.harness.server.sql,
            "update auth_sessions set revoked_at=now() where id=$1",
            [matrix.auth.sessionId],
          );
        } else if (mutation === "principal") {
          await query(
            matrix.harness.server.sql,
            "update principals set active=false where id=$1",
            [matrix.auth.principalId],
          );
        } else {
          await query(
            matrix.harness.server.sql,
            "update human_users set status='disabled',disabled_at=now() where id=$1",
            [matrix.auth.humanUserId],
          );
        }
        await assertAuthorizationChanged(matrix, stage.id);
        await query(
          matrix.harness.server.sql,
          "update auth_sessions set revoked_at=null where id=$1",
          [matrix.auth.sessionId],
        );
        await query(
          matrix.harness.server.sql,
          "update principals set active=true where id=$1",
          [matrix.auth.principalId],
        );
        await query(
          matrix.harness.server.sql,
          "update human_users set status='active',disabled_at=null where id=$1",
          [matrix.auth.humanUserId],
        );
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production cutoff rejects every revoked caller agent authorization ancestor",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const agent = await createAgent(matrix);
      for (const authorizationId of [agent.root, agent.leaf]) {
        const stage = await matrix.stage([{
          op: "create",
          project_id: matrix.projectId,
          resource: "test/commitmatrix:alpha",
          fields: {
            key: `agent-${authorizationId.slice(-8)}`,
            status: "ready",
          },
        }], agent.auth);
        await query(
          matrix.harness.server.sql,
          "update agent_authorizations set revoked_at=now() where id=$1",
          [authorizationId],
        );
        const result = await matrix.commit(stage.id, agent.auth);
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.error.code, "authorization_ancestor_invalid");
        }
        assertEquals(
          (await query<{ count: string }>(
            matrix.harness.server.sql,
            "select count(*)::text count from changeset_commits where stage_id=$1",
            [stage.id],
          )).rows[0].count,
          "0",
        );
        await query(
          matrix.harness.server.sql,
          "update agent_authorizations set revoked_at=null where id=$1",
          [authorizationId],
        );
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production cutoff evaluates current ABAC replacement and direct same-Project ReBAC",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const ordinary = await createHuman(matrix, false);
      const policy = await grantWriter(matrix, ordinary.principalId);
      const denied = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "abac-denied", status: "ready", note: "allow" },
      }], ordinary);
      await query(
        matrix.harness.server.sql,
        "update policy_rules set predicate='note == \"deny\"' where id=$1",
        [policy.abacRule],
      );
      await assertAuthorizationChanged(matrix, denied.id, ordinary);
      await query(
        matrix.harness.server.sql,
        "update policy_rules set predicate='note == \"allow\"' where id=$1",
        [policy.abacRule],
      );

      const stillAllowed = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "abac-replaced", status: "ready", note: "allow" },
      }], ordinary);
      await query(
        matrix.harness.server.sql,
        "update policy_rules set predicate='note != \"deny\"' where id=$1",
        [policy.abacRule],
      );
      const allowed = await matrix.commit(stillAllowed.id, ordinary);
      assertEquals(allowed.ok, true);

      const owned = await matrix.stage([{
        op: "create",
        key: "owned",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "rebac-object", status: "ready" },
      }, {
        op: "link",
        key: "owner",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_owner",
        from: { $ref: "owned.object_id" },
        to: ordinary.principalId,
        fields: {},
      }]);
      assertEquals((await matrix.commit(owned.id)).ok, true);
      const objectId = String(owned.operations[0].object_id);
      const relationshipId = String(owned.operations[1].relationship_id);
      const rebacStage = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: objectId,
        set: { note: "owner update" },
      }], ordinary);
      const rebacAllowed = await matrix.commit(rebacStage.id, ordinary);
      assertEquals(rebacAllowed.ok, true);

      const rebacDenied = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: objectId,
        set: { note: "staged owner update" },
      }], ordinary);
      const rebacResult = await commitAfterObservedLifecycleBarrier(
        matrix,
        rebacDenied.id,
        async () => {
          const unlink = await matrix.stage([{
            op: "unlink",
            project_id: matrix.projectId,
            relationship: "test/commitmatrix:alpha_owner",
            relationship_id: relationshipId,
          }]);
          assertEquals((await matrix.commit(unlink.id)).ok, true);
        },
        ordinary,
      );
      await assertAuthFailure(
        matrix,
        rebacDenied.id,
        rebacResult,
        "authorization_changed",
      );

      const cutoffs = (await query<{ cutoff: string }>(
        matrix.harness.server.sql,
        `select distinct policy_summary_json->>'authorization_cutoff_at' cutoff
         from audit_events where changeset_commit_id in
           (select id from changeset_commits where stage_id=$1)`,
        [stillAllowed.id],
      )).rows;
      assertEquals(cutoffs.length, 1);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

async function createAgent(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
) {
  const principal = uuidV7(), user = uuidV7(), root = uuidV7(), leaf = uuidV7();
  const session = uuidV7(), context = uuidV7();
  await query(
    matrix.harness.server.sql,
    "insert into principals(id,type,active) values($1,'agent_user',true)",
    [principal],
  );
  await query(
    matrix.harness.server.sql,
    "insert into agent_users(id,principal_id,human_user_id,name) values($1,$2,$3,'Matrix Agent')",
    [user, principal, matrix.auth.humanUserId],
  );
  await matrix.harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into agent_authorizations(id,agent_user_id,human_user_id,root_authorization_id,approved_by_auth_context_id)
       values($1,$2,$3,$1,$4)`,
      [root, user, matrix.auth.humanUserId, matrix.auth.id],
    );
    await query(
      tx,
      `insert into agent_authorizations(id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id)
       values($1,$2,$3,$4,$4,$5)`,
      [leaf, user, matrix.auth.humanUserId, root, matrix.auth.id],
    );
  });
  await query(
    matrix.harness.server.sql,
    "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type) values($1,$2,'system:super_admin','system')",
    [uuidV7(), leaf],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest,authorization_id)
     values($1,$2,$3,'agent_authorization',$4,$5)`,
    [
      session,
      principal,
      matrix.auth.humanUserId,
      `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      leaf,
    ],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at,authorization_id)
     values($1,$2,$3,$4,'agent_authorization','{system:super_admin}',now(),$5)`,
    [context, principal, matrix.auth.humanUserId, session, leaf],
  );
  return {
    root,
    leaf,
    auth: {
      id: context,
      principalId: principal,
      principalType: "agent_user" as const,
      humanUserId: matrix.auth.humanUserId,
      sessionId: session,
      credentialKind: "agent_authorization" as const,
      roles: ["system:super_admin"],
      authorizationId: leaf,
      createdAt: new Date().toISOString(),
    },
  };
}

async function createHuman(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  superAdmin: boolean,
): Promise<AuthContext> {
  const principal = uuidV7(),
    human = uuidV7(),
    session = uuidV7(),
    context = uuidV7();
  await query(
    matrix.harness.server.sql,
    "insert into principals(id,type,active) values($1,'human_user',true)",
    [principal],
  );
  await query(
    matrix.harness.server.sql,
    "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,'Matrix Writer','active')",
    [human, principal, `matrix-${principal.slice(-8)}`],
  );
  await query(
    matrix.harness.server.sql,
    "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full',$4)",
    [
      session,
      principal,
      human,
      `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    ],
  );
  const roles = superAdmin ? ["system:super_admin"] : [];
  await query(
    matrix.harness.server.sql,
    "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full',$5,now())",
    [context, principal, human, session, roles],
  );
  return {
    id: context,
    principalId: principal,
    principalType: "human_user",
    humanUserId: human,
    sessionId: session,
    credentialKind: "human_full",
    roles,
    createdAt: new Date().toISOString(),
  };
}

async function grantWriter(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  principal: string,
) {
  const role = "test/commitmatrix:reviewer";
  const roleAssignment = uuidV7();
  await query(
    matrix.harness.server.sql,
    "insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active) values($1,$2,$3,'project',$4,true)",
    [roleAssignment, principal, role, matrix.projectId],
  );
  const definition = uuidV7(), assignment = uuidV7(), abacRule = uuidV7();
  const revision = (await query<{ id: string }>(
    matrix.harness.server.sql,
    `select candidate_revision_id id from pack_active_revisions
     where publisher='test' and pack_name='commitmatrix'`,
  )).rows[0].id;
  await query(
    matrix.harness.server.sql,
    `insert into policy_definition_versions(id,policy_id,version,active,candidate_revision_id,definition_name)
     values($1,$2,1,true,$3,$4)`,
    [
      definition,
      `test:matrix-writer-${principal.slice(-8)}`,
      revision,
      `matrix_writer_${principal.slice(-8)}`,
    ],
  );
  await query(
    matrix.harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,predicate)
     values($1,$2,$3,'create','test/commitmatrix:alpha','abac','note == "allow"')`,
    [abacRule, definition, role],
  );
  await query(
    matrix.harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,
      relation_relationship,relation_object_side,relation_subject_side,relation_subject)
     values($1,$2,$3,'update','test/commitmatrix:alpha','rebac','test/commitmatrix:alpha_owner','from','to','actor.id')`,
    [uuidV7(), definition, role],
  );
  const unconditionalRule = uuidV7();
  await query(
    matrix.harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind)
     values($1,$2,$3,'create','test/commitmatrix:gamma','unconditional')`,
    [unconditionalRule, definition, role],
  );
  await query(
    matrix.harness.server.sql,
    "insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active) values($1,$2,'project',$3,true)",
    [assignment, definition, matrix.projectId],
  );
  return {
    abacRule,
    role,
    roleAssignment,
    policyAssignment: assignment,
    policyDefinition: definition,
    unconditionalRule,
  };
}

async function restoreHuman(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  auth: AuthContext,
) {
  await query(
    matrix.harness.server.sql,
    "update auth_sessions set revoked_at=null where id=$1",
    [auth.sessionId],
  );
  await query(
    matrix.harness.server.sql,
    "update principals set active=true where id=$1",
    [auth.principalId],
  );
  await query(
    matrix.harness.server.sql,
    "update human_users set status='active',disabled_at=null where id=$1",
    [auth.humanUserId],
  );
}

async function assertAuthFailure(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  result: Awaited<ReturnType<typeof matrix.commit>>,
  code: string,
) {
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, code);
  assertEquals(
    (await query<{ count: string }>(
      matrix.harness.server.sql,
      "select count(*)::text count from changeset_commits where stage_id=$1",
      [stageId],
    )).rows[0].count,
    "0",
  );
}

async function assertAuthorizationChanged(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  auth = matrix.auth,
) {
  const result = await matrix.commit(stageId, auth);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "authorization_changed");
  assertEquals(
    (await query<{ count: string }>(
      matrix.harness.server.sql,
      "select count(*)::text count from changeset_commits where stage_id=$1",
      [stageId],
    )).rows[0].count,
    "0",
  );
}
