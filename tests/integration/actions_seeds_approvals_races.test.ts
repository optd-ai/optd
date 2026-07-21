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
    const pack = await Deno.makeTempDir({ prefix: "operant-approval-races-" });
    try {
      assertEquals((await harness.runOptctl(["--json", "home"])).code, 0);
      await writeRacePack(pack);
      const applied = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(applied.code, 0, applied.stderr);
      const project = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "approval-races",
        "--display-name",
        "Approval Races",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id as string;
      const auth = await currentAuth(harness.server.sql);
      const repository = new PostgresStageRepository(harness.server.sql);
      await grantReviewer(harness.server.sql, auth.principalId);
      const stage = (
        actor: AuthContext,
        minimum: number,
        overrides: Record<string, unknown> = {},
      ) => stageApproval(harness, projectId, actor, minimum, overrides);
      const first = await stage(auth, 1);
      const before = await immutableSnapshot(harness.server.sql, first.stageId);
      const same = await queueTwo(
        harness.server.sql,
        first.stageId,
        () =>
          repository.decideApproval(first.stageId, first.requirementId, {
            decision: "approve",
            reason: "first",
          }, auth),
        () =>
          repository.decideApproval(first.stageId, first.requirementId, {
            decision: "approve",
            reason: "second",
          }, auth),
      );
      assertEquals(same.every((result) => result.ok), true);
      await assertRepeatedFact(
        harness.server.sql,
        first.stageId,
        auth.principalId,
        same,
        "approve",
        "first",
      );
      await assertDecisionState(
        harness.server.sql,
        first.stageId,
        "approve",
        "ready",
        2,
        1,
      );
      assertEquals(
        await immutableSnapshot(harness.server.sql, first.stageId),
        before,
      );

      for (const firstDecision of ["approve", "reject"] as const) {
        const opposite = await stage(auth, 1);
        const secondDecision = firstDecision === "approve"
          ? "reject"
          : "approve";
        const results = await queueTwo(
          harness.server.sql,
          opposite.stageId,
          () =>
            repository.decideApproval(
              opposite.stageId,
              opposite.requirementId,
              {
                decision: firstDecision,
                reason: firstDecision === "reject" ? "first reject" : null,
              },
              auth,
            ),
          () =>
            repository.decideApproval(
              opposite.stageId,
              opposite.requirementId,
              {
                decision: secondDecision,
                reason: secondDecision === "reject" ? "second reject" : null,
              },
              auth,
            ),
        );
        assertEquals(results.every((result) => result.ok), true);
        await assertRepeatedFact(
          harness.server.sql,
          opposite.stageId,
          auth.principalId,
          results,
          firstDecision,
          firstDecision === "reject" ? "first reject" : null,
        );
        await assertDecisionState(
          harness.server.sql,
          opposite.stageId,
          firstDecision,
          firstDecision === "reject" ? "rejected" : "ready",
          2,
          1,
        );
      }

      const selfDenied = await stage(auth, 1, { allow_initiator: false });
      assertEquals(
        (await repository.decideApproval(
          selfDenied.stageId,
          selfDenied.requirementId,
          { decision: "approve", reason: null },
          auth,
        )).ok,
        false,
      );
      const expired = await stage(auth, 1, {
        expires_at: new Date(Date.now() + 2_000).toISOString(),
      });
      await new Promise((resolve) => setTimeout(resolve, 2_100));
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
      const typeDenied = await stage(agent, 1);
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
      const roleDenied = await stage(ordinary, 1);
      assertEquals(
        (await repository.decideApproval(
          roleDenied.stageId,
          roleDenied.requirementId,
          { decision: "approve", reason: null },
          ordinary,
        )).ok,
        false,
      );
      const ordinaryGrant = await grantReviewer(
        harness.server.sql,
        ordinary.principalId,
      );
      const reviewerStage = await stage(auth, 1, {
        role: ordinaryGrant.role,
        allow_initiator: false,
      });
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

      const roleRevoked = await createHumanAuth(harness.server.sql, false);
      const roleGrant = await grantReviewer(
        harness.server.sql,
        roleRevoked.principalId,
      );
      const roleStage = await stage(auth, 1, {
        role: roleGrant.role,
        allow_initiator: false,
      });
      const roleResult = await queueOneWithMutation(
        harness.server.sql,
        roleStage.stageId,
        () =>
          repository.decideApproval(
            roleStage.stageId,
            roleStage.requirementId,
            { decision: "approve", reason: null },
            roleRevoked,
          ),
        () =>
          query(
            harness.server.sql,
            "update role_assignments set active=false where id=$1",
            [roleGrant.roleAssignmentId],
          ),
      );
      assertEquals(roleResult.ok, false);
      await assertUnchangedLifecycle(harness.server.sql, roleStage.stageId);

      const policyRevoked = await createHumanAuth(harness.server.sql, false);
      const policyGrant = await grantReviewer(
        harness.server.sql,
        policyRevoked.principalId,
      );
      const policyStage = await stage(auth, 1, {
        role: policyGrant.role,
        allow_initiator: false,
      });
      const policyResult = await queueOneWithMutation(
        harness.server.sql,
        policyStage.stageId,
        () =>
          repository.decideApproval(
            policyStage.stageId,
            policyStage.requirementId,
            { decision: "approve", reason: null },
            policyRevoked,
          ),
        () =>
          query(
            harness.server.sql,
            "update policy_assignments set active=false where id=$1",
            [policyGrant.policyAssignmentId],
          ),
      );
      assertEquals(policyResult.ok, false);
      await assertUnchangedLifecycle(harness.server.sql, policyStage.stageId);
      await query(
        harness.server.sql,
        "update policy_assignments set active=true where id=$1",
        [policyGrant.policyAssignmentId],
      );

      const expiringStage = await stage(auth, 1, {
        expires_at: new Date(Date.now() + 2_000).toISOString(),
      });
      const expiryResult = await queueOneWithMutation(
        harness.server.sql,
        expiringStage.stageId,
        () =>
          repository.decideApproval(
            expiringStage.stageId,
            expiringStage.requirementId,
            { decision: "approve", reason: null },
            auth,
          ),
        () => new Promise((resolve) => setTimeout(resolve, 2_100)),
      );
      assertEquals(expiryResult.ok, false);
      await assertUnchangedLifecycle(harness.server.sql, expiringStage.stageId);

      const chainedAgent = await createAuthorizedAgent(
        harness.server.sql,
        auth,
        ordinaryGrant.role,
      );
      const agentStage = await stage(auth, 1, {
        role: ordinaryGrant.role,
        principal_types: ["agent_user"],
        allow_initiator: false,
      });
      const agentResult = await queueOneWithMutation(
        harness.server.sql,
        agentStage.stageId,
        () =>
          repository.decideApproval(
            agentStage.stageId,
            agentStage.requirementId,
            { decision: "approve", reason: null },
            chainedAgent.auth,
          ),
        () =>
          query(
            harness.server.sql,
            "update agent_authorizations set revoked_at=now() where id=$1",
            [chainedAgent.authorizationId],
          ),
      );
      assertEquals(agentResult.ok, false);
      await assertUnchangedLifecycle(harness.server.sql, agentStage.stageId);
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
      await grantReviewer(harness.server.sql, secondAdmin.principalId);
      const quorum = await stage(auth, 2);
      const quorumResults = await queueTwo(
        harness.server.sql,
        quorum.stageId,
        () =>
          repository.decideApproval(quorum.stageId, quorum.requirementId, {
            decision: "approve",
            reason: "reviewer a",
          }, auth),
        () =>
          repository.decideApproval(quorum.stageId, quorum.requirementId, {
            decision: "approve",
            reason: "reviewer b",
          }, secondAdmin),
      );
      assertEquals(quorumResults.every((result) => result.ok), true);
      assertResponseProjection(quorumResults[0], "awaiting_approval", 1, 1);
      assertResponseProjection(quorumResults[1], "ready", 2, 2);
      assertEquals(
        immutableDto(dtoOf(quorumResults[0])),
        immutableDto(dtoOf(quorumResults[1])),
      );
      await assertDecisionState(
        harness.server.sql,
        quorum.stageId,
        "approve",
        "ready",
        2,
        2,
      );

      for (const rejectFirst of [true, false]) {
        const distinct = await stage(auth, 2);
        const firstActor = rejectFirst ? auth : secondAdmin;
        const secondActor = rejectFirst ? secondAdmin : auth;
        const distinctResults = await queueTwo(
          harness.server.sql,
          distinct.stageId,
          () =>
            repository.decideApproval(
              distinct.stageId,
              distinct.requirementId,
              {
                decision: rejectFirst ? "reject" : "approve",
                reason: rejectFirst ? "reject first" : null,
              },
              firstActor,
            ),
          () =>
            repository.decideApproval(
              distinct.stageId,
              distinct.requirementId,
              {
                decision: rejectFirst ? "approve" : "reject",
                reason: rejectFirst ? null : "reject second",
              },
              secondActor,
            ),
        );
        if (rejectFirst) {
          assertEquals(distinctResults[0].ok, true);
          assertEquals(distinctResults[1].ok, false);
          await assertDecisionState(
            harness.server.sql,
            distinct.stageId,
            "reject",
            "rejected",
            2,
            1,
          );
        } else {
          assertEquals(distinctResults.every((result) => result.ok), true);
          await assertDecisionState(
            harness.server.sql,
            distinct.stageId,
            "reject",
            "rejected",
            2,
            2,
          );
        }
      }

      const approvalFirst = await stage(auth, 1);
      const approvalImmutable = await immutableSnapshot(
        harness.server.sql,
        approvalFirst.stageId,
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
      const [approvalResponse, cancelResponse] = await Promise.all([
        queuedApproval,
        queuedCancel,
      ]);
      await approvalHold.done;
      assertResponseProjection(approvalResponse, "ready", 2, 1);
      assertResponseProjection(cancelResponse, "cancelled", 3, 1);
      assertEquals(
        await lifecycle(harness.server.sql, approvalFirst.stageId),
        { status: "cancelled", version: "3" },
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [approvalFirst.stageId],
        ),
        "1",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_audit_events where stage_id=$1",
          [approvalFirst.stageId],
        ),
        "1",
      );
      assertEquals(
        await immutableSnapshot(harness.server.sql, approvalFirst.stageId),
        approvalImmutable,
      );

      const cancelFirst = await stage(auth, 1);
      const cancelImmutable = await immutableSnapshot(
        harness.server.sql,
        cancelFirst.stageId,
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
      const [cancelFirstResponse, deniedApproval] = await Promise.all([
        firstCancel,
        laterApproval,
      ]);
      await cancelHold.done;
      assertResponseProjection(cancelFirstResponse, "cancelled", 2, 0);
      assertEquals(deniedApproval.ok, false);
      assertEquals(
        await lifecycle(harness.server.sql, cancelFirst.stageId),
        { status: "cancelled", version: "2" },
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_decisions where stage_id=$1",
          [cancelFirst.stageId],
        ),
        "0",
      );
      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*) from staged_approval_audit_events where stage_id=$1",
          [cancelFirst.stageId],
        ),
        "0",
      );
      assertEquals(
        await immutableSnapshot(harness.server.sql, cancelFirst.stageId),
        cancelImmutable,
      );

      assertEquals(
        await scalar(
          harness.server.sql,
          "select count(*)::text count from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='idle in transaction'",
          [],
        ),
        "0",
      );

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
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

