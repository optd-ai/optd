import { assert, assertEquals } from "@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("postgres bootstrap scenario validates HTTP health and restart persistence", async () => {
  if (!Deno.env.get("OPTD_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP postgres bootstrap scenario: postgres binaries not found; set OPTD_PG_BIN_DIR or enter nix shell",
    );
    return;
  }
  const harness = await startAuthenticatedHarness();
  try {
    let ready = await harness.runOptctl(["--json", "status", "ready"]);
    assertEquals(ready.code, 0, ready.stderr);
    let health = JSON.parse(ready.stdout).data;
    assertEquals(health.database.ok, true);
    assertEquals(health.migrations.ok, true);
    assert(health.migrations.appliedCount >= 2);

    await query(
      harness.server.sql,
      "insert into platform_kv(key, value) values ($1, jsonb_build_object('survived', true)) on conflict (key) do update set value = excluded.value, updated_at = now()",
      ["http_restart_sentinel"],
    );
    await harness.restart();
    ready = await harness.runOptctl(["--json", "status", "ready"]);
    assertEquals(ready.code, 0, ready.stderr);
    health = JSON.parse(ready.stdout).data;
    assertEquals(health.database.ok, true);
    assertEquals(health.migrations.ok, true);

    const sentinel = await query<{ survived: boolean }>(
      harness.server.sql,
      "select (value->>'survived')::boolean as survived from platform_kv where key = $1",
      ["http_restart_sentinel"],
    );
    assertEquals(sentinel.rows[0]?.survived, true);
  } finally {
    await harness.close();
  }
});
