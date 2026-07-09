import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import { assertHealth, startLiveHarness } from "../support/live_harness.ts";

Deno.test("bootstrap scenario crosses real HTTP and optctl boundaries", async () => {
  const harness = await startLiveHarness();
  try {
    const health = await assertHealth(harness.baseUrl);
    assertEquals(health.data.version, "0.1.0-dev");

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
