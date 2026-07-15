import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import { assertHealth } from "../support/live_harness.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("bootstrap scenario crosses real HTTP, Postgres, and optctl boundaries", async () => {
  const harness = await startAuthenticatedHarness();
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
