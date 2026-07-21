// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test({
  name:
    "PG18 approval decisions serialize, deduplicate, audit atomically, and preserve immutable evidence",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startAuthenticatedHarness();
    try {
      assertEquals((await harness.runOptctl(["--json", "home"])).code, 0);
      const auth = await currentAuth(harness.server.sql);
      const repository = new PostgresStageRepository(harness.server.sql);
      const first = await insertApprovalStage(harness.server.sql, auth, 1);
      const before = await immutableSnapshot(harness.server.sql, first.stageId);
      const [sameA, sameB] = await Promise.all([
        repository.decideApproval(first.stageId, first.requirementId, {
          decision: "approve",
          reason: "reviewed",
        }, auth),
        repository.decideApproval(first.stageId, first.requirementId, {
          decision: "approve",
          reason: "duplicate",
        }, auth),
      ]);
      assertEquals(sameA.ok, true);
      assertEquals(sameB.ok, true);
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [first.stageId],
        ),
        "1",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_audit_events where stage_id=$1",
          [first.stageId],
        ),
        "1",
      );
      assertEquals(
        (await lifecycle(harness.server.sql, first.stageId)).status,
        "ready",
      );
      assertEquals(
        await immutableSnapshot(harness.server.sql, first.stageId),
        before,
      );

      const opposite = await insertApprovalStage(harness.server.sql, auth, 1);
      const results = await Promise.all([
        repository.decideApproval(opposite.stageId, opposite.requirementId, {
          decision: "approve",
          reason: null,
        }, auth),
        repository.decideApproval(opposite.stageId, opposite.requirementId, {
          decision: "reject",
          reason: "unsafe",
        }, auth),
      ]);
      assertEquals(results.every((result) => result.ok), true);
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [opposite.stageId],
        ),
        "1",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_audit_events where stage_id=$1",
          [opposite.stageId],
        ),
        "1",
      );

      const selfDenied = await insertApprovalStage(
        harness.server.sql,
        auth,
        1,
        { allow_initiator: false },
      );
      assertEquals(
        (await repository.decideApproval(
          selfDenied.stageId,
          selfDenied.requirementId,
          { decision: "approve", reason: null },
          auth,
        )).ok,
        false,
      );
      const expired = await insertApprovalStage(harness.server.sql, auth, 1, {
        expires_at: "2000-01-01T00:00:00.000Z",
      });
      assertEquals(
        (await repository.decideApproval(
          expired.stageId,
          expired.requirementId,
          { decision: "approve", reason: null },
          auth,
        )).ok,
        false,
      );
      const agent = await createAgentAuth(harness.server.sql, auth);
      const typeDenied = await insertApprovalStage(
        harness.server.sql,
        agent,
        1,
      );
      assertEquals(
        (await repository.decideApproval(
          typeDenied.stageId,
          typeDenied.requirementId,
          { decision: "approve", reason: null },
          agent,
        )).ok,
        false,
      );
      const ordinary = await createHumanAuth(harness.server.sql, false);
      const roleDenied = await insertApprovalStage(
        harness.server.sql,
        ordinary,
        1,
      );
      assertEquals(
        (await repository.decideApproval(
          roleDenied.stageId,
          roleDenied.requirementId,
          { decision: "approve", reason: null },
          ordinary,
        )).ok,
        false,
      );
      const reviewerStage = await insertApprovalStage(
        harness.server.sql,
        auth,
        1,
        { role: "system:admin", allow_initiator: false },
      );
      await grantReviewer(harness.server.sql, ordinary.principalId);
      assertEquals(
        (await repository.approvals(reviewerStage.stageId, ordinary)).ok,
        true,
      );
      assertEquals(
        (await repository.decideApproval(
          reviewerStage.stageId,
          reviewerStage.requirementId,
          { decision: "approve", reason: "ordinary reviewer" },
          ordinary,
        )).ok,
        true,
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id in ($1,$2,$3,$4)",
          [
            selfDenied.stageId,
            expired.stageId,
            typeDenied.stageId,
            roleDenied.stageId,
          ],
        ),
        "0",
      );

      const secondAdmin = await createHumanAuth(harness.server.sql, true);
      const quorum = await insertApprovalStage(harness.server.sql, auth, 2);
      assertEquals(
        (await repository.decideApproval(quorum.stageId, quorum.requirementId, {
          decision: "approve",
          reason: null,
        }, auth)).ok,
        true,
      );
      assertEquals(
        (await lifecycle(harness.server.sql, quorum.stageId)).status,
        "awaiting_approval",
      );
      assertEquals(
        (await repository.decideApproval(quorum.stageId, quorum.requirementId, {
          decision: "approve",
          reason: null,
        }, secondAdmin)).ok,
        true,
      );
      assertEquals(
        (await lifecycle(harness.server.sql, quorum.stageId)).status,
        "ready",
      );

      const approvalFirst = await insertApprovalStage(
        harness.server.sql,
        auth,
        1,
      );
      const approvalHold = holdLifecycle(
        harness.server.sql,
        approvalFirst.stageId,
      );
      await approvalHold.locked;
      const queuedApproval = repository.decideApproval(
        approvalFirst.stageId,
        approvalFirst.requirementId,
        { decision: "approve", reason: null },
        auth,
      );
      await waitForLifecycleWaiters(harness.server.sql, 1);
      const queuedCancel = repository.cancel(
        approvalFirst.stageId,
        "after approval",
        auth,
      );
      await waitForLifecycleWaiters(harness.server.sql, 2);
      approvalHold.release();
      await Promise.all([queuedApproval, queuedCancel, approvalHold.done]);
      assertEquals(
        (await lifecycle(harness.server.sql, approvalFirst.stageId)).status,
        "cancelled",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [approvalFirst.stageId],
        ),
        "1",
      );

      const cancelFirst = await insertApprovalStage(
        harness.server.sql,
        auth,
        1,
      );
      const cancelHold = holdLifecycle(harness.server.sql, cancelFirst.stageId);
      await cancelHold.locked;
      const firstCancel = repository.cancel(
        cancelFirst.stageId,
        "cancel first",
        auth,
      );
      await waitForLifecycleWaiters(harness.server.sql, 1);
      const laterApproval = repository.decideApproval(
        cancelFirst.stageId,
        cancelFirst.requirementId,
        { decision: "approve", reason: null },
        auth,
      );
      await waitForLifecycleWaiters(harness.server.sql, 2);
      cancelHold.release();
      await Promise.all([firstCancel, laterApproval, cancelHold.done]);
      assertEquals(
        (await lifecycle(harness.server.sql, cancelFirst.stageId)).status,
        "cancelled",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [cancelFirst.stageId],
        ),
        "0",
      );

      const race = await insertApprovalStage(harness.server.sql, auth, 1);
      const raced = await Promise.all([
        repository.decideApproval(race.stageId, race.requirementId, {
          decision: "approve",
          reason: null,
        }, auth),
        repository.cancel(race.stageId, "cancel race", auth),
      ]);
      assertEquals(raced.filter((result) => result.ok).length >= 1, true);
      const terminal = await lifecycle(harness.server.sql, race.stageId);
      assertEquals(["ready", "cancelled"].includes(terminal.status), true);
      const raceDecisions = await scalar(
        harness.server.sql,
        "select count(*) from staged_approval_decisions where stage_id=$1",
        [race.stageId],
      );
      const raceAudits = await scalar(
        harness.server.sql,
        "select count(*) from staged_approval_audit_events where stage_id=$1",
        [race.stageId],
      );
      assertEquals(raceAudits, raceDecisions);
      assertEquals(["0", "1"].includes(raceDecisions), true);

      await assertRejects(() =>
        query(
          harness.server.sql,
          "update staged_approval_requirements set requirement_json=requirement_json where id=$1",
          [first.requirementId],
        )
      );
      await assertRejects(() =>
        query(
          harness.server.sql,
          "delete from staged_approval_requirements where id=$1",
          [first.requirementId],
        )
      );
      const decisionId = (await query<{ id: string }>(
        harness.server.sql,
        "select id from staged_approval_decisions where stage_id=$1",
        [first.stageId],
      )).rows[0].id;
      await assertRejects(() =>
        query(
          harness.server.sql,
          "update staged_approval_decisions set reason=reason where id=$1",
          [decisionId],
        )
      );
      await assertRejects(() =>
        query(
          harness.server.sql,
          "delete from staged_approval_audit_events where stage_id=$1",
          [first.stageId],
        )
      );
    } finally {
      await harness.close();
    }
  },
});

