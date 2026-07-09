import { assert, assertEquals } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { findPostgresBins } from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { startServer } from "../../src/main_server.ts";

Deno.test("postgres bootstrap scenario validates HTTP health and restart persistence", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP postgres bootstrap scenario: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }

  const dataDir = await Deno.makeTempDir({
    prefix: "operant-postgres-scenario-",
  });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }

  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    let health = await (await fetch(`${server.url}/health`)).json();
    assertEquals(health.data.database.ok, true);
    assertEquals(health.data.migrations.ok, true);
    assert(health.data.migrations.appliedCount >= 2);

    await query(
      server.sql,
      "insert into platform_kv(key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value, updated_at = now()",
      ["http_restart_sentinel", '{"survived":true}'],
    );
    await server.shutdown();
    server = undefined;

    server = await startServer({ hostname: "127.0.0.1", port: 0 });
    health = await (await fetch(`${server.url}/health`)).json();
    assertEquals(health.data.database.ok, true);
    assertEquals(health.data.migrations.ok, true);

    const sentinel = await query<{ value: { survived: boolean } }>(
      server.sql,
      "select value from platform_kv where key = $1",
      ["http_restart_sentinel"],
    );
    assertEquals(sentinel.rows[0]?.value.survived, true);
  } finally {
    if (server) await server.shutdown().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => {});
  }
});
