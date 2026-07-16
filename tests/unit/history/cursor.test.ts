import { assertEquals, assertRejects } from "jsr:@std/assert";
import { HistoryCursorSigner } from "../../../src/domain/history/cursor.ts";

const position = {
  createdAt: "2026-07-16T12:00:00.000Z",
  id: "019a0000-0000-7000-8000-000000000001",
};
const binding = {
  v: 1,
  project_id: "019a0000-0000-7000-8000-000000000002",
  limit: 1,
};

Deno.test("history cursors require the stable server key and reject forgery", async () => {
  const signer = new HistoryCursorSigner("stable-master-key");
  const cursor = await signer.encode(binding, position);
  assertEquals(await signer.decode(cursor, binding), position);
  await assertRejects(() =>
    new HistoryCursorSigner("wrong-key").decode(cursor, binding)
  );
  await assertRejects(() => signer.decode(cursor, { ...binding, limit: 2 }));

  const raw = atob(
    cursor.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((cursor.length + 3) % 4),
  );
  const bytes = Uint8Array.from(raw, (value) => value.charCodeAt(0));
  const payload = JSON.parse(new TextDecoder().decode(bytes.slice(32)));
  payload.created_at = "2020-01-01T00:00:00.000Z";
  const forgedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const forged = new Uint8Array(32 + forgedPayload.length);
  forged.set(bytes.slice(0, 32));
  forged.set(forgedPayload, 32);
  const encoded = btoa(String.fromCharCode(...forged)).replaceAll("+", "-")
    .replaceAll("/", "_").replaceAll("=", "");
  await assertRejects(() => signer.decode(encoded, binding));
});

Deno.test("history cursor key configuration has no fallback", () => {
  assertRejects(async () => new HistoryCursorSigner(" "));
});
