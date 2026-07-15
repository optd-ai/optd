import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("CRM query filters projections pagination and cursor mismatch through optctl", async () => {
  const harness = await startAuthenticatedHarness();
  try {
    const apply = await harness.runOptctl([
      "pack",
      "apply",
      "tests/fixtures/packs/crm-default-pack",
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
    const create = await harness.runOptctl([
      "changeset",
      "commit",
      createPath,
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);

    const archivePath = `${tempDir}/archive.json`;
    await Deno.writeTextFile(
      archivePath,
      JSON.stringify({
        operations: [{
          op: "archive",
          resource: "default.lead",
          id: ids[2],
          expected_version: 1,
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

    const page1 = await harness.runOptctl([
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

    const pageAll1 = await harness.runOptctl([
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
      "--json",
    ]);
    assertEquals(pageAll1.code, 0, pageAll1.stderr);
    const all1 = JSON.parse(pageAll1.stdout);
    assertEquals(all1.data.items[0].email, "query-0@example.com");
    assertEquals(all1.data.page.has_more, true);
    assert(all1.data.page.next_cursor);

    const pageAll2 = await harness.runOptctl([
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
      "--json",
    ]);
    assertEquals(pageAll2.code, 0, pageAll2.stderr);
    const all2 = JSON.parse(pageAll2.stdout);
    assertEquals(all2.data.items[0].email, "query-1@example.com");

    const mismatch = await harness.runOptctl([
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
      "--json",
    ]);
    assertEquals(mismatch.code, 1);
    assertStringIncludes(mismatch.stderr, "cursor_mismatch");

    const archivedDenied = await harness.runOptctl([
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--include-archived",
      "--json",
    ]);
    assertEquals(archivedDenied.code, 0, archivedDenied.stderr);
    assertEquals(JSON.parse(archivedDenied.stdout).data.items.length, 3);

    const repQuery = await harness.runOptctl([
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
      "--json",
    ]);
    assertEquals(repQuery.code, 0, repQuery.stderr);
    const repJson = JSON.parse(repQuery.stdout);
    assertEquals(repJson.data.items.length, 1);
    assertEquals(repJson.data.items[0].owner_id, "owner_a");
    assertEquals(repJson.data.page.has_more, true);

    const viewerQuery = await harness.runOptctl([
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--json",
    ]);
    assertEquals(viewerQuery.code, 0, viewerQuery.stderr);
    assertEquals(JSON.parse(viewerQuery.stdout).data.items.length, 2);

    const superAdminQuery = await harness.runOptctl([
      "query",
      "default.lead",
      "--where",
      'source == "query-scenario"',
      "--include-archived",
      "--fields",
      "id,email,status",
      "--sort",
      "email:asc",
      "--json",
    ]);
    assertEquals(superAdminQuery.code, 0, superAdminQuery.stderr);
    assertEquals(JSON.parse(superAdminQuery.stdout).data.items.length, 3);

    const deniedPath = `${tempDir}/denied.json`;
    await Deno.writeTextFile(
      deniedPath,
      JSON.stringify({
        operations: [{
          op: "update",
          resource: "default.lead",
          id: ids[1],
          expected_version: 1,
          fields: { score: 99 },
        }],
      }),
    );
    const deniedUpdate = await harness.runOptctl([
      "changeset",
      "commit",
      deniedPath,
      "--json",
    ]);
    assertEquals(deniedUpdate.code, 0, deniedUpdate.stderr);

    const audit = await query<{ denied: string; bypassed: string }>(
      harness.server.sql,
      `select
        (select count(*)::text from audit_events where event_type='policy.denied' and actor_id='owner_a') as denied,
        (select count(*)::text from audit_events where event_type='policy.bypassed') as bypassed`,
    );
    assertEquals(Number(audit.rows[0].denied), 0);
    assert(Number(audit.rows[0].bypassed) >= 1);
  } finally {
    await harness.close();
  }
});