function holdLifecycle(sql: Parameters<typeof query>[0], stageId: string) {
  let unlock!: () => void, lockedResolve!: () => void;
  const locked = new Promise<void>((resolve) => lockedResolve = resolve);
  const release = new Promise<void>((resolve) => unlock = resolve);
  const done =
    (sql as import("../../src/adapters/outbound/postgres/client.ts").Sql).begin(
      async (tx) => {
        await query(
          tx,
          "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
          [stageId],
        );
        lockedResolve();
        await release;
      },
    );
  return { locked, release: unlock, done };
}
async function waitForLifecycleWaiters(
  sql: Parameters<typeof query>[0],
  minimum: number,
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const count = Number(
      (await query<{ count: string }>(
        sql,
        `select count(*)::text count from pg_stat_activity where wait_event_type='Lock' and query like '%staged_changeset_lifecycle%'`,
      )).rows[0].count,
    );
    if (count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`expected ${minimum} lifecycle lock waiters`);
}

async function currentAuth(
  sql: Parameters<typeof query>[0],
): Promise<AuthContext> {
  const row = (await query<Record<string, unknown>>(
    sql,
    `select a.*,p.type principal_type from auth_contexts a join principals p on p.id=a.principal_id order by a.created_at desc limit 1`,
  )).rows[0];
  return Object.freeze({
    id: String(row.id),
    principalId: String(row.principal_id),
    principalType: row.principal_type as "human_user",
    humanUserId: String(row.human_user_id),
    sessionId: String(row.session_id),
    credentialKind: "human_full",
    roles: (row.roles as string[]) ?? [],
    createdAt: new Date(String(row.created_at)).toISOString(),
  });
}
async function insertApprovalStage(
  sql: Parameters<typeof query>[0],
  auth: AuthContext,
  minimum: number,
  overrides: Record<string, unknown> = {},
) {
  const stageId = uuidV7();
  const requirementId = uuidV7();
  const digest = `sha256:${"a".repeat(64)}`;
  await query(
    sql,
    `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json) values($1,1,'direct','{}',$2,$3,'{}',$4,$4,'{"schema":"changeset.operations.v1","operations":[]}','[]','[]','[]','[]','[]')`,
    [stageId, auth.id, auth.principalId, digest],
  );
  const requirement = {
    id: requirementId,
    key: "system_review",
    role: "system:super_admin",
    boundary: { type: "system" },
    minimum,
    principal_types: ["human_user"],
    allow_initiator: true,
    expires_at: null,
    reason: "system review",
    ...overrides,
  };
  await query(
    sql,
    `insert into staged_approval_requirements(id,stage_id,ordinal,requirement_json) values($1,$2,0,$3::jsonb)`,
    [requirementId, stageId, requirement],
  );
  await query(
    sql,
    `insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'awaiting_approval',1)`,
    [stageId],
  );
  return { stageId, requirementId };
}
async function grantReviewer(
  sql: Parameters<typeof query>[0],
  principalId: string,
) {
  const version = uuidV7();
  await query(
    sql,
    "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:admin','system',true)",
    [uuidV7(), principalId],
  );
  await query(
    sql,
    "insert into policy_definition_versions(id,policy_id,version,active) values($1,$2,1,true)",
    [version, `system:approval_${principalId.slice(-8)}`],
  );
  await query(
    sql,
    "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind) values($1,$2,'system:admin','changeset.approval.decide','system:changeset-approval','unconditional')",
    [uuidV7(), version],
  );
  await query(
    sql,
    "insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,'system',true)",
    [uuidV7(), version],
  );
}

