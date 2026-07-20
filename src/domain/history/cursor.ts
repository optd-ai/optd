import { canonicalJson } from "../ids/canonical_json.ts";
import { constantTimeDigestEqual } from "../auth/token.ts";
import { isUuidV7 } from "../ids/uuid_v7.ts";

const DOMAIN = "operant.history.cursor.v1\0";
const encoder = new TextEncoder();

export type HistoryCursorPosition = { createdAt: string; id: string };

export class HistoryCursorSigner {
  readonly #key: Promise<CryptoKey>;

  constructor(masterKey: string | null | undefined) {
    const material = masterKey?.trim();
    if (!material) {
      throw new Error("OPERANT_MASTER_KEY is required for history cursors");
    }
    this.#key = deriveKey(material);
  }

  static fromEnvironment(): HistoryCursorSigner {
    return new HistoryCursorSigner(Deno.env.get("OPERANT_MASTER_KEY"));
  }

  async encode(
    bound: unknown,
    position: HistoryCursorPosition,
  ): Promise<string> {
    const payload = encoder.encode(canonicalJson({
      v: 1,
      bound,
      created_at: position.createdAt,
      id: position.id,
    }));
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.#key, payload),
    );
    const combined = new Uint8Array(signature.length + payload.length);
    combined.set(signature);
    combined.set(payload, signature.length);
    return encodeBase64Url(combined);
  }

  async decode(
    cursor: string,
    expected: unknown,
  ): Promise<HistoryCursorPosition> {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
      throw new Error("bad cursor");
    }
    const bytes = decodeBase64Url(cursor);
    if (!constantTimeDigestEqual(cursor, encodeBase64Url(bytes))) {
      throw new Error("bad cursor");
    }
    if (bytes.length <= 32) throw new Error("bad cursor");
    const signature = bytes.slice(0, 32);
    const payload = bytes.slice(32);
    const expectedSignature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.#key, payload),
    );
    if (!constantTimeDigestEqual(toHex(signature), toHex(expectedSignature))) {
      throw new Error("bad cursor signature");
    }
    const value = JSON.parse(new TextDecoder().decode(payload));
    if (
      !value ||
      Object.keys(value).sort().join(",") !== "bound,created_at,id,v" ||
      value.v !== 1 || canonicalJson(value.bound) !== canonicalJson(expected)
    ) {
      throw new Error("cursor mismatch");
    }
    if (
      typeof value.created_at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.created_at) || !isUuidV7(value.id)
    ) {
      throw new Error("bad cursor position");
    }
    return { createdAt: value.created_at, id: value.id };
  }
}

async function deriveKey(material: string): Promise<CryptoKey> {
  const source = encoder.encode(`${DOMAIN}${material}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
