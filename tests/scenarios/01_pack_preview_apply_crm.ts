import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("pack preview/apply CRM scenario crosses optctl HTTP boundary and survives restart", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP pack preview/apply CRM scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({ prefix: "operant-pack-scenario-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    const preview = await runOptctl([
      "--server",
      server.url,
      "pack",
      "preview",
      "prototypes/crm-default-pack",
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
    const countAfterPreview = await query<{ count: string }>(
      server.sql,
      "select count(*)::text as count from pack_revisions",
    );
    assertEquals(countAfterPreview.rows[0]?.count, "0");

    const apply = await runOptctl([
      "--server",
      server.url,
      "pack",
      "apply",
      "prototypes/crm-default-pack",
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

    const resource = await runOptctl([
      "--server",
      server.url,
      "metadata",
      "resource",
      "default.lead",
      "--json",
    ]);
    assertEquals(resource.code, 0, resource.stderr);
    assertStringIncludes(resource.stdout, "default.lead");
    assertStringIncludes(resource.stdout, "email");

    const actionToon = await runOptctl([
      "--server",
      server.url,
      "metadata",
      "action",
      "default.convert_lead",
    ]);
    assertEquals(actionToon.code, 0, actionToon.stderr);
    assertStringIncludes(actionToon.stdout, "default.convert_lead");
    assertStringIncludes(actionToon.stdout, "Convert a qualified lead");

    await server.shutdown();
    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    const home = await runOptctl(["--server", server.url, "home"]);
    assertEquals(home.code, 0, home.stderr);
    assertStringIncludes(home.stdout, "default.lead");
    assertStringIncludes(home.stdout, "default.convert_lead");
  } finally {
    if (server) await server.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});
