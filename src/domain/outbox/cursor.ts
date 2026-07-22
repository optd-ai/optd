import { canonicalJson } from "../ids/canonical_json.ts";
import { isUuidV7 } from "../ids/uuid_v7.ts";

const DOMAIN = "operant.outbox.cursor.v1\0";
const encoder = new TextEncoder();

export type OutboxCursorPosition = { created_at: string; id: string };

export class OutboxCursorSigner {
  readonly #key: Promise<CryptoKey>;

  constructor(masterKey: string | null | undefined) {
    const material = masterKey?.trim();
    if (!material) {
      throw new Error("OPERANT_MASTER_KEY is required for outbox cursors");
    }
    this.#key = deriveKey(material);
  }

  static fromEnvironment(): OutboxCursorSigner {
    return new OutboxCursorSigner(Deno.env.get("OPERANT_MASTER_KEY"));
  }

  async encode(
    position: OutboxCursorPosition,
    filters: Record<string, unknown>,
  ): Promise<string> {
    const payload = encoder.encode(canonicalJson({
      v: 1,
      created_at: position.created_at,
      id: position.id,
      filters: normalizeFilters(filters),
    }));
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.#key, payload),
    );
    const bytes = new Uint8Array(signature.length + payload.length);
    bytes.set(signature);
    bytes.set(payload, signature.length);
    return encodeBase64Url(bytes);
  }

  async decode(
    cursor: string,
    filters: Record<string, unknown>,
  ): Promise<OutboxCursorPosition> {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("bad cursor");
    }
    const bytes = decodeBase64Url(cursor);
    if (encodeBase64Url(bytes) !== cursor || bytes.length <= 32) {
      throw new Error("bad cursor");
    }
    const signature = bytes.slice(0, 32);
    const payload = bytes.slice(32);
    const expected = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.#key, payload),
    );
    if (!constantTimeEqual(signature, expected)) {
      throw new Error("bad cursor signature");
    }
    const value = JSON.parse(new TextDecoder().decode(payload));
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join(",") !== "created_at,filters,id,v" ||
      value.v !== 1 ||
      canonicalJson(value.filters) !==
        canonicalJson(normalizeFilters(filters)) ||
      typeof value.created_at !== "string" ||
      !Number.isFinite(Date.parse(value.created_at)) ||
      !isUuidV7(value.id)
    ) throw new Error("cursor mismatch");
    return { created_at: value.created_at, id: value.id };
  }
}

export function normalizeFilters(
  filters: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      value !== undefined && value !== null && value !== ""
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

async function deriveKey(material: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${DOMAIN}${material}`),
  );
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
function encodeBase64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
function decodeBase64Url(value: string): Uint8Array {
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
