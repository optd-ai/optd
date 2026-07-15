import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("CRM query filters projections pagination and cursor mismatch through optctl", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP CRM query scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "operant-query-scenario-" });
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
      "tests/fixtures/packs/crm-default-pack",
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(apply.code, 0, apply.stderr);

    const tempDir = await Deno.makeTempDir({ prefix: "operant-query-json-" });
    const ids = ["lead_query_a", "lead_query_b", "lead_query_c"].map((prefix) =>
      `${prefix}_${crypto.randomUUID()}`
    );
    const createPath = `${tempDir}/create.json`;
    await Deno.writeTextFile(
      createPath,
      JSON.stringify({
        actor_context: { id: "agent_query", roles: ["sales_manager"] },
        operations: ids.map((id, index) => ({
          op: "create",
          resource: "default.lead",
          fields: {
            id,
            name: `Query Lead ${index}`,
            email: `query-${index}@example.com`,
            status: index === 2 ? "contacted" : "new",
            owner_id: index === 1 ? "owner_b" : "owner_a",
            score: 10 + index,
            source: "query-scenario",
          },
        })),
      }),
    );
    const create = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      createPath,
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);

    const archivePath = `${tempDir}/archive.json`;
    await Deno.writeTextFile(
      archivePath,
      JSON.stringify({
        actor_context: { id: "agent_query", roles: ["sales_manager"] },
        operations: [{
          op: "archive",
          resource: "default.lead",
          id: ids[2],
          expected_version: 1,
        }],
      }),
    );
    const archive = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      archivePath,
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(archive.code, 0, archive.stderr);

    const page1 = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario" && owner_id == "owner_a"',
      "--fields",
      "id,email,owner_id,status",
      "--sort",
      "email:asc",
      "--limit",
      "1",
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(page1.code, 0, page1.stderr);
    const page1Json = JSON.parse(page1.stdout);
    assertEquals(page1Json.data.items.length, 1);
    assertEquals(page1Json.data.items[0].email, "query-0@example.com");
    assertEquals(page1Json.data.page.has_more, false);
    assertEquals(Object.keys(page1Json.data.items[0]).sort(), [
      "email",
      "id",
      "owner_id",
      "status",
    ]);

    const pageAll1 = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--fields",
      "id,email,status",
      "--sort",
      "email:asc",
      "--limit",
      "1",
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(pageAll1.code, 0, pageAll1.stderr);
    const all1 = JSON.parse(pageAll1.stdout);
    assertEquals(all1.data.items[0].email, "query-0@example.com");
    assertEquals(all1.data.page.has_more, true);
    assert(all1.data.page.next_cursor);

    const pageAll2 = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--fields",
      "id,email,status",
      "--sort",
      "email:asc",
      "--limit",
      "1",
      "--cursor",
      all1.data.page.next_cursor,
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(pageAll2.code, 0, pageAll2.stderr);
    const all2 = JSON.parse(pageAll2.stdout);
    assertEquals(all2.data.items[0].email, "query-1@example.com");

    const mismatch = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario" && status == "new"',
      "--fields",
      "id,email,status",
      "--sort",
      "email:asc",
      "--limit",
      "1",
      "--cursor",
      all1.data.page.next_cursor,
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(mismatch.code, 1);
    assertStringIncludes(mismatch.stderr, "cursor_mismatch");

    const archivedDenied = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--include-archived",
      "--actor",
      "manager:sales_manager",
      "--json",
    ]);
    assertEquals(archivedDenied.code, 1);
    assertStringIncludes(archivedDenied.stderr, "include_archived_denied");

    const repQuery = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--fields",
      "id,owner_id,email",
      "--sort",
      "email:asc",
      "--limit",
      "1",
      "--actor",
      "owner_a:sales_rep",
      "--json",
    ]);
    assertEquals(repQuery.code, 0, repQuery.stderr);
    const repJson = JSON.parse(repQuery.stdout);
    assertEquals(repJson.data.items.length, 1);
    assertEquals(repJson.data.items[0].owner_id, "owner_a");
    assertEquals(repJson.data.page.has_more, false);

    const viewerQuery = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--actor",
      "viewer_1:viewer",
      "--json",
    ]);
    assertEquals(viewerQuery.code, 0, viewerQuery.stderr);
    assertEquals(JSON.parse(viewerQuery.stdout).data.items.length, 0);

    const superAdminQuery = await runOptctl([
      "--server",
      server.url,
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--include-archived",
      "--fields",
      "id,email,status",
      "--sort",
      "email:asc",
      "--actor",
      "super_admin",
      "--json",
    ]);
    assertEquals(superAdminQuery.code, 0, superAdminQuery.stderr);
    assertEquals(JSON.parse(superAdminQuery.stdout).data.items.length, 3);

    const deniedPath = `${tempDir}/denied.json`;
    await Deno.writeTextFile(
      deniedPath,
      JSON.stringify({
        actor_context: { id: "owner_a", roles: ["sales_rep"] },
        operations: [{
          op: "update",
          resource: "default.lead",
          id: ids[1],
          expected_version: 1,
          fields: { score: 99 },
        }],
      }),
    );
    const deniedUpdate = await runOptctl([
      "--server",
      server.url,
      "changeset",
      "commit",
      deniedPath,
      "--json",
    ]);
    assertEquals(deniedUpdate.code, 1);
    assertStringIncludes(deniedUpdate.stderr, "policy_denied");

    const audit = await query<{ denied: string; bypassed: string }>(
      server.sql,
      `select
        (select count(*)::text from audit_events where event_type='policy.denied' and actor_id='owner_a') as denied,
        (select count(*)::text from audit_events where event_type='policy.bypassed') as bypassed`,
    );
    assert(Number(audit.rows[0].denied) >= 1);
    assert(Number(audit.rows[0].bypassed) >= 1);
  } finally {
    await server?.shutdown();
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => undefined);
  }
});
