// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import { OutboxCursorSigner } from "../../../src/domain/outbox/cursor.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";

Deno.test("outbox cursor is canonical, HMAC authenticated, and filter bound", async () => {
  const signer = new OutboxCursorSigner("test-master-key");
  const position = { created_at: "2026-07-21T12:00:00.000Z", id: uuidV7() };
  const left = await signer.encode(position, {
    status: "dead_letter",
    hook: undefined,
  });
  const right = await signer.encode(position, {
    hook: undefined,
    status: "dead_letter",
  });
  assertEquals(left, right);
  assertEquals(await signer.decode(left, { status: "dead_letter" }), position);
  await assertRejects(() => signer.decode(left, { status: "succeeded" }));
  const changed = `${left.slice(0, -1)}${left.endsWith("A") ? "B" : "A"}`;
  await assertRejects(() => signer.decode(changed, { status: "dead_letter" }));
  await assertRejects(() =>
    signer.decode(`${left}=`, { status: "dead_letter" })
  );
});

Deno.test("attempt cursors bind the canonical position to one delivery", async () => {
  const signer = new OutboxCursorSigner("attempt-cursor-key");
  const delivery = uuidV7();
  const cursor = await signer.encodeAttempt(delivery, 3);
  assertEquals(await signer.decodeAttempt(cursor, delivery), 3);
  await assertRejects(
    () => signer.decodeAttempt(cursor, uuidV7()),
    Error,
    "mismatch",
  );
});

Deno.test("outbox cursor requires deployment key and UUIDv7 position", async () => {
  assertThrows(() => new OutboxCursorSigner(""));
  const signer = new OutboxCursorSigner("test-master-key");
  const cursor = await signer.encode({
    created_at: "2026-07-21T12:00:00.000Z",
    id: "not-an-id",
  }, {});
  await assertRejects(() => signer.decode(cursor, {}));
});
