import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("pack preview/apply CRM scenario crosses optctl HTTP boundary and survives restart", { ignore: true }, async () => {
  const harness = await startAuthenticatedHarness();
  try {
    const invalidPackDir = await Deno.makeTempDir({
      prefix: "operant-invalid-pack-",
    });
    await Deno.mkdir(`${invalidPackDir}/resources`);
    await Deno.writeTextFile(
      `${invalidPackDir}/pack.yaml`,
      `kind: Pack
apiVersion: operant.dev/v1
metadata:
  namespace: default
  name: invalid
  version: 0.1.0
spec: {}
`,
    );
    await Deno.writeTextFile(
      `${invalidPackDir}/resources/bad.yaml`,
      `kind: Resource
apiVersion: operant.dev/v1
metadata:
  name: bad
spec:
  fields:
    mystery:
      type: unsupported
`,
    );
    const badPreview = await harness.runOptctl([
      "pack",
      "preview",
      invalidPackDir,
      "--json",
    ]);
    await Deno.remove(invalidPackDir, { recursive: true }).catch(() => {});
    assertEquals(badPreview.code, 1);
    assertStringIncludes(badPreview.stderr, "unsupported field type");
    const partialTable = await query<{ exists: boolean }>(
      harness.server.sql,
      "select to_regclass('public.res_bad') is not null as exists",
    );
    assertEquals(partialTable.rows[0]?.exists, false);
    const countAfterBadPreview = await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text as count from pack_revisions",
    );
    assertEquals(countAfterBadPreview.rows[0]?.count, "0");

    const preview = await harness.runOptctl([
      "pack",
      "preview",
      "tests/fixtures/packs/crm-default-pack",
      "--json",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const previewJson = JSON.parse(preview.stdout);
    assertEquals(previewJson.ok, true);
    assertEquals(previewJson.data.mutating, false);
    assert(previewJson.data.plan.summary.resources.includes("default.lead"));
    assert(
      previewJson.data.plan.summary.actions.includes("default.convert_lead"),
    );
    assert(
      previewJson.data.plan.generated_tables.some((
        table: { table_name: string },
      ) => table.table_name === "res_lead"),
    );
    const countAfterPreview = await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text as count from pack_revisions",
    );
    assertEquals(countAfterPreview.rows[0]?.count, "0");

    const apply = await harness.runOptctl([
      "pack",
      "apply",
      "tests/fixtures/packs/crm-default-pack",
      "--json",
    ]);
    assertEquals(apply.code, 0, apply.stderr);
    const applyJson = JSON.parse(apply.stdout);
    assertEquals(applyJson.ok, true);
    assert(
      applyJson.data.summary.hooks.some((hook: { name: string }) =>
        hook.name === "default.convert_lead"
      ),
    );

    const generatedTables = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      harness.server.sql,
      `select table_name, column_name, data_type, is_nullable
       from information_schema.columns
       where table_schema = 'public'
         and table_name in ('res_lead', 'res_opportunity', 'rel_contact_company')
       order by table_name, ordinal_position`,
    );
    const columns = generatedTables.rows.map((row) =>
      `${row.table_name}.${row.column_name}:${row.data_type}:${row.is_nullable}`
    );
    assert(columns.includes("res_lead.id:text:NO"));
    assert(columns.includes("res_lead.name:text:NO"));
    assert(columns.includes("res_lead.current_object_version_id:text:YES"));
    assert(columns.includes("res_opportunity.expected_revenue:numeric:YES"));
    assert(columns.includes("rel_contact_company.from_object_id:text:NO"));
    assert(columns.includes("rel_contact_company.to_object_id:text:NO"));
    assert(columns.includes("rel_contact_company.primary:boolean:YES"));

    const storedDdl = await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text as count from generated_sql_objects where table_name in ('res_lead', 'res_opportunity', 'rel_contact_company')",
    );
    assertEquals(storedDdl.rows[0]?.count, "3");

    const resource = await harness.runOptctl([
      "metadata",
      "resource",
      "default.lead",
      "--json",
    ]);
    assertEquals(resource.code, 0, resource.stderr);
    assertStringIncludes(resource.stdout, "default.lead");
    assertStringIncludes(resource.stdout, "email");

    const actionToon = await harness.runOptctl([
      "metadata",
      "action",
      "default.convert_lead",
    ]);
    assertEquals(actionToon.code, 0, actionToon.stderr);
    assertStringIncludes(actionToon.stdout, "default.convert_lead");
    assertStringIncludes(actionToon.stdout, "Convert a qualified lead");

    await harness.restart();
    const home = await harness.runOptctl(["home"]);
    assertEquals(home.code, 0, home.stderr);
    assertStringIncludes(home.stdout, "default.lead");
    assertStringIncludes(home.stdout, "default.convert_lead");
  } finally {
    await harness.close();
  }
});
