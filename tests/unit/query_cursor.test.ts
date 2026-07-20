import { assertEquals, assertRejects } from "jsr:@std/assert";
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
