// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  assertNoIdleClients,
  commitAfterObservedLifecycleBarrier,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production approval facts mutate only after the exact lifecycle waiter is observed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const approver = await createApprover(matrix);
      for (
        const mutation of [
          "principal",
          "human",
          "role",
          "role_version",
          "boundary",
        ] as const
      ) {
        const stage = await stageApproval(matrix, `observed-${mutation}`);
        const decision = await new PostgresStageRepository(
          matrix.harness.server.sql,
        )
          .decideApproval(stage.id, stage.requirementId, {
            decision: "approve",
            reason: null,
          }, approver.auth);
        assertEquals(decision.ok, true);
        if (mutation === "principal") {
          for (
            const statement of [
              "update staged_approval_requirements set requirement_json=requirement_json where id=$1",
              "delete from staged_approval_requirements where id=$1",
              "update staged_approval_decisions set reason=reason where requirement_id=$1",
              "delete from staged_approval_decisions where requirement_id=$1",
            ]
          ) {
            await assertRejects(() =>
              query(matrix.harness.server.sql, statement, [stage.requirementId])
            );
          }
        }
        const result = await commitAfterObservedLifecycleBarrier(
          matrix,
          stage.id,
          async () => {
            if (mutation === "principal") {
              await query(
                matrix.harness.server.sql,
                "update principals set active=false where id=$1",
                [approver.auth.principalId],
              );
            } else if (mutation === "human") {
              await query(
                matrix.harness.server.sql,
                "update human_users set status='disabled',disabled_at=now() where id=$1",
                [approver.auth.humanUserId],
              );
            } else if (mutation === "role") {
              await query(
                matrix.harness.server.sql,
                "update role_assignments set active=false where id=$1",
                [approver.reviewerAssignment],
              );
            } else if (mutation === "role_version") {
              await query(
                matrix.harness.server.sql,
                "update role_definition_versions set active=false where role_id='test/commitmatrix:reviewer'",
              );
            } else {await query(
                matrix.harness.server.sql,
                "update role_assignments set boundary_type='all_projects' where id=$1",
                [approver.reviewerAssignment],
              );}
          },
        );
        assertEquals(result.ok, false);
        if (!result.ok) assertEquals(result.error.code, "approval_changed");
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
          "update principals set active=true where id=$1",
          [approver.auth.principalId],
        );
        await query(
          matrix.harness.server.sql,
          "update human_users set status='active',disabled_at=null where id=$1",
          [approver.auth.humanUserId],
        );
        await query(
          matrix.harness.server.sql,
          "update role_assignments set active=true,boundary_type='system' where id=$1",
          [approver.reviewerAssignment],
        );
        await query(
          matrix.harness.server.sql,
          "update role_definition_versions set active=true where role_id='test/commitmatrix:reviewer'",
        );
      }
      const agentApprover = await createAgentApprover(matrix);
      for (const authorization of [agentApprover.root, agentApprover.leaf]) {
        const agentStage = await stageApproval(
          matrix,
          `observed-agent-${authorization.slice(-8)}`,
          "approval_agent",
        );
        const agentDecision = await new PostgresStageRepository(
          matrix.harness.server.sql,
        )
          .decideApproval(agentStage.id, agentStage.requirementId, {
            decision: "approve",
            reason: null,
          }, agentApprover.auth);
        assertEquals(agentDecision.ok, true);
        const invalid = await commitAfterObservedLifecycleBarrier(
          matrix,
          agentStage.id,
          async () => {
            await query(
              matrix.harness.server.sql,
              "update agent_authorizations set revoked_at=now() where id=$1",
              [authorization],
            );
          },
        );
        assertEquals(invalid.ok, false);
        if (!invalid.ok) assertEquals(invalid.error.code, "approval_changed");
        await query(
          matrix.harness.server.sql,
          "update agent_authorizations set revoked_at=null where id=$1",
          [authorization],
        );
      }

      const rejectingApprover = await createApprover(matrix);
      const rejectedStage = await stageApproval(matrix, "observed-rejection");
      const approved = await new PostgresStageRepository(
        matrix.harness.server.sql,
      )
        .decideApproval(rejectedStage.id, rejectedStage.requirementId, {
          decision: "approve",
          reason: null,
        }, approver.auth);
      assertEquals(approved.ok, true);
      const rejected = await commitAfterObservedLifecycleBarrier(
        matrix,
        rejectedStage.id,
        async () => {
          await query(
            matrix.harness.server.sql,
            `insert into staged_approval_decisions(id,stage_id,requirement_id,principal_id,decision,reason,decided_auth_context_id)
           values($1,$2,$3,$4,'reject','observed rejection',$5)`,
            [
              uuidV7(),
              rejectedStage.id,
              rejectedStage.requirementId,
              rejectingApprover.auth.principalId,
              rejectingApprover.auth.id,
            ],
          );
        },
      );
      assertEquals(rejected.ok, false);
      if (!rejected.ok) assertEquals(rejected.error.code, "approval_changed");
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [rejectedStage.id],
        )).rows[0].count,
        "0",
      );

      const expiring = await stageApproval(
        matrix,
        "observed-expiry",
        "approval_expiring",
      );
      const expiringApproval = await new PostgresStageRepository(
        matrix.harness.server.sql,
      )
        .decideApproval(expiring.id, expiring.requirementId, {
          decision: "approve",
          reason: null,
        }, approver.auth);
      assertEquals(expiringApproval.ok, true);
      const expired = await commitAfterObservedLifecycleBarrier(
        matrix,
        expiring.id,
        async () => {
          const deadline = Date.now() + 8_000;
          while (Date.now() < deadline) {
            const current = (await query<{ expired: boolean }>(
              matrix.harness.server.sql,
              `select (requirement_json->>'expires_at')::timestamptz<=statement_timestamp() expired
             from staged_approval_requirements where id=$1`,
              [expiring.requirementId],
            )).rows[0];
            if (current.expired) return;
            await Promise.resolve();
          }
          throw new Error(
            "approval expiry was not reached within bounded database observations",
          );
        },
      );
      assertEquals(expired.ok, false);
      if (!expired.ok) assertEquals(expired.error.code, "approval_changed");
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production approval cutoff revalidates approver principal human and exact active versioned role",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const approver = await createApprover(matrix);
      for (
        const mutation of [
          "principal",
          "human",
          "role",
          "role_version",
        ] as const
      ) {
        const stage = await stageApproval(matrix, mutation);
        const decision = await new PostgresStageRepository(
          matrix.harness.server.sql,
        )
          .decideApproval(stage.id, stage.requirementId, {
            decision: "approve",
            reason: null,
          }, approver.auth);
        assertEquals(decision.ok, true);
        if (mutation === "principal") {
          await query(
            matrix.harness.server.sql,
            "update principals set active=false where id=$1",
            [approver.auth.principalId],
          );
        } else if (mutation === "human") {
          await query(
            matrix.harness.server.sql,
            "update human_users set status='disabled',disabled_at=now() where id=$1",
            [approver.auth.humanUserId],
          );
        } else if (mutation === "role") {
          await query(
            matrix.harness.server.sql,
            "update role_assignments set active=false where id=$1",
            [approver.reviewerAssignment],
          );
        } else {
          await query(
            matrix.harness.server.sql,
            "update role_definition_versions set active=false where role_id='test/commitmatrix:reviewer'",
          );
        }
        const committed = await matrix.commit(stage.id);
        assertEquals(committed.ok, false);
        if (!committed.ok) {
          assertEquals(committed.error.code, "approval_changed");
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
          "update principals set active=true where id=$1",
          [approver.auth.principalId],
        );
        await query(
          matrix.harness.server.sql,
          "update human_users set status='active',disabled_at=null where id=$1",
          [approver.auth.humanUserId],
        );
        await query(
          matrix.harness.server.sql,
          "update role_assignments set active=true where id=$1",
          [approver.reviewerAssignment],
        );
        await query(
          matrix.harness.server.sql,
          "update role_definition_versions set active=true where role_id='test/commitmatrix:reviewer'",
        );
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

async function stageApproval(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  suffix: string,
  resource = "approval_case",
) {
  const result = await matrix.harness.runJson(
    ["--json", "changeset", "stage"],
    {
      operations: [{
        op: "create",
        project_id: matrix.projectId,
        resource: `test/commitmatrix:${resource}`,
        fields: { key: `approval-cutoff-${suffix}` },
      }],
    },
  );
  assertEquals(result.code, 0, result.stderr);
  const dto = JSON.parse(result.stdout).data;
  assertEquals(dto.status, "awaiting_approval");
  return {
    id: dto.id as string,
    requirementId: dto.approval_requirements[0].id as string,
  };
}

async function createAgentApprover(
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
    "insert into agent_users(id,principal_id,human_user_id,name) values($1,$2,$3,'Approval Agent')",
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
  for (const role of ["system:super_admin", "test/commitmatrix:reviewer"]) {
    await query(
      matrix.harness.server.sql,
      "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type) values($1,$2,$3,'system')",
      [uuidV7(), leaf, role],
    );
  }
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
     values($1,$2,$3,$4,'agent_authorization',$5,now(),$6)`,
    [context, principal, matrix.auth.humanUserId, session, [
      "system:super_admin",
      "test/commitmatrix:reviewer",
    ], leaf],
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
      roles: ["system:super_admin", "test/commitmatrix:reviewer"],
      authorizationId: leaf,
      createdAt: new Date().toISOString(),
    },
  };
}

async function createApprover(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
): Promise<{ auth: AuthContext; reviewerAssignment: string }> {
  const principal = uuidV7(),
    human = uuidV7(),
    session = uuidV7(),
    context = uuidV7();
  const reviewerAssignment = uuidV7();
  await query(
    matrix.harness.server.sql,
    "insert into principals(id,type,active) values($1,'human_user',true)",
    [principal],
  );
  await query(
    matrix.harness.server.sql,
    "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,'Matrix Approver','active')",
    [human, principal, `approver-${principal.slice(-8)}`],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest)
     values($1,$2,$3,'human_full',$4)`,
    [
      session,
      principal,
      human,
      `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    ],
  );
  await query(
    matrix.harness.server.sql,
    `insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at)
     values($1,$2,$3,$4,'human_full','{system:super_admin,test/commitmatrix:reviewer}',now())`,
    [context, principal, human, session],
  );
  await query(
    matrix.harness.server.sql,
    `insert into role_assignments(id,principal_id,role_id,boundary_type,active) values
      ($1,$2,'test/commitmatrix:reviewer','system',true),
      ($3,$2,'system:super_admin','system',true)`,
    [reviewerAssignment, principal, uuidV7()],
  );
  return {
    reviewerAssignment,
    auth: {
      id: context,
      principalId: principal,
      principalType: "human_user",
      humanUserId: human,
      sessionId: session,
      credentialKind: "human_full",
      roles: ["system:super_admin", "test/commitmatrix:reviewer"],
      createdAt: new Date().toISOString(),
    },
  };
}
