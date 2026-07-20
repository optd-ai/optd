import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";
import { join, relative } from "jsr:@std/path";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { seedObjectHistoryFixture } from "../../support/object_history_fixtures.ts";
import { parseYamlJsonObject } from "../../../src/adapters/outbound/yaml/pack_loader.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

type Envelope = {
  ok: boolean;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
  error?: { code?: string; details?: unknown };
};

Deno.test("fresh compiled optctl queries typed Project resources and relationships", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "query-admin",
      password: "Query-Admin-Password-42!",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const pack = join(harness.rootDir, "query-pack");
    await copyDirectory("prototypes/crm-default-pack", pack);
    const manifestPath = join(pack, "pack.yaml");
    const manifest = parseYamlJsonObject(
      await Deno.readTextFile(manifestPath),
      manifestPath,
    ) as Record<string, unknown>;
    (manifest.metadata as Record<string, unknown>).version = "9.0.0";
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
    const leadPath = join(pack, "resources", "lead.yaml");
    const lead = parseYamlJsonObject(
      await Deno.readTextFile(leadPath),
      leadPath,
    ) as {
      spec: {
        fields: Record<string, unknown>;
        axi: { list: { fields: string[] } };
      };
    };
    Object.assign(lead.spec.fields, {
      enabled: { type: "boolean" },
      due_date: { type: "date" },
      amount: { type: "decimal", precision: 12, scale: 2 },
    });
    lead.spec.axi.list.fields = ["id", "name", "score", "amount"];
    await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));
    const applied = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      pack,
      "--safe",
    ]);
    assertEquals(applied.code, 0, applied.stderr);
    const expressionHelp = await harness.runOptctl([
      "--json",
      "expression",
      "help",
      "partial-index",
    ]);
    assertEquals(expressionHelp.code, 0, expressionHelp.stderr);
    assertStringIncludes(expressionHelp.stdout, "partial-index");
    const expressionValid = await harness.runOptctl([
      "--json",
      "expression",
      "validate",
      "operant/crm:lead",
      "--context",
      "partial-index",
      'status == "new" && active()',
    ]);
    assertEquals(expressionValid.code, 0, expressionValid.stderr);
    const expressionInvalid = await harness.runOptctl([
      "--json",
      "expression",
      "validate",
      "operant/crm:lead",
      "--context",
      "query",
      "status ==",
    ]);
    assert(expressionInvalid.code !== 0);
    assertStringIncludes(expressionInvalid.stderr, "expression_syntax");
    assertStringIncludes(expressionInvalid.stderr, "line");

    const created = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "query-sales",
      "--display-name",
      "Query Sales",
    ]);
    assertEquals(created.code, 0, created.stderr);
    const project = JSON.parse(created.stdout).data.id as string;
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
      projectIds: [project, project],
      authContextId: auth,
      resourceData: {
        name: "Typed Lead",
        status: "new",
        score: 42,
        enabled: true,
        due_date: "2026-08-01",
        amount: "10.50",
        next_activity_at: "2026-08-01T12:00:00Z",
      },
      relationshipFields: { role: "buyer", primary: true },
    });
    const table = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    await query(
      harness.server.sql,
      `update ${
        quoteIdentifier(table)
      } set score=42,enabled=true,due_date='2026-08-01',amount=10.50,next_activity_at='2026-08-01T12:00:00Z' where id=$1`,
      [ids.object],
    );

    for (
      const where of [
        'name == "Typed Lead"',
        "score >= 42",
        "enabled == true",
        'due_date == "2026-08-01"',
        'next_activity_at >= "2026-08-01T12:00:00Z"',
        "amount >= 10",
      ]
    ) {
      const result = await runJson(harness, [
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--where",
        where,
        "--fields",
        "name,score,amount",
        "--sort",
        "score:asc",
        "--include-total",
      ]);
      const items = result.data.items as Array<{
        data: Record<string, unknown>;
      }>;
      assert(items.length > 0, where);
      assertEquals(result.meta.total, items.length, where);
      assertEquals(items[0].data.amount, "10.5");
    }
    const relationship = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "relationship",
      "operant/crm:contact_company",
      "--fields",
      "role,primary",
      "--sort",
      "created_at:asc",
      "--include-archived",
    ]);
    const relationItem = (relationship.data.items as Array<
      {
        kind: string;
        fields: Record<string, unknown>;
        from: string;
        to: string;
      }
    >)[0];
    assertEquals(relationItem.kind, "relationship");
    assertEquals(relationItem.fields, { role: "buyer", primary: true });
    assert(relationItem.from && relationItem.to);

    const firstPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
    ]);
    assertEquals(firstPage.data.items instanceof Array, true);
    assertEquals((firstPage.data.items as unknown[]).length, 1);
    assertEquals(firstPage.meta.has_more, true);
    assertEquals(firstPage.meta.total, 3);
    const cursor = String(firstPage.meta.next_cursor);
    const firstId = (firstPage.data.items as Array<{ id: string }>)[0].id;
    const secondPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      cursor,
    ]);
    assertEquals(secondPage.meta.total, 3);
    assert((secondPage.data.items as Array<{ id: string }>)[0].id !== firstId);
    for (
      const [changedArgs, expected] of [
        [["--where", 'name == "Other"'], "invalid_cursor"],
        [["--fields", "name"], "invalid_cursor"],
        [["--limit", "2"], "invalid_cursor"],
      ] as const
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--sort",
        "score:asc",
        "--sort",
        "updated_at:desc",
        "--limit",
        "1",
        "--include-total",
        "--cursor",
        cursor,
        ...changedArgs,
      ]);
      assert(failed.code !== 0);
      assertStringIncludes(failed.stderr, expected);
    }
    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const forgedResult = await harness.runOptctl([
      "--json",
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      forged,
    ]);
    assert(forgedResult.code !== 0);
    assertStringIncludes(forgedResult.stderr, "invalid_cursor");

    const toon = await harness.runOptctl([
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
    ]);
    assertEquals(toon.code, 0, toon.stderr);
    assertStringIncludes(toon.stdout, "Typed Lead");

    for (
      const invalid of [
        "amount > 1.2",
        "amount > 1e3",
        "score > 9007199254740992",
        "unknown == true",
        "actor.id == id",
        'matches(name, "x")',
        "name in []",
      ]
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--where",
        invalid,
      ]);
      assert(failed.code !== 0, `${invalid}: ${failed.stderr}`);
      const body = JSON.parse(failed.stderr) as Envelope;
      assertEquals(body.ok, false);
      assert(!failed.stderr.includes(table));
      assert(!failed.stderr.toLowerCase().includes("select "));
    }
    for (
      const args of [
        ["--fields", "name,name"],
        ["--fields", "id"],
        ["--fields", "missing"],
        ["--sort", "score:asc", "--sort", "score:desc"],
        ["--sort", "id:asc"],
        ["--sort", "missing:asc"],
      ]
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        ...args,
      ]);
      assert(failed.code !== 0, failed.stderr);
    }
    await harness.restart();
    const restartPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      cursor,
    ]);
    assert((restartPage.data.items as Array<{ id: string }>)[0].id !== firstId);
    const afterRestart = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      "score >= 42",
    ]);
    assert((afterRestart.data.items as unknown[]).length > 0);
  } finally {
    await harness.close();
  }
});

async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  for await (const entry of walk(source, { includeDirs: true })) {
    const target = join(destination, relative(source, entry.path));
    if (entry.isDirectory) await Deno.mkdir(target, { recursive: true });
    else if (entry.isFile) await Deno.copyFile(entry.path, target);
  }
}

async function runJson(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  args: string[],
): Promise<Envelope> {
  const result = await harness.runOptctl(["--json", ...args]);
  assertEquals(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout) as Envelope;
  assertEquals(body.ok, true);
  return body;
}
