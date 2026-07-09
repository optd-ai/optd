import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("CRM lead changeset preview/commit/view/history and auditable idempotent seeds", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP CRM changeset scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({
    prefix: "operant-changeset-scenario-",
  });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    const apply = await runOptctl([
      "--server",
      server.url,
      "pack",
      "apply",
      "prototypes/crm-default-pack",
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
      server.sql,
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
        actor_context: {
          id: "agent_1",
          roles: ["sales_rep"],
          sales_team_ids: ["direct"],
        },
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
    const preview = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "preview",
      createPath,
      "--json",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout);
    assertEquals(previewJson.data.committable, true);
    assertEquals(previewJson.data.operations[0].id, leadId);

    const create = await runOptctl([
      "--server",
      server.url,
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
        actor_context: {
          id: "agent_1",
          roles: ["sales_rep"],
          sales_team_ids: ["direct"],
        },
        operations: [{
          op: "update",
          resource: "default.lead",
          id: leadId,
          expected_version: 1,
          fields: { status: "contacted", score: 42 },
        }],
      }),
    );
    const update = await runOptctl([
      "--server",
      server.url,
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
        actor_context: {
          id: "agent_1",
          roles: ["sales_rep"],
          sales_team_ids: ["direct"],
        },
        operations: [{
          op: "update",
          resource: "default.lead",
          id: leadId,
          expected_version: 1,
          fields: { score: 43 },
        }],
      }),
    );
    const conflict = await runOptctl([
      "--server",
      server.url,
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
        actor_context: {
          id: "agent_1",
          roles: ["sales_rep"],
          sales_team_ids: ["direct"],
        },
        operations: [{
          op: "comment",
          resource: "default.lead",
          id: leadId,
          expected_version: 2,
          body: "Called and qualified next steps.",
        }],
      }),
    );
    const comment = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      commentPath,
      "--json",
    ]);
    assertEquals(comment.code, 0, comment.stderr);

    const view = await runOptctl([
      "--server",
      server.url,
      "view",
      "default.lead",
      leadId,
      "--actor",
      "agent_1:sales_rep",
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
        actor_context: {
          id: "agent_1",
          roles: ["sales_rep"],
          sales_team_ids: ["direct"],
        },
        operations: [{
          op: "archive",
          resource: "default.lead",
          id: leadId,
          expected_version: 3,
        }],
      }),
    );
    const archive = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      archivePath,
      "--json",
    ]);
    assertEquals(archive.code, 0, archive.stderr);

    const history = await runOptctl([
      "--server",
      server.url,
      "history",
      "default.lead",
      leadId,
      "--actor",
      "agent_1:sales_rep",
      "--json",
    ]);
    assertEquals(history.code, 0, history.stderr);
    const historyJson = JSON.parse(history.stdout);
    assertEquals(historyJson.data.versions.length, 4);
    assertEquals(
      historyJson.data.versions.map((v: { operation: string }) => v.operation),
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
      server.sql,
      "select version,current_object_version_id from res_lead where id=$1",
      [leadId],
    );
    const latest = await query<
      { id: string; version: number; snapshot_json: { version: number } }
    >(
      server.sql,
      "select id,version,snapshot_json from object_versions where resource='default.lead' and object_id=$1 order by version desc limit 1",
      [leadId],
    );
    assertEquals(current.rows[0].version, 4);
    assertEquals(current.rows[0].current_object_version_id, latest.rows[0].id);
    const latestSnapshot = typeof latest.rows[0].snapshot_json === "string"
      ? JSON.parse(latest.rows[0].snapshot_json)
      : latest.rows[0].snapshot_json;
    assertEquals(latestSnapshot.version, 4);

    const reapply = await runOptctl([
      "--server",
      server.url,
      "pack",
      "apply",
      "prototypes/crm-default-pack",
      "--json",
    ]);
    assertEquals(reapply.code, 0, reapply.stderr);
    const countsAfterReapply = await query<
      { lead_statuses: string; stages: string; teams: string }
    >(
      server.sql,
      `select
        (select count(*)::text from res_lead_status) as lead_statuses,
        (select count(*)::text from res_opportunity_stage) as stages,
        (select count(*)::text from res_sales_team) as teams`,
    );
    assertEquals(countsAfterReapply.rows[0], countsBeforeReapply);
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  } finally {
    if (server) await server.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});
