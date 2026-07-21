// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  assertNoIdleClients,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

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
) {
  const result = await matrix.harness.runJson(
    ["--json", "changeset", "stage"],
    {
      operations: [{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:approval_case",
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
