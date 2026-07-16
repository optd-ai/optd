import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";

Deno.test("compiled pack preview persists inactive reusable candidates and distinct plans for both proof packs", async () => {
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "root",
      password: "strict pack preview password",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    let crmCandidate = "";
    let firstPlan = "";
    for (
      const dir of [
        "prototypes/crm-default-pack",
        "prototypes/project-management-pack",
      ] as const
    ) {
      const preview = await harness.runOptctl([
        "--json",
        "pack",
        "preview",
        dir,
      ]);
      assertEquals(preview.code, 0, preview.stderr);
      const data = JSON.parse(preview.stdout).data;
      assertEquals(data.active, false);
      assertEquals(data.pack.active, false);
      assertEquals(data.plan.schema_version, "migration.plan.v1");
      assertEquals(data.plan.from_pack_revision_id, null);
      if (dir.includes("crm")) {
        crmCandidate = data.plan.to_pack_revision_id;
        firstPlan = data.plan.id;
      }
    }
    const repeated = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      "prototypes/crm-default-pack",
    ]);
    assertEquals(repeated.code, 0, repeated.stderr);
    const repeatedData = JSON.parse(repeated.stdout).data;
    assertEquals(repeatedData.candidate.reused, true);
    assertEquals(repeatedData.plan.to_pack_revision_id, crmCandidate);
    assertNotEquals(repeatedData.plan.id, firstPlan);
    const sqlPreview = await harness.runOptctl([
      "--json",
      "migration",
      "inspect",
      repeatedData.plan.id,
      "--sql",
    ]);
    assertEquals(sqlPreview.code, 0, sqlPreview.stderr);
    assertEquals(
      JSON.parse(sqlPreview.stdout).data.statements.length > 0,
      true,
    );
    const validation = await harness.runOptctl([
      "--json",
      "migration",
      "validate",
      repeatedData.plan.id,
    ]);
    assertEquals(validation.code, 0, validation.stderr);
    assertEquals(JSON.parse(validation.stdout).data.status, "ready");
    assertEquals(JSON.parse(validation.stdout).data.confirmation_token, null);
    const metadata = await harness.runOptctl(["--json", "metadata", "packs"]);
    assertEquals(metadata.code, 0, metadata.stderr);
    assertEquals(JSON.parse(metadata.stdout).data.packs, []);
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text as count from pack_active_revisions",
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text as count from pack_candidate_revisions",
      )).rows[0].count,
      "2",
    );

    const malformed = await Deno.makeTempDir({
      prefix: "operant-legacy-pack-",
    });
    try {
      await Deno.writeTextFile(
        `${malformed}/pack.yaml`,
        `kind: Pack\napiVersion: operant.dev/v1\nmetadata: {namespace: default, name: legacy, version: 0.1.0}\nspec: {purpose: Legacy., axi: {}}\n`,
      );
      const rejected = await harness.runOptctl([
        "--json",
        "pack",
        "preview",
        malformed,
      ]);
      assertNotEquals(rejected.code, 0);
      assertStringIncludes(rejected.stderr, "bad_pack");
      assertStringIncludes(rejected.stderr, "additional properties");
      await Deno.writeTextFile(
        `${malformed}/pack.yaml`,
        `kind: Pack\napiVersion: operant.dev/v1\nmetadata: {publisher: operant, name: malformed, version: 0.1.0}\nspec: {purpose: Malformed., axi: {}}\n`,
      );
      await Deno.mkdir(`${malformed}/extensions`);
      await Deno.writeTextFile(
        `${malformed}/extensions/legacy.yaml`,
        "kind: Extension\n",
      );
      const unknown = await harness.runOptctl([
        "--json",
        "pack",
        "preview",
        malformed,
      ]);
      assertNotEquals(unknown.code, 0);
      assertStringIncludes(unknown.stderr, "unexpected directory");
    } finally {
      await Deno.remove(malformed, { recursive: true });
    }
  } finally {
    await harness.close();
  }
});
