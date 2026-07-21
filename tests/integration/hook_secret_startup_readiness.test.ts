// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startLiveHarness } from "../support/live_harness.ts";
import {
  startManagedPostgres,
  stopManagedPostgres,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";

const KEY_A = btoa(String.fromCharCode(...new Uint8Array(32).fill(41)));
const KEY_B = btoa(String.fromCharCode(...new Uint8Array(32).fill(42)));

Deno.test({
  name:
    "secret startup readiness fails closed for missing malformed mismatch and tamper",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const zero = await startLiveHarness({
      bootstrapToken: "startup-bootstrap-token",
      environment: { OPERANT_SECRET_MASTER_KEY: null },
    });
    try {
      const token = await bootstrapToken(
        zero.baseUrl,
        "zero-key-admin",
        "startup-bootstrap-token",
      );
      const mutation = await fetch(`${zero.baseUrl}/api/v1/secrets`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "unavailable", value: "not-stored" }),
      });
      const mutationBody = await mutation.json();
      assertEquals(mutation.status, 503);
      assertEquals(mutationBody.error.code, "secret_key_unavailable");
      assertEquals(
        (await query<{ count: string }>(
          zero.server.sql,
          "select count(*)::text count from platform_secrets",
        )).rows[0].count,
        "0",
      );
    } finally {
      await zero.close();
    }

    await assertRejects(
      () =>
        startLiveHarness({
          environment: { OPERANT_SECRET_MASTER_KEY: "malformed" },
        }),
      Error,
      "canonical base64",
    );

    const externalRoot = await Deno.makeTempDir({
      prefix: "operant-secret-startup-pg-",
    });
    const external = await startManagedPostgres(externalRoot);
    const encrypted = await startLiveHarness({
      externalDatabaseUrl: external.databaseUrl,
      environment: { OPERANT_SECRET_MASTER_KEY: KEY_A },
    });
    try {
      assertEquals(
        (await encrypted.bootstrap({
          username: "encrypted-admin",
          password: "encrypted startup password",
        })).code,
        0,
      );
      const created = await encrypted.runOptctl([
        "--json",
        "secret",
        "create",
        "startup-proof",
        "--stdin",
      ], "startup-plaintext\n");
      assertEquals(created.code, 0, created.stderr);

      await assertRejects(
        () =>
          encrypted.restart({
            environment: { OPERANT_SECRET_MASTER_KEY: null },
          }),
        Error,
        "secret encryption key is unavailable",
      );
      await assertRejects(
        () =>
          encrypted.restart({
            environment: { OPERANT_SECRET_MASTER_KEY: KEY_B },
          }),
        Error,
        "fingerprint does not match",
      );
      await encrypted.restart({
        environment: { OPERANT_SECRET_MASTER_KEY: KEY_A },
      });
      const ready = await fetch(`${encrypted.baseUrl}/ready`);
      await ready.body?.cancel();
      assertEquals(ready.status, 200);

      await query(
        encrypted.server.sql,
        `update platform_secrets set ciphertext=set_byte(ciphertext,0,get_byte(ciphertext,0)#1)`,
      );
      await assertRejects(
        () =>
          encrypted.restart({
            environment: { OPERANT_SECRET_MASTER_KEY: KEY_A },
          }),
        Error,
        "secret decryption failed",
      );
    } finally {
      await encrypted.close();
      await stopManagedPostgres(external);
      await Deno.remove(externalRoot, { recursive: true }).catch(() =>
        undefined
      );
    }
  },
});

async function bootstrapToken(
  baseUrl: string,
  username: string,
  bootstrapToken: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Operant-Bootstrap ${bootstrapToken}`,
    },
    body: JSON.stringify({
      username,
      display_name: "Startup Administrator",
      password: "startup readiness password",
    }),
  });
  const body = await response.json();
  assertEquals(response.status, 201, JSON.stringify(body));
  assert(typeof body.data.credentials.token === "string");
  return body.data.credentials.token;
}
