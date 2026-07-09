import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { planPostgresRuntime } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

Deno.test("app-managed Postgres lifecycle seam skips cleanly until postgres-foundation", () => {
  const plan = planPostgresRuntime();
  if (plan.mode === "external") {
    assertEquals(Boolean(plan.databaseUrl), true);
    return;
  }
  if (!plan.binariesAvailable) {
    assertStringIncludes(plan.skipReason ?? "", "OPERANT_PG_BIN_DIR");
    return;
  }
  assertEquals(plan.mode, "app_managed");
  assertEquals(plan.binariesAvailable, true);
});
