function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertNotEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    throw new Error("values unexpectedly equal");
  }
}
async function assertRejects(
  fn: () => Promise<unknown>,
  type?: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!type || error instanceof type) return;
    throw error;
  }
  throw new Error("expected promise to reject");
}
import {
  EnvelopeCrypto,
  SecretDecryptError,
  SecretKeyMalformedError,
  SecretKeyMissingError,
} from "../../src/adapters/outbound/crypto/envelope.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(1)));
const OTHER = btoa(String.fromCharCode(...new Uint8Array(32).fill(2)));
const aad = {
  secret_id: "0198c4ba-42b8-7000-8000-000000000001",
  value_version: 1,
};

Deno.test("EnvelopeCrypto encrypts with row/version AAD and fresh nonce", async () => {
  const cryptoAdapter = new EnvelopeCrypto(KEY);
  const encrypted = await cryptoAdapter.encrypt("top-secret-value", aad);
  const second = await cryptoAdapter.encrypt("top-secret-value", aad);
  assertEquals(encrypted.algorithm, "AES-256-GCM");
  assertEquals(encrypted.nonce.length, 12);
  assertNotEquals(encrypted.nonce, second.nonce);
  assertNotEquals(
    new TextDecoder().decode(encrypted.ciphertext),
    "top-secret-value",
  );
  assertEquals(await cryptoAdapter.decrypt(encrypted, aad), "top-secret-value");
});

Deno.test("EnvelopeCrypto rejects malformed, missing, wrong keys and AAD tamper", async () => {
  const encrypted = await new EnvelopeCrypto(KEY).encrypt("secret", aad);
  await assertRejects(
    () => new EnvelopeCrypto(OTHER).decrypt(encrypted, aad),
  );
  await assertRejects(
    () =>
      new EnvelopeCrypto(KEY).decrypt(encrypted, {
        ...aad,
        secret_id: `${aad.secret_id.slice(0, -1)}2`,
      }),
    SecretDecryptError,
  );
  await assertRejects(
    () => new EnvelopeCrypto("").encrypt("secret", aad),
    SecretKeyMissingError,
  );
  await assertRejects(
    () => new EnvelopeCrypto("passphrase").encrypt("secret", aad),
    SecretKeyMalformedError,
  );
});
