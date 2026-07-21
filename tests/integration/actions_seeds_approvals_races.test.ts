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
