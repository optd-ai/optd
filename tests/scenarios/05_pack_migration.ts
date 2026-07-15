import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("live pack migration stages destructive cleanup and confirms by digest", async () => {
  let harness;
  try {
    harness = await startAuthenticatedHarness();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SKIP:")) {
      console.log(error.message);
      return;
    }
    throw error;
  }
  try {
    const applyV1 = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      "tests/fixtures/migration-crm-v1",
    ]);
    assertEquals(applyV1.code, 0, applyV1.stderr);

    const create = await harness.runOptctl([
      "--json",
      "changeset",
      "commit",
      await writeJson({
        operations: [{
          op: "create",
          resource: "default.lead",
          fields: {
            id: "lead-1",
            email: "a@example.com",
            company_name: "Acme",
            priority: 7,
          },
        }],
      }),
    ]);
    assertEquals(create.code, 0, create.stderr);

    const preview = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      "tests/fixtures/migration-crm-v2",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const previewBody = JSON.parse(preview.stdout);
    const migration = previewBody.data.plan.migration;
    assertEquals(migration.summary.safe, 2);
    assertEquals(migration.summary.risky, 1);
    assertEquals(migration.summary.destructive, 1);
    assertEquals(migration.summary.blocked, 1);
    assertMatch(migration.sql_preview.join("\n"), /add column/i);
    const migrationId = migration.id;

    const inspect = await harness.runOptctl([
      "--json",
      "migration",
      "inspect",
      migrationId,
    ]);
    assertEquals(inspect.code, 0, inspect.stderr);
    assertEquals(JSON.parse(inspect.stdout).data.blockers.length, 1);

    const applySafe = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      migrationId,
    ]);
    assertEquals(applySafe.code, 0, applySafe.stderr);

    const staged = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      migrationId,
      "--stage",
    ]);
    assertEquals(staged.code, 0, staged.stderr);
    const token = JSON.parse(staged.stdout).data.confirmation_token;
    assert(typeof token === "string" && token.startsWith("confirm:sha256:"));

    const cleanup = await harness.runOptctl([
      "--json",
      "changeset",
      "commit",
      await writeJson({
        source: "migration-cleanup",
        operations: [{
          op: "update",
          resource: "default.lead",
          id: "lead-1",
          fields: { company_name: null },
        }],
      }),
    ]);
    assertEquals(cleanup.code, 0, cleanup.stderr);

    const confirm = await harness.runOptctl([
      "--json",
      "migration",
      "confirm",
      migrationId,
      "--token",
      token,
    ]);
    assertEquals(confirm.code, 0, confirm.stderr);
    assertEquals(JSON.parse(confirm.stdout).data.status, "applied");

    const columns = await query<{ column_name: string; data_type: string }>(
      harness.server.sql,
      "select column_name, data_type from information_schema.columns where table_name='res_lead' order by column_name",
    );
    const columnNames = columns.rows.map((r) => r.column_name);
    assert(columnNames.includes("score"));
    assert(!columnNames.includes("company_name"));
    assertEquals(
      columns.rows.find((r) => r.column_name === "priority")?.data_type,
      "numeric",
    );
    const row = await query<
      { email: string; priority: string | number | null }
    >(
      harness.server.sql,
      "select email, priority from res_lead where id='lead-1'",
    );
    assertEquals(row.rows[0]?.email, "a@example.com");
    const audit = await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text as count from audit_events where event_type like 'pack_migration.%'",
    );
    assert(Number(audit.rows[0]?.count ?? 0) >= 3);
  } finally {
    await harness.close();
  }
});

async function writeJson(value: unknown): Promise<string> {
  const path = await Deno.makeTempFile({
    prefix: "operant-migration-",
    suffix: ".json",
  });
  await Deno.writeTextFile(path, JSON.stringify(value));
  return path;
}
