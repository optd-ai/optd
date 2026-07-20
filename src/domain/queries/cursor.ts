import { canonicalJson } from "../ids/canonical_json.ts";
import { constantTimeDigestEqual } from "../auth/token.ts";
import { isUuidV7 } from "../ids/uuid_v7.ts";
import type { FieldSpec } from "../expressions/cel.ts";

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
    if (!isUuidV7(position.id)) throw new Error("invalid cursor position");
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
    specs: readonly FieldSpec[],
  ): Promise<QueryCursorPosition> {
    try {
      if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error();
      }
      const bytes = unbase64url(cursor);
      if (bytes.length <= 32 || bytes.length > 3072) throw new Error();
      const signature = bytes.slice(0, 32), payload = bytes.slice(32);
      const expected = new Uint8Array(
        await crypto.subtle.sign("HMAC", await this.#key, payload),
      );
      if (!constantTimeDigestEqual(hex(signature), hex(expected))) {
        throw new Error();
      }
      const value: unknown = JSON.parse(new TextDecoder().decode(payload));
      if (
        !record(value) ||
        Object.keys(value).sort().join(",") !==
          "id,policy_digest,shape_digest,v,values" ||
        value.v !== 1 || value.shape_digest !== shapeDigest ||
        value.policy_digest !== policyDigest ||
        !Array.isArray(value.values) || value.values.length !== specs.length ||
        !isUuidV7(value.id)
      ) throw new Error();
      for (let index = 0; index < specs.length; index++) {
        validateValue(value.values[index], specs[index]);
      }
      return { values: value.values, id: value.id };
    } catch {
      throw new Error("invalid_cursor");
    }
  }
}
function validateValue(value: unknown, spec: FieldSpec): void {
  if (value === null) {
    if (!spec.nullable) throw new Error();
    return;
  }
  if (Array.isArray(value) || record(value)) throw new Error();
  switch (spec.type) {
    case "string":
      if (
        typeof value !== "string" ||
        (spec.format === "uuid" && !isUuidV7(value))
      ) throw new Error();
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw new Error();
      }
      return;
    case "decimal":
      if (
        typeof value !== "string" ||
        !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(value) || value === "-0"
      ) throw new Error();
      return;
    case "boolean":
      if (typeof value !== "boolean") throw new Error();
      return;
    case "date":
      if (
        typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
      ) throw new Error();
      return;
    case "timestamp": {
      if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      ) throw new Error();
      const canonical = new Date(value).toISOString();
      if (value !== canonical && value !== canonical.replace(".000Z", "Z")) {
        throw new Error();
      }
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
