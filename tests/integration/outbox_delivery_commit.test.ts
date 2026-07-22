// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { canonicalSha256 } from "../../src/domain/ids/canonical_json.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  assertNoIdleClients,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "canonical production commit atomically enqueues every matching attachment and fault rollback is complete",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      await installAfterCommitHooks(matrix.harness.server.sql);
      const stage = await matrix.stage([operation(matrix, "atomic-success")]);
      const committed = await matrix.commit(stage.id);
      assertEquals(committed.ok, true);
      const facts = await commitFacts(matrix.harness.server.sql, stage.id);
      assertEquals(facts.commit_count, 1);
      assertEquals(facts.object_count, 1);
      assertEquals(facts.audit_count, 2);
      assertEquals(facts.event_count, 2);
      assertEquals(facts.delivery_count, 2);
      assertEquals(facts.unique_pairs, 2);
      assertEquals((await matrix.commit(stage.id)).ok, true);
      assertEquals(
        await commitFacts(matrix.harness.server.sql, stage.id),
        facts,
      );

      for (const fault of ["event", "delivery"] as const) {
        const failedStage = await matrix.stage([
          operation(matrix, `atomic-${fault}`),
        ]);
        await installFault(matrix.harness.server.sql, fault);
        const failed = await matrix.commit(failedStage.id);
        assertEquals(failed.ok, false);
        await removeFault(matrix.harness.server.sql, fault);
        assertEquals(
          await commitFacts(matrix.harness.server.sql, failedStage.id),
          {
            commit_count: 0,
            object_count: 0,
            audit_count: 0,
            event_count: 0,
            delivery_count: 0,
            unique_pairs: 0,
          },
        );
        const lifecycle = (await query<{ status: string }>(
          matrix.harness.server.sql,
          "select status from staged_changeset_lifecycle where stage_id=$1",
          [failedStage.id],
        )).rows[0];
        assertEquals(lifecycle.status, "ready");
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

function operation(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  key: string,
) {
  return {
    op: "create",
    project_id: matrix.projectId,
    resource: "test/commitmatrix:alpha",
    fields: { key, status: "ready" },
  };
}

async function installAfterCommitHooks(
  sql: Parameters<typeof query>[0],
): Promise<void> {
  const active = (await query<{ candidate: string; component: string }>(
    sql,
    `select active.candidate_revision_id candidate,component.id component
     from pack_active_revisions active join pack_component_revisions component
       on component.candidate_revision_id=active.candidate_revision_id
      and component.definition_kind='resource' and component.definition_name='alpha'
     where active.publisher='test' and active.pack_name='commitmatrix'`,
  )).rows[0];
  for (let ordinal = 0; ordinal < 2; ordinal++) {
    const hook = uuidV7();
    const attachment = uuidV7();
    const name = `after_commit_${ordinal}`;
    const identity = `test/commitmatrix:${name}`;
    const config = {
      kind: "Hook",
      spec: {
        script: `${name}.ts`,
        timeout: "30s",
        permissions: {
          net: false,
          env: false,
          read: false,
          write: false,
          run: false,
        },
        secrets: [],
        effects: { operations: [] },
        output: { schema: "delivery.v1" },
        attachments: [],
        axi: {},
      },
    };
    const declaration = {
      hook: identity,
      phase: "event.after_commit",
      resource: "test/commitmatrix:alpha",
      action: null,
      event: "object.created",
      order: ordinal,
      condition: null,
      input: { event: "$event", version: "$object_version" },
    };
    await query(
      sql,
      `insert into pack_component_revisions(id,candidate_revision_id,
       definition_kind,definition_name,definition_digest,hook_security_digest,
       hook_script_digest,hook_normalized_config,hook_script_content)
       values($1,$2,'hook',$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        hook,
        active.candidate,
        name,
        digest(await canonicalSha256(config)),
        digest(await canonicalSha256({ permissions: config.spec.permissions })),
        digest(await canonicalSha256(`source-${ordinal}`)),
        config,
        `console.log(JSON.stringify({outcome:"succeeded",summary:"${ordinal}"}));`,
      ],
    );
    await query(
      sql,
      `insert into pack_hook_attachment_revisions(id,candidate_revision_id,
       hook_revision_id,hook_identity,component_revision_id,phase,ordinal,
       declaration_digest,declaration_spec)
       values($1,$2,$3,$4,$5,'event.after_commit',$6,$7,$8::jsonb)`,
      [
        attachment,
        active.candidate,
        hook,
        identity,
        active.component,
        ordinal,
        digest(await canonicalSha256(declaration)),
        declaration,
      ],
    );
  }
}

async function commitFacts(sql: Parameters<typeof query>[0], stageId: string) {
  return (await query<{
    commit_count: number;
    object_count: number;
    audit_count: number;
    event_count: number;
    delivery_count: number;
    unique_pairs: number;
  }>(
    sql,
    `select
      (select count(*)::int from changeset_commits where stage_id=$1) commit_count,
      (select count(*)::int from object_versions where changeset_commit_id in
        (select id from changeset_commits where stage_id=$1)) object_count,
      (select count(*)::int from audit_events where changeset_commit_id in
        (select id from changeset_commits where stage_id=$1)) audit_count,
      (select count(*)::int from events where changeset_commit_id in
        (select id from changeset_commits where stage_id=$1)) event_count,
      (select count(*)::int from outbox_deliveries where changeset_commit_id in
        (select id from changeset_commits where stage_id=$1)) delivery_count,
      (select count(distinct (event_id,attachment_id))::int from outbox_deliveries
        where changeset_commit_id in (select id from changeset_commits where stage_id=$1)) unique_pairs`,
    [stageId],
  )).rows[0];
}

async function installFault(
  sql: Parameters<typeof query>[0],
  fault: "event" | "delivery",
) {
  const table = fault === "event" ? "events" : "outbox_deliveries";
  await query(
    sql,
    `create function outbox_test_fail_${fault}() returns trigger language plpgsql as $$
       begin raise exception 'injected outbox ${fault} failure'; end $$;
     create trigger outbox_test_fail_${fault} after insert on ${table}
       for each row execute function outbox_test_fail_${fault}()`,
  );
}
async function removeFault(
  sql: Parameters<typeof query>[0],
  fault: "event" | "delivery",
) {
  const table = fault === "event" ? "events" : "outbox_deliveries";
  await query(
    sql,
    `drop trigger outbox_test_fail_${fault} on ${table};
     drop function outbox_test_fail_${fault}()`,
  );
}
function digest(value: string) {
  return `sha256:${value}`;
}
