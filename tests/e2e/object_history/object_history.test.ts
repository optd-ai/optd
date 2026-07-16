import { assertEquals } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { seedObjectHistoryFixture } from "../../support/object_history_fixtures.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

Deno.test("compiled optctl reads Project-scoped object and relationship history", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "history-admin",
      password: "History-Admin-Password-42!",
      displayName: "History Admin",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const apply = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      "prototypes/crm-default-pack",
      "--safe",
    ]);
    assertEquals(apply.code, 0, apply.stderr);
    const sales = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "history-sales",
      "--display-name",
      "History Sales",
    ]);
    const other = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "history-other",
      "--display-name",
      "History Other",
    ]);
    assertEquals(sales.code, 0, sales.stderr);
    assertEquals(other.code, 0, other.stderr);
    const projectOne = JSON.parse(sales.stdout).data.id;
    const projectTwo = JSON.parse(other.stdout).data.id;
    const auth = (await query<{ id: string }>(
      harness.server.sql,
      "select id from auth_contexts order by created_at desc limit 1",
    )).rows[0].id;
    const ids = await seedObjectHistoryFixture({
      sql: harness.server.sql,
      publisher: "operant",
      pack: "crm",
      resource: "lead",
      relationship: "contact_company",
      projectIds: [projectOne, projectTwo],
      authContextId: auth,
      resourceData: { name: "Fixture Lead", status: "new" },
      relationshipFields: { role: "buyer", primary: true },
    });
    const relationshipTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='relationship' and definition_name='contact_company'",
    )).rows[0].table_name;
    await query(
      harness.server.sql,
      `insert into ${
        quoteIdentifier(relationshipTable)
      }(id,project_id,from_object_id,to_object_id,created_by,updated_by,${quoteIdentifier("role")},${quoteIdentifier("primary")}) values($1,$2,$3,$4,$5,$5,$6,$7)`,
      [
        uuidV7(),
        projectOne,
        ids.object,
        ids.otherObject,
        auth,
        "replacement",
        false,
      ],
    );
    const object = await harness.runOptctl([
      "--json",
      "--project",
      "history-sales",
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(object.code, 0, object.stderr);
    assertEquals(
      JSON.parse(object.stdout).data.object_version_id,
      ids.objectVersionTwo,
    );
    const history = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(history.code, 0, `${history.stderr}\n${history.stdout}`);
    const historyEnvelope = JSON.parse(history.stdout);
    assertEquals(
      historyEnvelope.data.items.map((entry: { kind: string }) => entry.kind),
      ["comment", "object_version", "object_version"],
    );
    const firstPage = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
    ]);
    assertEquals(firstPage.code, 0, firstPage.stderr);
    const cursor = JSON.parse(firstPage.stdout).meta.next_cursor as string;
    const secondPage = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
      "--cursor",
      cursor,
    ]);
    assertEquals(secondPage.code, 0, secondPage.stderr);
    const tampered = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
      "--cursor",
      `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
    ]);
    assertEquals(tampered.code, 1);
    assertEquals(JSON.parse(tampered.stderr).error.code, "invalid_cursor");
    const relationship = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "view",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ]);
    assertEquals(relationship.code, 0, relationship.stderr);
    assertEquals(JSON.parse(relationship.stdout).data.kind, "relationship");
    const relationshipHistory = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ]);
    assertEquals(relationshipHistory.code, 0, relationshipHistory.stderr);
    assertEquals(JSON.parse(relationshipHistory.stdout).data.items.length, 2);
    const toon = await harness.runOptctl([
      "--project",
      projectOne,
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(toon.code, 0, toon.stderr);
    assertEquals(toon.stdout.includes("object_version_id"), true);
    assertEquals(toon.stdout.includes("Fixture Lead"), true);
    const hookDefault = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "hook",
      "operant/crm:validate_lead",
    ]);
    assertEquals(hookDefault.code, 0, hookDefault.stderr);
    assertEquals("script_digest" in JSON.parse(hookDefault.stdout).data, false);
    const hookSecurity = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "hook",
      "operant/crm:validate_lead",
      "--include-security",
    ]);
    assertEquals(hookSecurity.code, 0, hookSecurity.stderr);
    assertEquals(
      typeof JSON.parse(hookSecurity.stdout).data.script_digest,
      "string",
    );
    const mismatch = await harness.runOptctl([
      "--json",
      "--project",
      projectTwo,
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(mismatch.code, 1);
    assertEquals(JSON.parse(mismatch.stderr).error.code, "not_found");
  } finally {
    await harness.close();
  }
});
