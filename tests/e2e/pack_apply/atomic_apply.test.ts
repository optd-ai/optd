import { assertEquals } from "jsr:@std/assert";
import { startLiveHarness } from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";

Deno.test("compiled optctl applies one safe plan and exposes global activation", async () => {
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "root",
      password: "atomic pack apply password",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    const preview = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      "prototypes/crm-default-pack",
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const plan = JSON.parse(preview.stdout).data.plan;
    const validation = await harness.runOptctl([
      "--json",
      "migration",
      "validate",
      plan.id,
    ]);
    assertEquals(validation.code, 0, validation.stderr);
    const wrong = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      plan.id,
      "--reviewed",
    ]);
    assertEquals(wrong.code, 1);
    assertEquals(
      JSON.parse(wrong.stderr).error.code,
      "migration_acknowledgement_invalid",
    );
    const applied = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      plan.id,
      "--safe",
    ]);
    assertEquals(applied.code, 0, applied.stderr);
    const repeated = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      plan.id,
      "--safe",
    ]);
    assertEquals(repeated.code, 0, repeated.stderr);
    assertEquals(
      JSON.parse(repeated.stdout).data,
      JSON.parse(applied.stdout).data,
    );
    for (const slug of ["alpha", "beta"]) {
      const created = await harness.runOptctl([
        "--json",
        "project",
        "create",
        slug,
        "--display-name",
        slug,
      ]);
      assertEquals(created.code, 0, created.stderr);
      const selected = await harness.runOptctl([
        "--json",
        "project",
        "select",
        slug,
      ]);
      assertEquals(selected.code, 0, selected.stderr);
      const metadata = await harness.runOptctl([
        "--json",
        "metadata",
        "resource",
        "operant/crm:lead",
      ]);
      assertEquals(metadata.code, 0, metadata.stderr);
    }
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from pack_migration_applications where plan_id=$1",
        [plan.id],
      )).rows[0].count,
      "1",
    );
  } finally {
    await harness.close();
  }
});
