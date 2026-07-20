import { canonicalJson } from "../ids/canonical_json.ts";
import { constantTimeDigestEqual } from "../auth/token.ts";

const DOMAIN = "operant.query.cursor.v1\0";
const text = new TextEncoder();
export type QueryCursorPosition = Readonly<{ values: unknown[]; id: string }>;

export class QueryCursorSigner {
  readonly #key: Promise<CryptoKey>;
  constructor(masterKey: string | null | undefined) {
    if (!masterKey?.trim()) {
      throw new Error("OPERANT_MASTER_KEY is required for query cursors");
    }
    this.#key = derive(masterKey.trim());
  }
  static fromEnvironment() {
    return new QueryCursorSigner(Deno.env.get("OPERANT_MASTER_KEY"));
  }
  async encode(
    shapeDigest: string,
    policyDigest: string,
    position: QueryCursorPosition,
  ): Promise<string> {
    const payload = text.encode(
      canonicalJson({
        v: 1,
        shape_digest: shapeDigest,
        policy_digest: policyDigest,
        values: position.values,
        id: position.id,
      }),
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", await this.#key, payload),
    );
    const bytes = new Uint8Array(signature.length + payload.length);
    bytes.set(signature);
    bytes.set(payload, signature.length);
    return base64url(bytes);
  }
  async decode(
    cursor: string,
    shapeDigest: string,
    policyDigest: string,
  ): Promise<QueryCursorPosition> {
    try {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error();
      }
      const bytes = unbase64url(cursor);
      if (bytes.length <= 32) throw new Error();
      const signature = bytes.slice(0, 32), payload = bytes.slice(32);
      const expected = new Uint8Array(
        await crypto.subtle.sign("HMAC", await this.#key, payload),
      );
      if (!constantTimeDigestEqual(hex(signature), hex(expected))) {
        throw new Error();
      }
      const value = JSON.parse(new TextDecoder().decode(payload));
      if (
        !value ||
        Object.keys(value).sort().join(",") !==
          "id,policy_digest,shape_digest,v,values" ||
        value.v !== 1 ||
        value.shape_digest !== shapeDigest ||
        value.policy_digest !== policyDigest || !Array.isArray(value.values) ||
        typeof value.id !== "string"
      ) throw new Error();
      return { values: value.values, id: value.id };
    } catch {
      throw new Error("invalid_cursor");
    }
  }
}
async function derive(master: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    text.encode(`${DOMAIN}${master}`),
  );
  return await crypto.subtle.importKey(
    "raw",
    digest,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}
function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
function unbase64url(value: string) {
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4),
  );
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
function hex(bytes: Uint8Array) {
  return [...bytes].map((v) => v.toString(16).padStart(2, "0")).join("");
}
