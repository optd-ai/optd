export type EncryptedSecret = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  algorithm: "AES-256-GCM";
  keyId: string;
};

export class SecretKeyMissingError extends Error {
  readonly code = "secret_master_key_missing";
  constructor() {
    super("OPERANT_SECRET_MASTER_KEY is required for secret operations");
  }
}

export class SecretDecryptError extends Error {
  readonly code = "secret_decrypt_failed";
  constructor() {
    super("secret decryption failed");
  }
}

export class EnvelopeCrypto {
  #material: string | null;

  constructor(
    masterKey: string | null | undefined = Deno.env.get(
      "OPERANT_SECRET_MASTER_KEY",
    ),
  ) {
    this.#material = masterKey?.trim() || null;
  }

  hasKey(): boolean {
    return this.#material !== null;
  }

  async keyId(): Promise<string> {
    const bytes = await this.#keyBytes();
    const digest = await crypto.subtle.digest("SHA-256", asBufferSource(bytes));
    return hex(new Uint8Array(digest)).slice(0, 24);
  }

  async encrypt(plaintext: string): Promise<EncryptedSecret> {
    const key = await this.#cryptoKey();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plaintext);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: asBufferSource(nonce) },
        key,
        encoded,
      ),
    );
    return {
      ciphertext,
      nonce,
      algorithm: "AES-256-GCM",
      keyId: await this.keyId(),
    };
  }

  async decrypt(secret: EncryptedSecret): Promise<string> {
    if (secret.algorithm !== "AES-256-GCM") {
      throw new SecretDecryptError();
    }
    const key = await this.#cryptoKey();
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: asBufferSource(secret.nonce) },
        key,
        asBufferSource(secret.ciphertext),
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      throw new SecretDecryptError();
    }
  }

  async #cryptoKey(): Promise<CryptoKey> {
    const bytes = await this.#keyBytes();
    return await crypto.subtle.importKey(
      "raw",
      asBufferSource(bytes),
      "AES-GCM",
      false,
      [
        "encrypt",
        "decrypt",
      ],
    );
  }

  async #keyBytes(): Promise<Uint8Array> {
    if (!this.#material) throw new SecretKeyMissingError();
    const decoded = decodeKeyMaterial(this.#material);
    if (decoded.length === 32) return decoded;
    return new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(this.#material),
      ),
    );
  }
}

function decodeKeyMaterial(value: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return new Uint8Array(
      value.match(/../g)!.map((part) => parseInt(part, 16)),
    );
  }
  try {
    const bin = atob(value);
    return Uint8Array.from(bin, (char) => char.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}
