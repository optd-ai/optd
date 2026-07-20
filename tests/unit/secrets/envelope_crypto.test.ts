function assertEquals(actual: unknown, expected: unknown): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
function assertNotEquals(actual: unknown, expected: unknown): void {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    if (
      actual.length === expected.length &&
      actual.every((value, index) => value === expected[index])
    ) throw new Error("values unexpectedly equal");
  } else if (Object.is(actual, expected)) {
    throw new Error("values unexpectedly equal");
  }
}
function assertThrows(
  fn: () => unknown,
  type: new (...args: never[]) => Error,
): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof type) return;
    throw error;
  }
  throw new Error("expected function to throw");
}
async function assertRejects(
  fn: () => Promise<unknown>,
  type: new (...args: never[]) => Error,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof type) return;
    throw error;
  }
  throw new Error("expected promise to reject");
}
import {
  canonicalAad,
  EnvelopeCrypto,
  SecretDecryptError,
  SecretKeyMalformedError,
  SecretKeyMismatchError,
  SecretKeyMissingError,
} from "../../../src/adapters/outbound/crypto/envelope.ts";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const ID = "0198c4ba-42b8-7000-8000-000000000001";

Deno.test("secret envelope uses canonical AAD and fresh 96-bit nonces", async () => {
  const adapter = new EnvelopeCrypto(KEY);
  const aad = { secret_id: ID, value_version: 1 };
  const first = await adapter.encrypt("top-secret", aad);
  const second = await adapter.encrypt("top-secret", aad);
  assertEquals(first.nonce.length, 12);
  assertNotEquals(first.nonce, second.nonce);
  assertNotEquals(first.ciphertext, second.ciphertext);
  assertEquals(await adapter.decrypt(first, aad), "top-secret");
  assertEquals(
    new TextDecoder().decode(canonicalAad({ ...aad, key_id: first.keyId })),
    `{"schema":"secret.value.v1","secret_id":"${ID}","value_version":1,"key_id":"${first.keyId}"}`,
  );
});

Deno.test("secret envelope rejects missing, malformed, and non-canonical keys", () => {
  assertThrows(() => new EnvelopeCrypto().validateKey(), SecretKeyMissingError);
  for (const key of ["passphrase", "00".repeat(32), `${KEY}=`, ` ${KEY}`]) {
    assertThrows(
      () => new EnvelopeCrypto(key).validateKey(),
      SecretKeyMalformedError,
    );
  }
});

Deno.test("secret envelope fails closed for tamper, AAD swap, version swap, and key mismatch", async () => {
  const adapter = new EnvelopeCrypto(KEY);
  const aad = { secret_id: ID, value_version: 1 };
  const encrypted = await adapter.encrypt("secret", aad);
  const tampered = { ...encrypted, ciphertext: encrypted.ciphertext.slice() };
  tampered.ciphertext[0] ^= 1;
  await assertRejects(() => adapter.decrypt(tampered, aad), SecretDecryptError);
  await assertRejects(
    () =>
      adapter.decrypt(encrypted, { ...aad, secret_id: `${ID.slice(0, -1)}2` }),
    SecretDecryptError,
  );
  await assertRejects(
    () => adapter.decrypt(encrypted, { ...aad, value_version: 2 }),
    SecretKeyMismatchError,
  );
  await assertRejects(
    () => new EnvelopeCrypto(OTHER_KEY).decrypt(encrypted, aad),
    SecretKeyMismatchError,
  );
});
