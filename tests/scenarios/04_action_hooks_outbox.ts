import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("CRM hooks normalize/validate leads and convert_lead action enqueues outbox", async () => {
  const harness = await startAuthenticatedHarness();
  try {
    const apply = await harness.runOptctl([
      "pack",
      "apply",
      "tests/fixtures/packs/crm-default-pack",
      "--json",
    ]);
    assertEquals(apply.code, 0, apply.stderr);

    const tempDir = await Deno.makeTempDir({ prefix: "operant-action-json-" });
    const leadId = `lead_action_${crypto.randomUUID()}`;
    const createPath = `${tempDir}/create.json`;
    await Deno.writeTextFile(
      createPath,
      JSON.stringify({
        operations: [{
          op: "create",
          resource: "default.lead",
          fields: {
            id: leadId,
            name: "  Action Lead  ",
            email: "  ACTION@EXAMPLE.COM  ",
            company_name: "Action Corp",
            owner_id: "manager",
            sales_team_id: "direct",
          },
        }],
      }),
    );
    const create = await harness.runOptctl([
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);
    const lead = await harness.runOptctl([
      "view",
      "default.lead",
      leadId,
      "--json",
    ]);
    assertEquals(lead.code, 0, lead.stderr);
    const leadJson = JSON.parse(lead.stdout);
    assertEquals(leadJson.data.object.name, "Action Lead");
    assertEquals(leadJson.data.object.email, "action@example.com");
    assertEquals(leadJson.data.object.status, "new");
    assertEquals(leadJson.data.object.score, 0);

    const invalidPath = `${tempDir}/invalid.json`;
    await Deno.writeTextFile(
      invalidPath,
      JSON.stringify({
        operations: [{
          op: "create",
          resource: "default.lead",
          fields: { id: `bad_${crypto.randomUUID()}`, name: "No Contact" },
        }],
      }),
    );
    const invalid = await harness.runOptctl([
      "changeset",
      "commit",
      invalidPath,
      "--json",
    ]);
    assertEquals(invalid.code, 1);
    assertStringIncludes(invalid.stderr, "contact_method_required");

    const denied = await harness.runOptctl([
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--json",
    ]);
    assertEquals(denied.code, 0, denied.stderr);
    assertEquals(JSON.parse(denied.stdout).data.changeset.committable, true);

    const preview = await harness.runOptctl([
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--json",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout);
    assertEquals(previewJson.data.changeset.committable, true);
    assert(
      previewJson.data.generated_operations.some((
        op: Record<string, unknown>,
      ) => op.resource === "default.company"),
    );
    assert(
      previewJson.data.generated_operations.some((
        op: Record<string, unknown>,
      ) => op.relationship === "default.opportunity_contact"),
    );

    const commit = await harness.runOptctl([
      "action",
      "commit",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--json",
    ]);
    assertEquals(commit.code, 0, commit.stderr);
    const commitJson = JSON.parse(commit.stdout);
    assertEquals(commitJson.data.changeset.committed, true);
    const resources = commitJson.data.changeset.object_versions.map((
      v: Record<string, unknown>,
    ) => v.resource).sort();
    assert(resources.includes("default.company"));
    assert(resources.includes("default.contact"));
    assert(resources.includes("default.opportunity"));
    assert(resources.includes("default.lead"));

    const history = await harness.runOptctl([
      "history",
      "default.lead",
      leadId,
      "--json",
    ]);
    assertEquals(history.code, 0, history.stderr);
    const historyJson = JSON.parse(history.stdout);
    assert(
      historyJson.data.versions.some((v: Record<string, unknown>) =>
        v.operation === "transition"
      ),
    );

    const statusBefore = await harness.runOptctl([
      "outbox",
      "status",
      "--json",
    ]);
    assertEquals(statusBefore.code, 0, statusBefore.stderr);
    const statusBeforeJson = JSON.parse(statusBefore.stdout);
    assert(Number(statusBeforeJson.data.totals.pending ?? 0) >= 1);

    const drain = await harness.runOptctl([
      "outbox",
      "drain",
      "--json",
    ]);
    assertEquals(drain.code, 0, drain.stderr);
    const drainJson = JSON.parse(drain.stdout);
    assert(drainJson.data.claimed >= 1);
    assert(drainJson.data.succeeded >= 1);

    const outbox = await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text as count from outbox where phase='event.after_commit' and hook='default.notify_crm_change' and status='succeeded'",
    );
    assert(Number(outbox.rows[0]?.count ?? 0) >= 1);
    const executions = await query<{ phase: string; status: string }>(
      harness.server.sql,
      "select phase,status from hook_executions where hook in ('default.normalize_lead','default.validate_lead','default.convert_lead','default.notify_crm_change')",
    );
    assert(
      executions.rows.some((row) =>
        row.phase === "changeset.before_preview" && row.status === "succeeded"
      ),
    );
    assert(
      executions.rows.some((row) =>
        row.phase === "changeset.validate" && row.status === "succeeded"
      ),
    );
    assert(
      executions.rows.some((row) =>
        row.phase === "action.commit" && row.status === "succeeded"
      ),
    );
    assert(
      executions.rows.some((row) =>
        row.phase === "event.after_commit" && row.status === "succeeded"
      ),
    );
  } finally {
    await harness.close();
  }
});
