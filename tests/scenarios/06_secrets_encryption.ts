// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test("scenario: encrypted secrets are masked through authenticated public CLI", async () => {
  const previousKey = Deno.env.get("OPTD_SECRET_MASTER_KEY");
  Deno.env.set(
    "OPTD_SECRET_MASTER_KEY",
    btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  );
  const harness = await startAuthenticatedHarness();
  try {
    const secretValue = "live-secret-value-please-do-not-leak";
    const set = await harness.runOptctl([
      "--json",
      "secret",
      "create",
      "api_token",
      "--stdin",
      "--description",
      "hook API token",
    ], `${secretValue}\n`);
    assertEquals(set.code, 0, set.stderr);
    assert(!set.stdout.includes(secretValue));
    assertStringIncludes(set.stdout, '"status": "active"');

    const list = await harness.runOptctl([
      "--json",
      "secret",
      "list",
    ]);
    assertEquals(list.code, 0, list.stderr);
    assert(!list.stdout.includes(secretValue));
    assertStringIncludes(list.stdout, "api_token");

    const stored = await query<{ ciphertext_text: string; audit_text: string }>(
      harness.server.sql,
      `select
         encode((select ciphertext from platform_secrets where name='api_token'), 'escape') as ciphertext_text,
         coalesce((select string_agg(request_metadata_json::text || coalesce(policy_summary_json::text,''), ' ')
                   from audit_events where resource='system:secret'), '') as audit_text`,
    );
    assert(stored.rows[0]);
    assert(!stored.rows[0].ciphertext_text.includes(secretValue));
    assert(!stored.rows[0].audit_text.includes(secretValue));
  } finally {
    await harness.close();
    if (previousKey === undefined) Deno.env.delete("OPTD_SECRET_MASTER_KEY");
    else Deno.env.set("OPTD_SECRET_MASTER_KEY", previousKey);
  }
});
