import { assertEquals, assertRejects } from "@std/assert";
import { QueryCursorSigner } from "../../src/domain/queries/cursor.ts";
import type { FieldSpec } from "../../src/domain/expressions/cel.ts";

const id = "019b7a2e-7c10-7000-8000-000000000001";
const specs: FieldSpec[] = [
  { type: "integer", nullable: true },
  { type: "timestamp" },
];
Deno.test("query cursor HMAC binds query, policy, schema, and typed position", async () => {
  const signer = new QueryCursorSigner("test master key material");
  const cursor = await signer.encode("sha256:shape", "sha256:policy", {
    values: [null, "2026-01-01T00:00:00.000Z"],
    id,
  });
  assertEquals(
    await signer.decode(cursor, "sha256:shape", "sha256:policy", specs),
    {
      values: [null, "2026-01-01T00:00:00.000Z"],
      id,
    },
  );
  await assertRejects(() =>
    signer.decode(cursor, "sha256:other", "sha256:policy", specs)
  );
  await assertRejects(() =>
    signer.decode(cursor, "sha256:shape", "sha256:revoked", specs)
  );
  await assertRejects(() =>
    signer.decode(cursor, "sha256:shape", "sha256:policy", [{
      type: "integer",
    }])
  );
  await assertRejects(() =>
    signer.decode(
      `${cursor.slice(0, -1)}A`,
      "sha256:shape",
      "sha256:policy",
      specs,
    )
  );
});
Deno.test("query cursor preserves PostgreSQL microsecond boundaries", async () => {
  const signer = new QueryCursorSigner("test master key material");
  for (
    const timestamp of [
      "2026-01-01T00:00:00.123001Z",
      "2026-01-01T00:00:00.123999Z",
    ]
  ) {
    const position = { values: [null, timestamp], id };
    const cursor = await signer.encode(
      "sha256:shape",
      "sha256:policy",
      position,
    );
    assertEquals(
      await signer.decode(cursor, "sha256:shape", "sha256:policy", specs),
      position,
    );
  }
});

Deno.test("query cursors reject noncanonical base64url aliases", async () => {
  const signer = new QueryCursorSigner("test master key material");
  let canonical = "";
  let alias: string | null = null;
  let shape = "";
  for (let suffix = 0; suffix < 4 && alias === null; suffix++) {
    shape = `sha256:shape${"x".repeat(suffix)}`;
    canonical = await signer.encode(shape, "sha256:policy", {
      values: [null, "2026-01-01T00:00:00.000Z"],
      id,
    });
    alias = trailingBitAlias(canonical);
  }
  if (alias === null) throw new Error("expected an aliasable cursor length");
  assertEquals(decodeBase64Url(alias), decodeBase64Url(canonical));
  await assertRejects(
    () => signer.decode(alias, shape, "sha256:policy", specs),
    Error,
    "invalid_cursor",
  );
  for (
    const malformed of [`${canonical}=`, ` ${canonical}`, `${canonical}\n`]
  ) {
    await assertRejects(
      () => signer.decode(malformed, shape, "sha256:policy", specs),
      Error,
      "invalid_cursor",
    );
  }
});

Deno.test("signed malformed cursor values still fail closed", async () => {
  const signer = new QueryCursorSigner("test master key material");
  for (
    const [value, spec] of [
      [{ nested: true }, { type: "string" }],
      [["nested"], { type: "string" }],
      [1.2, { type: "integer" }],
      ["01.0", { type: "decimal" }],
      ["1.20", { type: "decimal" }],
      ["not-a-date", { type: "date" }],
      ["not-a-uuid", { type: "string", format: "uuid" }],
      [null, { type: "boolean" }],
    ] as Array<[unknown, FieldSpec]>
  ) {
    const signed = await signer.encode("sha256:shape", "sha256:policy", {
      values: [value],
      id,
    });
    await assertRejects(
      () => signer.decode(signed, "sha256:shape", "sha256:policy", [spec]),
      Error,
      "invalid_cursor",
      `accepted malformed cursor value ${JSON.stringify(value)}`,
    );
  }
});

const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function trailingBitAlias(value: string): string | null {
  const unusedBits = value.length % 4 === 2
    ? 4
    : value.length % 4 === 3
    ? 2
    : 0;
  if (unusedBits === 0) return null;
  const last = base64UrlAlphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${base64UrlAlphabet[last | 1]}`;
}

function decodeBase64Url(value: string): Uint8Array {
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}
