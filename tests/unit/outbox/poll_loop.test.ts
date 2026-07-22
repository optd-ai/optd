// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { startOutboxPollLoop } from "../../../src/application/services/outbox/poll_loop.ts";

Deno.test("idle poll abort clears its timer and makes no later claim", async () => {
  let calls = 0;
  const loop = startOutboxPollLoop(() => {
    calls++;
    return Promise.resolve({ claimed: 0 });
  }, { intervalMs: 60_000, shutdownGraceMs: 10 });
  await Promise.resolve();
  await loop.stop();
  assertEquals(calls, 1);
  assertEquals(loop.signal.aborted, true);
});

Deno.test("busy poll abort does not claim after the current batch", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const loop = startOutboxPollLoop(async () => {
    calls++;
    entered.resolve();
    await release.promise;
    return { claimed: 1 };
  }, { intervalMs: 60_000, shutdownGraceMs: 1 });
  await entered.promise;
  const stopping = loop.stop();
  await Promise.resolve();
  release.resolve();
  await stopping;
  assertEquals(calls, 1);
});

Deno.test("grace expiry never closes dependencies before the current batch settles", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const loop = startOutboxPollLoop(async () => {
    entered.resolve();
    await release.promise;
    return { claimed: 1 };
  }, { intervalMs: 60_000, shutdownGraceMs: 0 });
  await entered.promise;
  let stopped = false;
  const stopping = loop.stop().then(() => stopped = true);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assertEquals(stopped, false);
  release.resolve();
  await stopping;
  assertEquals(stopped, true);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
