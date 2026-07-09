import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert";
import {
  EnvelopeCrypto,
  SecretDecryptError,
  SecretKeyMissingError,
} from "../../src/adapters/outbound/crypto/envelope.ts";

Deno.test("EnvelopeCrypto encrypts/decrypts and never returns plaintext ciphertext", async () => {
  const cryptoAdapter = new EnvelopeCrypto("test-master-key");
  const encrypted = await cryptoAdapter.encrypt("top-secret-value");
  assertEquals(encrypted.algorithm, "AES-256-GCM");
  assertNotEquals(
    new TextDecoder().decode(encrypted.ciphertext),
    "top-secret-value",
  );
  assertEquals(await cryptoAdapter.decrypt(encrypted), "top-secret-value");
});

Deno.test("EnvelopeCrypto fails with wrong or missing key", async () => {
  const encrypted = await new EnvelopeCrypto("right-key").encrypt("secret");
  await assertRejects(
    () => new EnvelopeCrypto("wrong-key").decrypt(encrypted),
    SecretDecryptError,
  );
  await assertRejects(
    () => new EnvelopeCrypto("").encrypt("secret"),
    SecretKeyMissingError,
  );
});
