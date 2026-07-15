import { assertEquals } from "jsr:@std/assert";
import { startHttpProvider } from "../../support/http_provider.ts";

Deno.test("HTTP provider simulates delay, retry, permanent failure, and duplicate attempts", async () => {
  const provider = startHttpProvider([
    { kind: "delay", delayMs: 5, body: { delayed: true } },
    { kind: "retry", retryAfterSeconds: 3 },
    { kind: "permanent_failure" },
    { kind: "success" },
  ]);
  try {
    const headers = { "idempotency-key": "delivery-1" };
    const delayed = await fetch(provider.url, {
      method: "POST",
      headers,
      body: "one",
    });
    assertEquals(delayed.status, 200);
    await delayed.body?.cancel();
    const retry = await fetch(provider.url, {
      method: "POST",
      headers,
      body: "two",
    });
    assertEquals(retry.status, 503);
    assertEquals(retry.headers.get("retry-after"), "3");
    await retry.body?.cancel();
    const permanent = await fetch(provider.url, {
      method: "POST",
      body: "three",
    });
    assertEquals(permanent.status, 422);
    await permanent.body?.cancel();
    const duplicate = await fetch(provider.url, {
      method: "POST",
      headers,
      body: "four",
    });
    assertEquals(duplicate.status, 200);
    await duplicate.body?.cancel();

    const attempts = await provider.waitForAttempts(4);
    assertEquals(attempts.map((attempt) => attempt.duplicate), [
      false,
      true,
      false,
      true,
    ]);
    assertEquals(provider.effects.length, 1);
    assertEquals(provider.effects[0].body, "one");
  } finally {
    await provider.close();
  }
});

Deno.test("HTTP provider cancels delayed responses during cleanup", async () => {
  const provider = startHttpProvider([{ kind: "delay", delayMs: 60_000 }]);
  const request = fetch(provider.url).catch(() => undefined);
  await provider.waitForAttempts(1);
  await provider.close();
  await request;
});