function dtoOf(result: unknown): Record<string, unknown> {
  const value = result as { ok: boolean; value?: Record<string, unknown> };
  if (!value.ok || !value.value) throw new Error("expected complete stage DTO");
  return value.value;
}
function immutableDto(dto: Record<string, unknown>) {
  return JSON.stringify(
    Object.fromEntries(
      [
        "id",
        "schema_version",
        "source",
        "created_at",
        "created_auth_context_id",
        "operation_graph_digest",
        "stage_digest",
        "projects",
        "pack_revisions",
        "operations",
        "dependencies",
        "hook_executions",
        "policy_decisions",
        "warnings",
        "approval_requirements",
        "planned_events",
        "planned_deliveries",
      ].map((key) => [key, dto[key]]),
    ),
  );
}
function assertResponseProjection(
  result: unknown,
  status: string,
  version: number,
  decisions: number,
) {
  const dto = dtoOf(result);
  assertEquals(dto.status, status);
  assertEquals(dto.lifecycle_version, version);
  assertEquals((dto.approval_decisions as unknown[]).length, decisions);
}
async function assertRepeatedFact(
  sql: Parameters<typeof query>[0],
  stageId: string,
  principalId: string,
  results: readonly unknown[],
  decision: string,
  reason: string | null,
) {
  const dtos = results.map(dtoOf);
  const facts = dtos.map((dto) =>
    (dto.approval_decisions as Array<Record<string, unknown>>).find((item) =>
      item.principal_id === principalId
    )
  );
  assertEquals(facts[0], facts[1]);
  assertEquals(facts[0]?.decision, decision);
  assertEquals(facts[0]?.reason, reason);
  assertEquals(immutableDto(dtos[0]), immutableDto(dtos[1]));
  const stored = (await query<Record<string, unknown>>(
    sql,
    "select id,requirement_id,principal_id,decision,reason,decided_auth_context_id,decided_at from staged_approval_decisions where stage_id=$1 and principal_id=$2",
    [stageId, principalId],
  )).rows[0];
  assertEquals(stored, facts[0]);
}

