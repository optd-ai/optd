import type {
  SecretCipher,
  SecretCiphertext,
  SecretValueAad as ApplicationSecretValueAad,
} from "../../../application/ports/repair/repositories.ts";

export const SECRET_VALUE_SCHEMA = "secret.value.v1" as const;
export const SECRET_ALGORITHM = "AES-256-GCM" as const;

export type SecretValueAad = {
  secret_id: string;
  value_version: number;
  key_id?: string;
};

export type EncryptedSecret = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  algorithm: typeof SECRET_ALGORITHM;
  keyId: string;
  valueVersion?: number;
};

export class SecretKeyMissingError extends Error {
  readonly code = "secret_key_unavailable";
  constructor() {
    super("secret encryption key is unavailable");
  }
}

export class SecretKeyMalformedError extends Error {
  readonly code = "secret_master_key_invalid";
  constructor() {
    super(
      "OPTD_SECRET_MASTER_KEY must be canonical base64 for exactly 32 bytes",
    );
  }
}

export class SecretKeyMismatchError extends Error {
  readonly code = "secret_key_mismatch";
  constructor() {
    super("encrypted secret key fingerprint does not match the configured key");
  }
}

export class SecretDecryptError extends Error {
  readonly code = "secret_decrypt_failed";
  constructor() {
    super("secret decryption failed");
  }
}

/** Outbound AES-GCM envelope adapter for one mutable secret row. */
export class EnvelopeCrypto {
  readonly #material: string | null;
  #bytes?: Uint8Array;
  #keyId?: string;

  constructor(
    masterKey: string | null | undefined = Deno.env.get(
      "OPTD_SECRET_MASTER_KEY",
    ),
  ) {
    // Whitespace is not ignored: accepting it would make the representation
    // non-canonical and can conceal a malformed mounted secret.
    this.#material =
      masterKey === undefined || masterKey === null || masterKey === ""
        ? null
        : masterKey;
  }

  hasKey(): boolean {
    return this.#material !== null;
  }

  /** Validates configured material even when no encryption operation is needed. */
  validateKey(): void {
    void this.#keyBytes();
  }

  async keyId(): Promise<string> {
    if (this.#keyId) return this.#keyId;
    const bytes = this.#keyBytes();
    const prefix = new TextEncoder().encode(
      "secret.master-key.v1\0AES-256-GCM\0",
    );
    const input = new Uint8Array(prefix.length + bytes.length);
    input.set(prefix);
    input.set(bytes, prefix.length);
    const digest = await crypto.subtle.digest("SHA-256", asBufferSource(input));
    this.#keyId = `secret.master-key.v1:sha256:${hex(new Uint8Array(digest))}`;
    return this.#keyId;
  }

  async encrypt(
    plaintext: string,
    aad?: SecretValueAad,
  ): Promise<EncryptedSecret> {
    aad = requireAad(aad);
    validateAadIdentity(aad);
    const keyId = await this.keyId();
    if (aad.key_id !== undefined && aad.key_id !== keyId) {
      throw new SecretKeyMismatchError();
    }
    const key = await this.#cryptoKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(nonce),
          additionalData: asBufferSource(
            canonicalAad({ ...aad, key_id: keyId }),
          ),
          tagLength: 128,
        },
        key,
        new TextEncoder().encode(plaintext),
      ),
    );
    return {
      ciphertext,
      nonce,
      algorithm: SECRET_ALGORITHM,
      keyId,
      valueVersion: aad.value_version,
    };
  }

  async decrypt(
    secret: EncryptedSecret,
    aad?: SecretValueAad,
  ): Promise<string> {
    aad = requireAad(aad);
    validateAadIdentity(aad);
    if (secret.algorithm !== SECRET_ALGORITHM || secret.nonce.length !== 12) {
      throw new SecretDecryptError();
    }
    const keyId = await this.keyId();
    if (
      secret.keyId !== keyId ||
      (aad.key_id !== undefined && aad.key_id !== keyId) ||
      (secret.valueVersion !== undefined &&
        secret.valueVersion !== aad.value_version)
    ) {
      throw new SecretKeyMismatchError();
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: asBufferSource(secret.nonce),
          additionalData: asBufferSource(
            canonicalAad({ ...aad, key_id: keyId }),
          ),
          tagLength: 128,
        },
        await this.#cryptoKey(),
        asBufferSource(secret.ciphertext),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch (error) {
      if (
        error instanceof SecretKeyMissingError ||
        error instanceof SecretKeyMalformedError
      ) {
        throw error;
      }
      throw new SecretDecryptError();
    }
  }

  async #cryptoKey(): Promise<CryptoKey> {
    return await crypto.subtle.importKey(
      "raw",
      asBufferSource(this.#keyBytes()),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }

  #keyBytes(): Uint8Array {
    if (this.#bytes) return this.#bytes;
    if (this.#material === null) throw new SecretKeyMissingError();
    let binary: string;
    try {
      binary = atob(this.#material);
    } catch {
      throw new SecretKeyMalformedError();
    }
    const decoded = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (decoded.length !== 32 || btoa(binary) !== this.#material) {
      throw new SecretKeyMalformedError();
    }
    this.#bytes = decoded;
    return decoded;
  }
}

export function canonicalAad(
  input: Required<SecretValueAad>,
): Uint8Array {
  validateAadIdentity(input);
  // Property order is part of the frozen wire contract.
  return new TextEncoder().encode(JSON.stringify({
    schema: SECRET_VALUE_SCHEMA,
    secret_id: input.secret_id,
    value_version: input.value_version,
    key_id: input.key_id,
  }));
}

function requireAad(input: SecretValueAad | undefined): SecretValueAad {
  if (!input) throw new TypeError("secret value AAD is required");
  return input;
}

function validateAadIdentity(input: SecretValueAad): void {
  if (typeof input.secret_id !== "string" || input.secret_id.length === 0) {
    throw new TypeError("secret_id is required for secret value AAD");
  }
  if (!Number.isSafeInteger(input.value_version) || input.value_version < 1) {
    throw new TypeError("value_version must be a positive safe integer");
  }
  if (input.key_id !== undefined && input.key_id.length === 0) {
    throw new TypeError("key_id must not be empty");
  }
}

export function makeEnvelopeSecretCipher(
  envelope: EnvelopeCrypto,
): SecretCipher {
  const aad = (value: ApplicationSecretValueAad, keyId?: string) => ({
    secret_id: value.rowId,
    value_version: value.version,
    ...(keyId === undefined ? {} : { key_id: keyId }),
  });
  return Object.freeze({
    hasKey: () => envelope.hasKey(),
    validateKey: () => envelope.validateKey(),
    keyId: () => envelope.keyId(),
    async encrypt(
      plaintext: string,
      value: ApplicationSecretValueAad,
    ): Promise<SecretCiphertext> {
      const encrypted = await envelope.encrypt(plaintext, aad(value));
      return {
        ...encrypted,
        valueVersion: value.version,
      };
    },
    decrypt: (encrypted: SecretCiphertext, value: ApplicationSecretValueAad) =>
      envelope.decrypt(encrypted, aad(value, encrypted.keyId)),
  });
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
