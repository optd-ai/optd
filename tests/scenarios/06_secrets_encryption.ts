import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  DenoHookRunner,
  type HookDefinition,
} from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";
import {
  EnvelopeCrypto,
  SecretKeyMissingError,
} from "../../src/adapters/outbound/crypto/envelope.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { PostgresTransactionManager } from "../../src/adapters/outbound/postgres/transaction_manager.ts";
import {
  assertSecretSubsystemReady,
  makeSecretService,
} from "../../src/application/services/manage_secret.ts";
import { startLiveHarness } from "../support/live_harness.ts";

Deno.test("scenario: encrypted secrets are masked and injected only by declared hook refs", async () => {
  const previousKey = Deno.env.get("OPERANT_SECRET_MASTER_KEY");
  Deno.env.set("OPERANT_SECRET_MASTER_KEY", "scenario-master-key");
  const harness = await startLiveHarness();
  try {
    const secretValue = "live-secret-value-please-do-not-leak";
    const set = await harness.runOptctl([
      "--json",
      "secret",
      "set",
      "api_token",
      "--value",
      secretValue,
      "--description",
      "hook API token",
      "--actor",
      "super_admin",
    ]);
    assertEquals(set.code, 0, set.stderr);
    assert(!set.stdout.includes(secretValue));
    assertStringIncludes(set.stdout, '"masked": true');

    const list = await harness.runOptctl([
      "--json",
      "secret",
      "list",
      "--actor",
      "super_admin",
    ]);
    assertEquals(list.code, 0, list.stderr);
    assert(!list.stdout.includes(secretValue));
    assertStringIncludes(list.stdout, "api_token");

    const stored = await query<{ ciphertext_text: string; audit_text: string }>(
      harness.server.sql,
      `select
         encode((select ciphertext from platform_secrets where name='api_token'), 'escape') as ciphertext_text,
         coalesce((select string_agg(request_metadata_json::text || coalesce(policy_summary_json::text,''), ' ')
                   from audit_events where resource='platform.secret'), '') as audit_text`,
    );
    assert(stored.rows[0]);
    assert(!stored.rows[0].ciphertext_text.includes(secretValue));
    assert(!stored.rows[0].audit_text.includes(secretValue));

    const secrets = makeSecretService({
      sql: harness.server.sql,
      tx: new PostgresTransactionManager(harness.server.sql),
    });
    const runner = new DenoHookRunner({
      cacheDir: await Deno.makeTempDir(),
      secretResolver: (name) => secrets.resolveSecret(name),
    });
    const hook: HookDefinition = {
      namespace: "test",
      name: "uses_secret",
      revision: "test.pack@0:secret",
      scriptPath: "hooks/uses_secret.ts",
      scriptDigest: "sha256:uses_secret",
      scriptContent: `const token = Deno.env.get("API_TOKEN");
let undeclared = false;
try { undeclared = Deno.env.get("UNDECLARED_SECRET") !== undefined; } catch { undeclared = false; }
console.error("hook ran without printing token");
console.log(JSON.stringify({ errors: token === "live-secret-value-please-do-not-leak" && !undeclared ? [] : ["secret env mismatch"] }));`,
      outputSchema: "validation.v1",
      timeoutMs: 1_000,
      permissions: {},
      secrets: [{ name: "api_token", env: "API_TOKEN" }],
    };
    const result = await runner.run(hook, {
      hook: "uses_secret",
      phase: "scenario.secret",
      input: {},
    });
    assertEquals(result.ok, true, JSON.stringify(result.error));
    assertEquals(result.output?.errors, []);
    assert(!result.logs.includes(secretValue));

    const undeclared = await runner.run({
      ...hook,
      name: "undeclared_secret",
      scriptContent: `let value = null;
try { value = Deno.env.get("API_TOKEN"); } catch { value = null; }
console.log(JSON.stringify({ errors: value === null ? [] : ["undeclared access"] }));`,
      secrets: [],
    }, { hook: "undeclared_secret", phase: "scenario.secret", input: {} });
    assertEquals(undeclared.ok, true);
    assertEquals(undeclared.output?.errors, []);

    await assertRejects(
      () =>
        assertSecretSubsystemReady(
          harness.server.sql,
          new EnvelopeCrypto(null),
        ),
      SecretKeyMissingError,
    );
  } finally {
    await harness.close();
    if (previousKey === undefined) Deno.env.delete("OPERANT_SECRET_MASTER_KEY");
    else Deno.env.set("OPERANT_SECRET_MASTER_KEY", previousKey);
  }
});