async function queueTwo<T>(
  sql: Parameters<typeof query>[0],
  stageId: string,
  first: () => Promise<T>,
  second: () => Promise<T>,
): Promise<[T, T]> {
  const immutable = await immutableSnapshot(sql, stageId);
  const hold = holdLifecycle(sql, stageId);
  await hold.locked;
  const firstResult = first();
  await waitForLifecycleWaiters(sql, 1);
  const secondResult = second();
  await waitForLifecycleWaiters(sql, 2);
  hold.release();
  const results = await Promise.all([firstResult, secondResult]);
  await hold.done;
  assertEquals(await immutableSnapshot(sql, stageId), immutable);
  return results as [T, T];
}
async function queueOneWithMutation<T>(
  sql: Parameters<typeof query>[0],
  stageId: string,
  request: () => Promise<T>,
  mutate: () => Promise<unknown>,
): Promise<T> {
  const immutable = await immutableSnapshot(sql, stageId);
  const hold = holdLifecycle(sql, stageId);
  await hold.locked;
  const result = request();
  await waitForLifecycleWaiters(sql, 1);
  await mutate();
  hold.release();
  await hold.done;
  const settled = await result;
  assertEquals(await immutableSnapshot(sql, stageId), immutable);
  return settled;
}
async function assertDecisionState(
  sql: Parameters<typeof query>[0],
  stageId: string,
  decision: string,
  status: string,
  version: number,
  count: number,
) {
  const projection = await lifecycle(sql, stageId);
  assertEquals(projection.status, status);
  assertEquals(Number(projection.version), version);
  assertEquals(
    await scalar(
      sql,
      "select count(*) from staged_approval_decisions where stage_id=$1",
      [stageId],
    ),
    String(count),
  );
  assertEquals(
    await scalar(
      sql,
      "select count(*) from staged_approval_audit_events where stage_id=$1",
      [stageId],
    ),
    String(count),
  );
  if (count === 1) {
    assertEquals(
      (await query<{ decision: string }>(
        sql,
        "select decision from staged_approval_decisions where stage_id=$1 limit 1",
        [stageId],
      )).rows[0]?.decision,
      decision,
    );
  } else {
    assertEquals(
      (await query<{ present: boolean }>(
        sql,
        "select exists(select 1 from staged_approval_decisions where stage_id=$1 and decision=$2) present",
        [stageId, decision],
      )).rows[0].present,
      true,
    );
  }
}
async function assertUnchangedLifecycle(
  sql: Parameters<typeof query>[0],
  stageId: string,
) {
  const projection = await lifecycle(sql, stageId);
  assertEquals(projection, { status: "awaiting_approval", version: "1" });
  assertEquals(
    await scalar(
      sql,
      "select count(*) from staged_approval_decisions where stage_id=$1",
      [stageId],
    ),
    "0",
  );
  assertEquals(
    await scalar(
      sql,
      "select count(*) from staged_approval_audit_events where stage_id=$1",
      [stageId],
    ),
    "0",
  );
}

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
async function writeRacePack(root: string): Promise<void> {
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/roles`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: races, version: 1.0.0 }\nspec: { purpose: Deterministic approval race evidence., axi: {} }\n`,
  );
  await Deno.writeTextFile(
    `${root}/roles/reviewer.yaml`,
    `kind: Role\napiVersion: operant.dev/v1\nmetadata: { name: reviewer }\nspec:\n  display_name: Race Reviewer\n  description: Exact reviewer role for deterministic approval races.\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/resources/approval_case.yaml`,
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: approval_case }\nspec:\n  fields:\n    name: { type: string, required: true, unique: true }\n    minimum: { type: integer, required: true }\n    allow_initiator: { type: boolean, required: true }\n    principal_kind: { type: string, required: true }\n    expires_at: { type: string, required: true }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/approval.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: approval }\nspec:\n  script: approval.ts\n  permissions: { net: false, env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: approval_case, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/approval.ts`,
    `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text());const p=envelope.input.proposed;console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[{key:"race_review",role:"test/races:reviewer",boundary:{type:"system"},minimum:p.minimum,principal_types:[p.principal_kind==="agent"?"agent_user":"human_user"],allow_initiator:p.allow_initiator,expires_at:p.expires_at==="none"?null:p.expires_at,reason:"deterministic race review"}]}));`,
  );
}

async function stageApproval(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  projectId: string,
  _actor: AuthContext,
  minimum: number,
  overrides: Record<string, unknown> = {},
) {
  const result = await harness.runJson(["--json", "changeset", "stage"], {
    project_id: projectId,
    operations: [{
      op: "create",
      resource: "test/races:approval_case",
      fields: {
        name: `race-${crypto.randomUUID()}`,
        minimum,
        allow_initiator: overrides.allow_initiator ?? true,
        principal_kind: Array.isArray(overrides.principal_types) &&
            overrides.principal_types[0] === "agent_user"
          ? "agent"
          : "human",
        expires_at: overrides.expires_at ?? "none",
      },
    }],
  });
  assertEquals(result.code, 0, result.stderr);
  const dto = JSON.parse(result.stdout).data;
  assertEquals(dto.operations.length, 1);
  assertEquals(dto.dependencies.length > 0, true);
  assertEquals(dto.hook_executions.length, 1);
  assertEquals(dto.policy_decisions.length > 0, true);
  assertEquals(dto.approval_requirements.length, 1);
  return {
    stageId: dto.id as string,
    requirementId: dto.approval_requirements[0].id as string,
  };
}
async function grantReviewer(
  sql: Parameters<typeof query>[0],
  principalId: string,
) {
  const role = "test/races:reviewer";
  const roleAssignmentId = uuidV7();
  await query(
    sql,
    "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,$3,'system',true)",
    [roleAssignmentId, principalId, role],
  );
  let policyAssignmentId = (await query<{ id: string }>(
    sql,
    `select pa.id from policy_assignments pa join policy_definition_versions pdv on pdv.id=pa.policy_definition_version_id join policy_rules pr on pr.policy_definition_version_id=pdv.id where pr.role_id=$1 and pr.capability='changeset.approval.decide' limit 1`,
    [role],
  )).rows[0]?.id;
  if (!policyAssignmentId) {
    const version = uuidV7();
    policyAssignmentId = uuidV7();
    await query(
      sql,
      "insert into policy_definition_versions(id,policy_id,version,active) values($1,'system:approval_races',1,true)",
      [version],
    );
    await query(
      sql,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind) values($1,$2,$3,'changeset.approval.decide','system:changeset-approval','unconditional')",
      [uuidV7(), version, role],
    );
    await query(
      sql,
      "insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,'system',true)",
      [policyAssignmentId, version],
    );
  }
  return { roleAssignmentId, policyAssignmentId, role };
}

async function createAuthorizedAgent(
  sql: Parameters<typeof query>[0],
  anchor: AuthContext,
  role: string,
) {
  const principalId = uuidV7(),
    agentUserId = uuidV7(),
    authorizationId = uuidV7(),
    sessionId = uuidV7(),
    contextId = uuidV7();
  await query(
    sql,
    "insert into principals(id,type,active) values($1,'agent_user',true)",
    [principalId],
  );
  await query(
    sql,
    "insert into agent_users(id,principal_id,human_user_id,name) values($1,$2,$3,'approval agent')",
    [agentUserId, principalId, anchor.humanUserId],
  );
  await (sql as import("../../src/adapters/outbound/postgres/client.ts").Sql)
    .begin(async (tx) => {
      await query(
        tx,
        "insert into agent_authorizations(id,agent_user_id,human_user_id,root_authorization_id,approved_by_auth_context_id) values($1,$2,$3,$1,$4)",
        [authorizationId, agentUserId, anchor.humanUserId, anchor.id],
      );
    });
  await query(
    sql,
    "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type) values($1,$2,$3,'system')",
    [uuidV7(), authorizationId, role],
  );
  await query(
    sql,
    "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest,authorization_id) values($1,$2,$3,'agent_authorization',$4,$5)",
    [
      sessionId,
      principalId,
      anchor.humanUserId,
      `sha256:${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
      authorizationId,
    ],
  );
  await query(
    sql,
    "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at,authorization_id) values($1,$2,$3,$4,'agent_authorization',$5,now(),$6)",
    [
      contextId,
      principalId,
      anchor.humanUserId,
      sessionId,
      [role],
      authorizationId,
    ],
  );
  return {
    authorizationId,
    auth: Object.freeze({
      ...anchor,
      id: contextId,
      principalId,
      principalType: "agent_user" as const,
      sessionId,
      credentialKind: "agent_authorization" as const,
      roles: [role],
      authorizationId,
    }),
  };
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
  const snapshot = (await query<Record<string, unknown>>(
    sql,
    `select to_jsonb(s) staged_changeset,
      (select jsonb_agg(to_jsonb(o) order by ordinal) from staged_changeset_operations o where o.stage_id=s.id) operations,
      (select jsonb_agg(to_jsonb(d) order by ordinal) from staged_changeset_dependencies d where d.stage_id=s.id) dependencies,
      (select jsonb_agg(to_jsonb(h) order by ordinal) from staged_hook_executions h where h.stage_id=s.id) hooks,
      (select jsonb_agg(to_jsonb(p) order by ordinal) from staged_policy_decisions p where p.stage_id=s.id) policies,
      (select jsonb_agg(to_jsonb(r) order by ordinal) from staged_approval_requirements r where r.stage_id=s.id) requirements
     from staged_changesets s where s.id=$1`,
    [stageId],
  )).rows[0];
  for (
    const collection of [
      "operations",
      "dependencies",
      "hooks",
      "policies",
      "requirements",
    ]
  ) {
    assertEquals(
      Array.isArray(snapshot[collection]) &&
        (snapshot[collection] as unknown[]).length > 0,
      true,
      `${collection} immutable evidence must be nonempty`,
    );
  }
  return JSON.stringify(snapshot);
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
