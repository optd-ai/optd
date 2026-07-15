export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};

/** RFC 8785 JSON Canonicalization Scheme serialization. */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function canonicalSha256(value: unknown): Promise<string> {
  return await sha256Hex(canonicalJson(value));
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertUnicodeScalarString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON only supports finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("canonical JSON does not support cycles");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(
        "canonical JSON only supports plain objects and arrays",
      );
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object).sort(compareUtf16);
    keys.forEach(assertUnicodeScalarString);
    return `{${
      keys.map((key) =>
        `${JSON.stringify(key)}:${serialize(object[key], ancestors)}`
      ).join(",")
    }}`;
  } finally {
    ancestors.delete(value);
  }
}

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (next >= 0xdc00 && next <= 0xdfff) continue;
      throw new TypeError("canonical JSON does not support lone surrogates");
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError("canonical JSON does not support lone surrogates");
    }
  }
}
