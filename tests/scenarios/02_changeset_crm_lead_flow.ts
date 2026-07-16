import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test(
  "CRM lead changeset preview/commit/view/history and auditable idempotent seeds",
  { ignore: true },
  async () => {
    const harness = await startAuthenticatedHarness();
    try {
      const apply = await harness.runOptctl([
        "pack",
        "apply",
        "tests/fixtures/packs/crm-default-pack",
        "--json",
      ]);
      assertEquals(apply.code, 0, apply.stderr);
      const applyJson = JSON.parse(apply.stdout);
      assertEquals(applyJson.data.seeds.planned, 20);
      assertEquals(
        applyJson.data.seeds.committed + applyJson.data.seeds.skipped,
        20,
      );

      const seedCounts = await query<
        {
          lead_statuses: string;
          stages: string;
          teams: string;
          seed_versions: string;
          seed_audits: string;
          seed_events: string;
        }
      >(
        harness.server.sql,
        `select
        (select count(*)::text from res_lead_status) as lead_statuses,
        (select count(*)::text from res_opportunity_stage) as stages,
        (select count(*)::text from res_sales_team) as teams,
        (select count(*)::text from object_versions where actor_id='system:seed') as seed_versions,
        (select count(*)::text from audit_events where actor_id='system:seed') as seed_audits,
        (select count(*)::text from events e join changesets c on c.id=e.changeset_id where c.actor_id='system:seed') as seed_events`,
      );
      assert(Number(seedCounts.rows[0].lead_statuses) >= 5);
      assert(Number(seedCounts.rows[0].stages) >= 5);
      assert(Number(seedCounts.rows[0].teams) >= 2);
      assert(Number(seedCounts.rows[0].seed_versions) >= 20);
      assert(Number(seedCounts.rows[0].seed_audits) >= 20);
      assert(Number(seedCounts.rows[0].seed_events) >= 20);
      const countsBeforeReapply = {
        lead_statuses: seedCounts.rows[0].lead_statuses,
        stages: seedCounts.rows[0].stages,
        teams: seedCounts.rows[0].teams,
      };

      const tempDir = await Deno.makeTempDir({
        prefix: "operant-changeset-json-",
      });
      const leadId = `lead_live_${crypto.randomUUID()}`;
      const createPath = `${tempDir}/create.json`;
      await Deno.writeTextFile(
        createPath,
        JSON.stringify({
          idempotency_key: "lead-live-create",
          operations: [{
            op: "create",
            resource: "default.lead",
            as: "lead",
            fields: {
              id: leadId,
              name: "Jane Agent",
              email: "jane@example.com",
              status: "new",
              source: "scenario",
              owner_id: "agent_1",
            },
          }],
        }),
      );
      const preview = await harness.runOptctl([
        "changeset",
        "preview",
        createPath,
        "--json",
      ]);
      assertEquals(preview.code, 0, preview.stderr);
      const previewJson = JSON.parse(preview.stdout);
      assertEquals(previewJson.data.committable, true);
      assertEquals(previewJson.data.operations[0].id, leadId);

      const create = await harness.runOptctl([
        "changeset",
        "commit",
        createPath,
        "--json",
      ]);
      assertEquals(create.code, 0, create.stderr);
      const createJson = JSON.parse(create.stdout);
      assertEquals(createJson.data.committed, true);
      assertEquals(createJson.data.object_versions[0].version, 1);

      const updatePath = `${tempDir}/update.json`;
      await Deno.writeTextFile(
        updatePath,
        JSON.stringify({
          operations: [{
            op: "update",
            resource: "default.lead",
            id: leadId,
            expected_version: 1,
            fields: { status: "contacted", score: 42 },
          }],
        }),
      );
      const update = await harness.runOptctl([
        "changeset",
        "commit",
        updatePath,
        "--json",
      ]);
      assertEquals(update.code, 0, update.stderr);

      const conflictPath = `${tempDir}/conflict.json`;
      await Deno.writeTextFile(
        conflictPath,
        JSON.stringify({
          operations: [{
            op: "update",
            resource: "default.lead",
            id: leadId,
            expected_version: 1,
            fields: { score: 43 },
          }],
        }),
      );
      const conflict = await harness.runOptctl([
        "changeset",
        "commit",
        conflictPath,
        "--json",
      ]);
      assertEquals(conflict.code, 1);
      assertStringIncludes(conflict.stderr, "version_conflict");

      const commentPath = `${tempDir}/comment.json`;
      await Deno.writeTextFile(
        commentPath,
        JSON.stringify({
          operations: [{
            op: "comment",
            resource: "default.lead",
            id: leadId,
            expected_version: 2,
            body: "Called and qualified next steps.",
          }],
        }),
      );
      const comment = await harness.runOptctl([
        "changeset",
        "commit",
        commentPath,
        "--json",
      ]);
      assertEquals(comment.code, 0, comment.stderr);

      const view = await harness.runOptctl([
        "view",
        "default.lead",
        leadId,
        "--json",
      ]);
      assertEquals(view.code, 0, view.stderr);
      const viewJson = JSON.parse(view.stdout);
      assertEquals(
        viewJson.data.object.current_object_version_id,
        JSON.parse(comment.stdout).data.object_versions[0].id,
      );
      assertEquals(viewJson.data.object.version, 3);
      assertEquals(viewJson.data.object.score, 42);

      const archivePath = `${tempDir}/archive.json`;
      await Deno.writeTextFile(
        archivePath,
        JSON.stringify({
          operations: [{
            op: "archive",
            resource: "default.lead",
            id: leadId,
            expected_version: 3,
          }],
        }),
      );
      const archive = await harness.runOptctl([
        "changeset",
        "commit",
        archivePath,
        "--json",
      ]);
      assertEquals(archive.code, 0, archive.stderr);

      const history = await harness.runOptctl([
        "history",
        "default.lead",
        leadId,
        "--json",
      ]);
      assertEquals(history.code, 0, history.stderr);
      const historyJson = JSON.parse(history.stdout);
      assertEquals(historyJson.data.versions.length, 4);
      assertEquals(
        historyJson.data.versions.map((v: { operation: string }) =>
          v.operation
        ),
        ["create", "update", "comment", "archive"],
      );
      assertEquals(historyJson.data.comments.length, 1);
      assert(
        historyJson.data.audit_events.some((e: { event_type: string }) =>
          e.event_type === "object.archived"
        ),
      );
      assert(
        historyJson.data.events.some((e: { event_type: string }) =>
          e.event_type === "comment.added"
        ),
      );

      const current = await query<
        { version: number; current_object_version_id: string }
      >(
        harness.server.sql,
        "select version,current_object_version_id from res_lead where id=$1",
        [leadId],
      );
      const latest = await query<
        { id: string; version: number; snapshot_json: { version: number } }
      >(
        harness.server.sql,
        "select id,version,snapshot_json from object_versions where resource='default.lead' and object_id=$1 order by version desc limit 1",
        [leadId],
      );
      assertEquals(current.rows[0].version, 4);
      assertEquals(
        current.rows[0].current_object_version_id,
        latest.rows[0].id,
      );
      const latestSnapshot = typeof latest.rows[0].snapshot_json === "string"
        ? JSON.parse(latest.rows[0].snapshot_json)
        : latest.rows[0].snapshot_json;
      assertEquals(latestSnapshot.version, 4);

      const reapply = await harness.runOptctl([
        "pack",
        "apply",
        "tests/fixtures/packs/crm-default-pack",
        "--json",
      ]);
      assertEquals(reapply.code, 0, reapply.stderr);
      const countsAfterReapply = await query<
        { lead_statuses: string; stages: string; teams: string }
      >(
        harness.server.sql,
        `select
        (select count(*)::text from res_lead_status) as lead_statuses,
        (select count(*)::text from res_opportunity_stage) as stages,
        (select count(*)::text from res_sales_team) as teams`,
      );
      assertEquals(countsAfterReapply.rows[0], countsBeforeReapply);
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } finally {
      await harness.close();
    }
  },
);
