import { assertEquals, assertRejects } from "jsr:@std/assert";
import { QueryCursorSigner } from "../../src/domain/queries/cursor.ts";

Deno.test("query cursor HMAC binds query and current policy context", async () => {
  const signer = new QueryCursorSigner("test master key material");
  const cursor = await signer.encode("sha256:shape", "sha256:policy", {
    values: [null, "2026-01-01T00:00:00Z"],
    id: "019b7a2e-7c10-7000-8000-000000000001",
  });
  assertEquals(await signer.decode(cursor, "sha256:shape", "sha256:policy"), {
    values: [null, "2026-01-01T00:00:00Z"],
    id: "019b7a2e-7c10-7000-8000-000000000001",
  });
  await assertRejects(() =>
    signer.decode(cursor, "sha256:other", "sha256:policy")
  );
  await assertRejects(() =>
    signer.decode(cursor, "sha256:shape", "sha256:revoked")
  );
  await assertRejects(() =>
    signer.decode(`${cursor.slice(0, -1)}A`, "sha256:shape", "sha256:policy")
  );
});
