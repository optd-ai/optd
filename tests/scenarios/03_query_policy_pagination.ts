import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
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
      "prototypes/crm-default-pack",
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
        actor: "agent_query",
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
      "--json",
    ]);
    assertEquals(create.code, 0, create.stderr);

    const archivePath = `${tempDir}/archive.json`;
    await Deno.writeTextFile(
      archivePath,
      JSON.stringify({
        actor: "agent_query",
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
      "--json",
    ]);
    assertEquals(archivedDenied.code, 1);
    assertStringIncludes(archivedDenied.stderr, "include_archived_denied");
  } finally {
    await server?.shutdown();
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => undefined);
  }
});
