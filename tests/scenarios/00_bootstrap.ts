import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { assertHealth, startLiveHarness } from "../support/live_harness.ts";

Deno.test("bootstrap scenario crosses real HTTP, Postgres, and optctl boundaries", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP bootstrap scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }
  const harness = await startLiveHarness();
  try {
    const health = await assertHealth(harness.baseUrl);
    assertEquals(health.data.version, "0.1.0-dev");
    assertEquals(health.data.database.ok, true);
    assertEquals(health.data.migrations.ok, true);

    const optctl = await harness.runOptctl(["home", "--json"]);
    assertEquals(optctl.code, 0, optctl.stderr);
    const home = JSON.parse(optctl.stdout);
    assertEquals(home.ok, true);
    assertEquals(home.data.status, "ready");
    assertEquals(home.data.version, "0.1.0-dev");
    assert(home.data.capabilities.includes("metadata.home"));

    assertStringIncludes(optctl.stdout, "metadata.home");
    await assertRejects(
      () => fetch("http://127.0.0.1:1/health"),
      TypeError,
    );
  } finally {
    await harness.close();
  }
});
