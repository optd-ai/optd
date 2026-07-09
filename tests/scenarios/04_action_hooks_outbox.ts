import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("CRM hooks normalize/validate leads and convert_lead action enqueues outbox", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP CRM action hooks scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "operant-action-hooks-" });
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

    const tempDir = await Deno.makeTempDir({ prefix: "operant-action-json-" });
    const leadId = `lead_action_${crypto.randomUUID()}`;
    const createPath = `${tempDir}/create.json`;
    await Deno.writeTextFile(
      createPath,
      JSON.stringify({
        actor_context: { id: "manager", roles: ["sales_manager"] },
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
    const create = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);
    const lead = await runOptctl([
      "--server",
      server.url,
      "view",
      "default.lead",
      leadId,
      "--actor",
      "manager:sales_manager",
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
        actor_context: { id: "manager", roles: ["sales_manager"] },
        operations: [{
          op: "create",
          resource: "default.lead",
          fields: { id: `bad_${crypto.randomUUID()}`, name: "No Contact" },
        }],
      }),
    );
    const invalid = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      invalidPath,
      "--json",
    ]);
    assertEquals(invalid.code, 1);
    assertStringIncludes(invalid.stderr, "contact_method_required");

    const denied = await runOptctl([
      "--server",
      server.url,
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--actor",
      "viewer:viewer",
      "--json",
    ]);
    assertEquals(denied.code, 1);
    assertStringIncludes(denied.stderr, "policy_denied");

    const preview = await runOptctl([
      "--server",
      server.url,
      "action",
      "preview",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--actor",
      "manager:sales_manager",
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

    const commit = await runOptctl([
      "--server",
      server.url,
      "action",
      "commit",
      "default.convert_lead",
      "--input",
      JSON.stringify({ lead_id: leadId }),
      "--actor",
      "manager:sales_manager",
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

    const history = await runOptctl([
      "--server",
      server.url,
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

    const outbox = await query<{ count: string }>(
      server.sql,
      "select count(*)::text as count from outbox where phase='event.after_commit' and hook='default.notify_crm_change'",
    );
    assert(Number(outbox.rows[0]?.count ?? 0) >= 1);
    const executions = await query<{ phase: string; status: string }>(
      server.sql,
      "select phase,status from hook_executions where hook in ('default.normalize_lead','default.validate_lead','default.convert_lead')",
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
  } finally {
    await server?.shutdown();
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});
