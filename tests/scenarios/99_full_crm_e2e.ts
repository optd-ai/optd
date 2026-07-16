import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

function parseJson<T = Record<string, unknown>>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

Deno.test("full CRM MVP e2e through compiled optctl, HTTP, app, and Postgres", {
  ignore: true,
}, async () => {
  const tempDir = await Deno.makeTempDir({ prefix: "operant-full-e2e-json-" });
  const previousSecretKey = Deno.env.get("OPERANT_SECRET_MASTER_KEY");
  Deno.env.set("OPERANT_SECRET_MASTER_KEY", "full-e2e-secret-key");
  const harness = await startAuthenticatedHarness();
  try {
    const optctl = (args: string[]) => harness.runOptctl(args);

    const ready = await fetch(`${harness.baseUrl}/ready`);
    assertEquals(ready.status, 200);
    const readyJson = await ready.json();
    assertEquals(readyJson.data.status, "ready");
    assertEquals(readyJson.data.migrations.ok, true);

    const home = await optctl(["home"]);
    assertEquals(home.code, 0, home.stderr);
    assertStringIncludes(home.stdout, "status");
    assertStringIncludes(home.stdout, "ready");

    const preview = await optctl([
      "pack",
      "preview",
      "tests/fixtures/packs/crm-default-pack",
      "--json",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const previewJson = parseJson<
      {
        ok: boolean;
        data: {
          mutating: boolean;
          plan: { summary: { resources: string[]; actions: string[] } };
        };
      }
    >(preview.stdout);
    assertEquals(previewJson.ok, true);
    assertEquals(previewJson.data.mutating, false);
    assert(previewJson.data.plan.summary.resources.includes("default.lead"));
    assert(
      previewJson.data.plan.summary.actions.includes("default.convert_lead"),
    );

    const apply = await optctl([
      "pack",
      "apply",
      "tests/fixtures/packs/crm-default-pack",
      "--json",
    ]);
    assertEquals(apply.code, 0, apply.stderr);
    const applyJson = parseJson<
      {
        data: {
          seeds: { planned: number; committed: number; skipped: number };
          summary: { hooks: { name: string }[] };
        };
      }
    >(apply.stdout);
    assertEquals(applyJson.data.seeds.planned, 20);
    assertEquals(
      applyJson.data.seeds.committed + applyJson.data.seeds.skipped,
      20,
    );
    assert(
      applyJson.data.summary.hooks.some((hook) =>
        hook.name === "default.notify_crm_change"
      ),
    );

    const resourceMeta = await optctl([
      "metadata",
      "resource",
      "default.lead",
      "--json",
    ]);
    assertEquals(resourceMeta.code, 0, resourceMeta.stderr);
    assertStringIncludes(resourceMeta.stdout, "default.lead");
    assertStringIncludes(resourceMeta.stdout, "email");
    const actionMeta = await optctl([
      "metadata",
      "action",
      "default.convert_lead",
      "--json",
    ]);
    assertEquals(actionMeta.code, 0, actionMeta.stderr);
    assertStringIncludes(actionMeta.stdout, "Convert a qualified lead");

    const leadId = `lead_full_${crypto.randomUUID()}`;
    const createPath = `${tempDir}/create-lead.json`;
    const createPayload = {
      idempotency_key: "full-e2e-create-lead",
      operations: [{
        op: "create",
        resource: "default.lead",
        fields: {
          id: leadId,
          name: "  Full E2E Lead  ",
          email: " FULL.E2E@EXAMPLE.COM ",
          company_name: "Full E2E Co",
          status: "new",
          source: "scenario",
          owner_id: "manager",
          sales_team_id: "direct",
        },
      }],
    };
    await Deno.writeTextFile(createPath, JSON.stringify(createPayload));
    const createPreview = await optctl([
      "changeset",
      "preview",
      createPath,
      "--json",
    ]);
    assertEquals(createPreview.code, 0, createPreview.stderr);
    assertEquals(
      parseJson<{ data: { committable: boolean } }>(createPreview.stdout).data
        .committable,
      true,
    );
    const createCommit = await optctl([
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(createCommit.code, 0, createCommit.stderr);
    const createCommitJson = parseJson<
      { data: { committed: boolean; object_versions: { version: number }[] } }
    >(createCommit.stdout);
    assertEquals(createCommitJson.data.committed, true);
    assertEquals(createCommitJson.data.object_versions[0].version, 1);
    const createReplay = await optctl([
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(createReplay.code, 1);
    assertStringIncludes(createReplay.stderr, "idempotency key reused");

    const updatePath = `${tempDir}/update-lead.json`;
    await Deno.writeTextFile(
      updatePath,
      JSON.stringify({
        operations: [{
          op: "update",
          resource: "default.lead",
          id: leadId,
          expected_version: 1,
          fields: { status: "qualified", score: 80 },
        }],
      }),
    );
    assertEquals(
      (await optctl(["changeset", "commit", updatePath, "--json"])).code,
      0,
    );

    const commentPath = `${tempDir}/comment-lead.json`;
    await Deno.writeTextFile(
      commentPath,
      JSON.stringify({
        operations: [{
          op: "comment",
          resource: "default.lead",
          id: leadId,
          expected_version: 2,
          body: "Qualified in final full-system scenario.",
        }],
      }),
    );
    assertEquals(
      (await optctl(["changeset", "commit", commentPath, "--json"])).code,
      0,
    );

    const queryPage = await optctl([
      "query",
      "default.lead",
      "--where",
      'status == "qualified"',
      "--limit",
      "1",
      "--json",
    ]);
    assertEquals(queryPage.code, 0, queryPage.stderr);
    const queryJson = parseJson<
      { data: { items: { id: string }[]; page: { limit: number } } }
    >(queryPage.stdout);
    assertEquals(queryJson.data.page.limit, 1);
    assert(queryJson.data.items.some((row) => row.id === leadId));

    const denied = await optctl([
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--json",
    ]);
    assertEquals(denied.code, 0, denied.stderr);
    assertEquals(
      parseJson<{ data: { changeset: { committable: boolean } } }>(
        denied.stdout,
      )
        .data.changeset.committable,
      true,
    );

    const convert = await optctl([
      "action",
      "commit",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--json",
    ]);
    assertEquals(convert.code, 0, convert.stderr);
    const convertJson = parseJson<
      {
        data: {
          changeset: {
            object_versions: {
              resource: string;
              object_id: string;
              snapshot: Record<string, unknown>;
            }[];
          };
        };
      }
    >(convert.stdout);
    const opportunity = convertJson.data.changeset.object_versions.find((v) =>
      v.resource === "default.opportunity"
    );
    const contact = convertJson.data.changeset.object_versions.find((v) =>
      v.resource === "default.contact"
    );
    const company = convertJson.data.changeset.object_versions.find((v) =>
      v.resource === "default.company"
    );
    assert(opportunity);
    assert(contact);
    assert(company);

    const linkedRows = await query<
      {
        contact_company: string;
        opportunity_company: string;
        opportunity_contact: string;
      }
    >(
      harness.server.sql,
      `select
        (select count(*)::text from rel_contact_company where from_object_id=$1 and to_object_id=$2) as contact_company,
        (select count(*)::text from rel_opportunity_company where from_object_id=$3 and to_object_id=$2) as opportunity_company,
        (select count(*)::text from rel_opportunity_contact where from_object_id=$3 and to_object_id=$1) as opportunity_contact`,
      [contact.object_id, company.object_id, opportunity.object_id],
    );
    assertEquals(linkedRows.rows[0], {
      contact_company: "1",
      opportunity_company: "1",
      opportunity_contact: "1",
    });

    const logActivity = await optctl([
      "action",
      "commit",
      "default.log_activity",
      "--input",
      JSON.stringify({
        resource: "opportunity",
        object_id: opportunity.object_id,
        type: "call",
        subject: "Final E2E validation call",
        status: "done",
        note: "Activity and note from full E2E.",
      }),
      "--json",
    ]);
    assertEquals(logActivity.code, 0, logActivity.stderr);

    const won = await optctl([
      "action",
      "commit",
      "default.mark_won",
      "--input",
      JSON.stringify({ opportunity_id: opportunity.object_id }),
      "--json",
    ]);
    assertEquals(won.code, 0, won.stderr);

    const lostOppId = `opp_lost_${crypto.randomUUID()}`;
    const lostOppPath = `${tempDir}/create-lost-opportunity.json`;
    await Deno.writeTextFile(
      lostOppPath,
      JSON.stringify({
        operations: [{
          op: "create",
          resource: "default.opportunity",
          fields: {
            id: lostOppId,
            name: "Full E2E lost opportunity",
            stage: "qualified",
            expected_revenue: 1000,
            probability: 20,
            owner_id: "manager",
            sales_team_id: "direct",
          },
        }],
      }),
    );
    assertEquals(
      (await optctl(["changeset", "commit", lostOppPath, "--json"])).code,
      0,
    );
    const lost = await optctl([
      "action",
      "commit",
      "default.mark_lost",
      "--input",
      JSON.stringify({
        opportunity_id: lostOppId,
        lost_reason_id: "no_budget",
        note: "Budget unavailable.",
      }),
      "--json",
    ]);
    assertEquals(lost.code, 0, lost.stderr);

    const crmFacts = await query<
      {
        won_stage: string;
        lost_stage: string;
        activities: string;
        notes: string;
        outbox_pending: string;
      }
    >(
      harness.server.sql,
      `select
        (select stage from res_opportunity where id=$1) as won_stage,
        (select stage from res_opportunity where id=$2) as lost_stage,
        (select count(*)::text from res_activity where opportunity_id=$1) as activities,
        (select count(*)::text from res_note where opportunity_id=$1) as notes,
        (select count(*)::text from outbox where status='pending') as outbox_pending`,
      [opportunity.object_id, lostOppId],
    );
    assertEquals(crmFacts.rows[0].won_stage, "won");
    assertEquals(crmFacts.rows[0].lost_stage, "lost");
    assert(Number(crmFacts.rows[0].activities) >= 1);
    assert(Number(crmFacts.rows[0].notes) >= 1);
    assert(Number(crmFacts.rows[0].outbox_pending) >= 1);

    const drain = await optctl(["outbox", "drain", "--json"]);
    assertEquals(drain.code, 0, drain.stderr);
    const drainJson = parseJson<
      { data: { claimed: number; succeeded: number } }
    >(drain.stdout);
    assert(drainJson.data.claimed >= 1);
    assert(drainJson.data.succeeded >= 1);

    const history = await optctl(["history", "default.lead", leadId, "--json"]);
    assertEquals(history.code, 0, history.stderr);
    const historyJson = parseJson<
      {
        data: {
          versions: { operation: string }[];
          audit_events: unknown[];
          events: unknown[];
          comments: unknown[];
        };
      }
    >(history.stdout);
    assert(historyJson.data.versions.some((v) => v.operation === "transition"));
    assert(historyJson.data.comments.length >= 1);
    assert(historyJson.data.audit_events.length >= 1);
    assert(historyJson.data.events.length >= 1);

    await harness.restart();
    const persisted = await optctl([
      "view",
      "default.opportunity",
      opportunity.object_id,
      "--json",
    ]);
    assertEquals(persisted.code, 0, persisted.stderr);
    assertEquals(
      parseJson<{ data: { object: { stage: string } } }>(persisted.stdout).data
        .object.stage,
      "won",
    );

    const migrationPreview = await optctl([
      "pack",
      "preview",
      "tests/fixtures/migration-crm-v2",
      "--json",
    ]);
    assertEquals(migrationPreview.code, 0, migrationPreview.stderr);
    assertStringIncludes(migrationPreview.stdout, "default.lead");

    const projectPreview = await optctl([
      "pack",
      "preview",
      "tests/fixtures/packs/project-management-pack",
      "--json",
    ]);
    assertEquals(projectPreview.code, 0, projectPreview.stderr);
    assertStringIncludes(projectPreview.stdout, "default.task");
    assertStringIncludes(projectPreview.stdout, "default.start_task");
  } finally {
    await harness.close();
    if (previousSecretKey === undefined) {
      Deno.env.delete("OPERANT_SECRET_MASTER_KEY");
    } else Deno.env.set("OPERANT_SECRET_MASTER_KEY", previousSecretKey);
    await Deno.remove(tempDir, { recursive: true }).catch(() => {});
  }
});