async function createAgentAuth(
  sql: Parameters<typeof query>[0],
  anchor: AuthContext,
): Promise<AuthContext> {
  const principalId = uuidV7(), contextId = uuidV7();
  await query(
    sql,
    "insert into principals(id,type,active) values($1,'agent_user',true)",
    [principalId],
  );
  await query(
    sql,
    "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'agent_authorization',$5,now())",
    [contextId, principalId, anchor.humanUserId, anchor.sessionId, [
      "system:super_admin",
    ]],
  );
  return Object.freeze({
    ...anchor,
    id: contextId,
    principalId,
    principalType: "agent_user",
    credentialKind: "agent_authorization",
    roles: ["system:super_admin"],
  });
}

async function createHumanAuth(
  sql: Parameters<typeof query>[0],
  superAdmin: boolean,
): Promise<AuthContext> {
  const principalId = uuidV7(),
    humanId = uuidV7(),
    sessionId = uuidV7(),
    contextId = uuidV7();
  const suffix = principalId.slice(-8);
  await query(
    sql,
    "insert into principals(id,type,active) values($1,'human_user',true)",
    [principalId],
  );
  await query(
    sql,
    "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,$4,'active')",
    [humanId, principalId, `reviewer-${suffix}`, `Reviewer ${suffix}`],
  );
  await query(
    sql,
    "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full',$4)",
    [
      sessionId,
      principalId,
      humanId,
      `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
    ],
  );
  const roles = superAdmin ? ["system:super_admin"] : [];
  await query(
    sql,
    "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full',$5,now())",
    [contextId, principalId, humanId, sessionId, roles],
  );
  if (superAdmin) {
    await query(
      sql,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:super_admin','system',true)",
      [uuidV7(), principalId],
    );
  }
  return Object.freeze({
    id: contextId,
    principalId,
    principalType: "human_user",
    humanUserId: humanId,
    sessionId,
    credentialKind: "human_full",
    roles,
    createdAt: new Date().toISOString(),
  });
}

async function immutableSnapshot(
  sql: Parameters<typeof query>[0],
  stageId: string,
) {
  return JSON.stringify(
    (await query(
      sql,
      `select s.operation_graph_digest,s.stage_digest,s.canonical_graph_json,(select jsonb_agg(dependency_json order by ordinal) from staged_changeset_dependencies where stage_id=s.id) dependencies,(select jsonb_agg(output_json order by ordinal) from staged_hook_executions where stage_id=s.id) hooks,(select jsonb_agg(requirement_json order by ordinal) from staged_approval_requirements where stage_id=s.id) requirements from staged_changesets s where id=$1`,
      [stageId],
    )).rows[0],
  );
}
async function lifecycle(sql: Parameters<typeof query>[0], stageId: string) {
  return (await query<{ status: string; version: string }>(
    sql,
    "select status,version from staged_changeset_lifecycle where stage_id=$1",
    [stageId],
  )).rows[0];
}
async function scalar(
  sql: Parameters<typeof query>[0],
  statement: string,
  params: unknown[],
) {
  return (await query<{ count: string }>(sql, statement, params)).rows[0].count;
}
