import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  findPostgresBins,
  startManagedPostgres,
  stopManagedPostgres,
} from "../postgres/app-managed-postgres-spike.ts";
import {
  cancelDelivery,
  claimOne,
  enqueueDelivery,
  type ExecutionContext,
  fullJitterBackoffMs,
  installOutboxPrototypeSchema,
  pollUntilIdle,
  processNext,
  registerPinnedHook,
  retryDeadLetter,
  type Sql,
  uuidV7,
} from "./outbox_delivery.ts";

Deno.test({
  name: "real Postgres proves durable at-least-once outbox contract",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!await findPostgresBins()) {
      console.warn(
        "SKIP outbox-delivery prototype: run in nix-shell for real Postgres",
      );
      return;
    }
    const root = await Deno.makeTempDir({ prefix: "operant-outbox-contract-" });
    const pg = await startManagedPostgres(root);
    const clients: Sql[] = [];
    const nextClient = () => {
      const sql = postgres(pg.databaseUrl, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 5,
      });
      clients.push(sql);
      return sql;
    };
    const admin = nextClient();
    try {
      await installOutboxPrototypeSchema(admin);
      assert(/^.{14}7/.test(uuidV7()), "generated identity is UUIDv7");
      assertEquals(fullJitterBackoffMs(1, () => 0.5), 2_500);
      assertEquals(
        fullJitterBackoffMs(20, () => 0.999, 5_000, 3_600_000),
        3_596_400,
      );

      await concurrentClaimsRunOnce(admin, nextClient);
      await expiredLeaseIsReclaimed(admin, nextClient);
      await stableIdempotencySurvivesAmbiguousFailure(admin, nextClient);
      await structuredOutcomesAndPermanentFailures(admin, nextClient);
      await cancellationHasOneWinner(admin, nextClient);
      await manualRetryPreservesHistory(admin, nextClient);
      await pinnedOldRevisionUsesCurrentSecretVersion(admin, nextClient);
      await pollingLoopProcessesWithoutNotify(admin, nextClient);
      await noOrderingGuaranteeIsReal(admin, nextClient);
    } finally {
      await Promise.all(
        clients.map((sql) => sql.end({ timeout: 2 }).catch(() => undefined)),
      );
      await stopManagedPostgres(pg).catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

async function concurrentClaimsRunOnce(admin: Sql, nextClient: () => Sql) {
  const hook = await setupHook(admin, "claim");
  const { deliveryId } = await enqueue(admin, hook);
  const entered = deferred();
  const release = deferred();
  let executions = 0;
  const executor = async () => {
    executions++;
    entered.resolve();
    await release.promise;
    return { outcome: "succeeded" as const };
  };
  const first = processNext(nextClient(), "server-loop-a", executor);
  await entered.promise;
  const second = await processNext(nextClient(), "server-loop-b", executor);
  assertEquals(second.status, "idle");
  release.resolve();
  assertEquals((await first).status, "succeeded");
  assertEquals(executions, 1);
  assertEquals((await delivery(admin, deliveryId)).status, "succeeded");
}

async function expiredLeaseIsReclaimed(admin: Sql, nextClient: () => Sql) {
  const hook = await setupHook(admin, "lease");
  const start = new Date("2026-07-14T00:00:00Z");
  const { deliveryId } = await enqueue(admin, hook, { now: start });
  const crashed = await claimOne(nextClient(), "crashed-server", start, 1_000);
  assert(crashed);
  const recoveredAt = new Date(start.getTime() + 1_001);
  const result = await processNext(
    nextClient(),
    "restarted-server",
    () => Promise.resolve({ outcome: "succeeded" }),
    { now: recoveredAt, leaseMs: 1_000 },
  );
  assertEquals(result.status, "succeeded");
  const attempts = await admin.unsafe(
    "select outcome from proto_attempts where delivery_id=$1 order by total_attempt_number",
    [deliveryId],
  );
  assertEquals(attempts.map((row) => row.outcome), [
    "lease_expired",
    "succeeded",
  ]);
  assertEquals((await delivery(admin, deliveryId)).total_attempts, 2);
}

async function stableIdempotencySurvivesAmbiguousFailure(
  admin: Sql,
  nextClient: () => Sql,
) {
  const hook = await setupHook(admin, "idempotency");
  const base = new Date("2026-07-14T01:00:00Z");
  const { deliveryId } = await enqueue(admin, hook, { now: base });
  const provider = fakeIdempotentProvider();
  try {
    let first = true;
    const executor = async (context: ExecutionContext) => {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: { "Idempotency-Key": context.idempotency_key },
        body: JSON.stringify({ event_id: context.event_id }),
      });
      assertEquals(response.status, 200);
      if (first) {
        first = false;
        return {
          outcome: "retry" as const,
          code: "result_not_recorded",
          message: "simulated crash after provider accepted effect",
          retry_after_ms: 1,
        };
      }
      return { outcome: "succeeded" as const };
    };
    assertEquals(
      (await processNext(nextClient(), "loop", executor, { now: base })).status,
      "retry_wait",
    );
    assertEquals(
      (await processNext(nextClient(), "loop", executor, {
        now: new Date(base.getTime() + 2),
      })).status,
      "succeeded",
    );
    assertEquals(provider.requestCount(), 2);
    assertEquals(provider.effectCount(), 1);
    assertEquals(provider.keys(), [deliveryId, deliveryId]);
  } finally {
    await provider.close();
  }
}

async function structuredOutcomesAndPermanentFailures(
  admin: Sql,
  nextClient: () => Sql,
) {
  const retryHook = await setupHook(admin, "outcomes");
  const start = new Date("2026-07-14T02:00:00Z");
  const retryDelivery = await enqueue(admin, retryHook, { now: start });
  const retry = await processNext(
    nextClient(),
    "loop",
    () =>
      Promise.resolve({
        outcome: "retry",
        code: "provider_busy",
        message: "try later",
        retry_after_ms: 30_000,
      }),
    { now: start, random: () => 0 },
  );
  assertEquals(retry.status, "retry_wait");
  assertEquals(
    new Date((await delivery(admin, retryDelivery.deliveryId)).available_at)
      .toISOString(),
    new Date(start.getTime() + 30_000).toISOString(),
  );
  assertEquals(
    await cancelDelivery(admin, retryDelivery.deliveryId, start),
    "cancelled",
  );

  const permanentDelivery = await enqueue(admin, retryHook, {
    now: new Date(start.getTime() + 1),
  });
  assertEquals(
    (await processNext(
      nextClient(),
      "loop",
      () =>
        Promise.resolve({
          outcome: "dead_letter",
          code: "invalid_destination",
          message: "provider rejected destination",
        }),
      { now: new Date(start.getTime() + 1) },
    )).status,
    "dead_letter",
  );
  assertEquals(
    (await delivery(admin, permanentDelivery.deliveryId)).total_attempts,
    1,
  );

  const disabledHook = await setupHook(admin, "disabled", { enabled: false });
  const disabledDelivery = await enqueue(admin, disabledHook);
  let ran = false;
  const disabled = await processNext(nextClient(), "loop", () => {
    ran = true;
    return Promise.resolve({ outcome: "succeeded" });
  });
  assertEquals(disabled.status, "dead_letter");
  assertEquals(ran, false);
  assertEquals(
    (await delivery(admin, disabledDelivery.deliveryId)).last_error_code,
    "pinned_hook_disabled",
  );
}

async function cancellationHasOneWinner(admin: Sql, nextClient: () => Sql) {
  const hook = await setupHook(admin, "cancel");
  const pending = await enqueue(admin, hook);
  assertEquals(await cancelDelivery(admin, pending.deliveryId), "cancelled");

  const running = await enqueue(admin, hook);
  assert(await claimOne(nextClient(), "loop"));
  assertEquals(
    await cancelDelivery(admin, running.deliveryId),
    "delivery_in_progress",
  );
}

async function manualRetryPreservesHistory(admin: Sql, nextClient: () => Sql) {
  const hook = await setupHook(admin, "manual");
  const firstAt = new Date("2026-07-14T03:00:00Z");
  const { deliveryId } = await enqueue(admin, hook, {
    now: firstAt,
    maxAttempts: 1,
  });
  assertEquals(
    (await processNext(
      nextClient(),
      "loop",
      () =>
        Promise.resolve({
          outcome: "retry",
          code: "timeout",
          message: "timeout",
        }),
      { now: firstAt },
    )).status,
    "dead_letter",
  );
  assertEquals(
    await retryDeadLetter(admin, deliveryId, new Date(firstAt.getTime() + 1)),
    "pending",
  );
  assertEquals(
    (await processNext(
      nextClient(),
      "loop",
      (context) => {
        assertEquals(context.idempotency_key, deliveryId);
        assertEquals(context.retry_generation, 1);
        assertEquals(context.attempt_number, 1);
        return Promise.resolve({ outcome: "succeeded" });
      },
      { now: new Date(firstAt.getTime() + 2) },
    )).status,
    "succeeded",
  );
  const row = await delivery(admin, deliveryId);
  assertEquals(row.total_attempts, 2);
  assertEquals(row.attempts_in_generation, 1);
  assertEquals(row.retry_generation, 1);
  const attempts = await admin.unsafe(
    "select retry_generation,attempt_number,idempotency_key from proto_attempts where delivery_id=$1 order by total_attempt_number",
    [deliveryId],
  );
  assertEquals(attempts.length, 2);
  assertEquals(attempts[0].idempotency_key, attempts[1].idempotency_key);
}

async function pinnedOldRevisionUsesCurrentSecretVersion(
  admin: Sql,
  nextClient: () => Sql,
) {
  const old = await setupHook(admin, "upgrade-old", { revision: "upgrade-v1" });
  const { deliveryId } = await enqueue(admin, old);
  await setupHook(admin, "upgrade-new", {
    hookIdentity: old.hookIdentity,
    revision: "upgrade-v2",
  });
  await admin.unsafe(
    "update proto_pinned_hooks set secret_value_version=2 where revision=$1",
    [old.revision],
  );
  let seen: ExecutionContext | undefined;
  assertEquals(
    (await processNext(nextClient(), "loop", (context) => {
      seen = context;
      return Promise.resolve({ outcome: "succeeded" });
    })).status,
    "succeeded",
  );
  assertEquals(seen?.hook_revision, "upgrade-v1");
  assertEquals(seen?.secret_value_version, 2);
  assertEquals((await delivery(admin, deliveryId)).hook_revision, "upgrade-v1");
}

async function pollingLoopProcessesWithoutNotify(
  admin: Sql,
  nextClient: () => Sql,
) {
  const hook = await setupHook(admin, "poll");
  const controller = new AbortController();
  const loop = pollUntilIdle(
    nextClient(),
    "in-process-server-loop",
    () => Promise.resolve({ outcome: "succeeded" }),
    { signal: controller.signal, intervalMs: 10 },
  );
  const { deliveryId } = await enqueue(admin, hook);
  await waitFor(async () =>
    (await delivery(admin, deliveryId)).status === "succeeded"
  );
  controller.abort();
  await loop;
}

async function noOrderingGuaranteeIsReal(admin: Sql, nextClient: () => Sql) {
  const hook = await setupHook(admin, "unordered");
  const first = await enqueue(admin, hook, {
    now: new Date("2026-07-14T04:00:00.000Z"),
  });
  const second = await enqueue(admin, hook, {
    now: new Date("2026-07-14T04:00:00.001Z"),
  });
  const entered = deferred();
  const release = deferred();
  const firstProcess = processNext(nextClient(), "loop-a", async (context) => {
    if (context.delivery_id === first.deliveryId) {
      entered.resolve();
      await release.promise;
    }
    return { outcome: "succeeded" };
  });
  await entered.promise;
  assertEquals(
    (await processNext(
      nextClient(),
      "loop-b",
      () => Promise.resolve({ outcome: "succeeded" }),
    )).status,
    "succeeded",
  );
  assertEquals((await delivery(admin, second.deliveryId)).status, "succeeded");
  assertEquals((await delivery(admin, first.deliveryId)).status, "running");
  release.resolve();
  assertEquals((await firstProcess).status, "succeeded");
}

async function setupHook(
  sql: Sql,
  suffix: string,
  options: {
    hookIdentity?: string;
    revision?: string;
    enabled?: boolean;
  } = {},
) {
  const hookIdentity = options.hookIdentity ?? `optd/test:${suffix}`;
  const revision = options.revision ?? `${suffix}-${uuidV7()}`;
  const grantId = uuidV7();
  const value = {
    revision,
    hookIdentity,
    scriptDigest: `script-${suffix}`,
    securityDigest: `security-${suffix}`,
    grantId,
  };
  await registerPinnedHook(sql, { ...value, enabled: options.enabled });
  return value;
}

function enqueue(
  sql: Sql,
  hook: Awaited<ReturnType<typeof setupHook>>,
  options: { now?: Date; maxAttempts?: number } = {},
) {
  return enqueueDelivery(sql, {
    hookIdentity: hook.hookIdentity,
    hookRevision: hook.revision,
    scriptDigest: hook.scriptDigest,
    securityDigest: hook.securityDigest,
    grantId: hook.grantId,
    envelope: { event: { type: "object.updated" } },
    ...options,
  });
}

async function delivery(sql: Sql, id: string) {
  const rows = await sql.unsafe("select * from proto_deliveries where id=$1", [
    id,
  ]);
  return rows[0] as unknown as {
    available_at: string | Date;
    total_attempts: number;
    attempts_in_generation: number;
    retry_generation: number;
    status: string;
    last_error_code: string;
    hook_revision: string;
  };
}

function fakeIdempotentProvider() {
  const seen = new Set<string>();
  const keys: string[] = [];
  let effects = 0;
  const abort = new AbortController();
  let port = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: abort.signal,
    onListen: (address) => port = address.port,
  }, (request) => {
    const key = request.headers.get("Idempotency-Key") ?? "";
    keys.push(key);
    if (!seen.has(key)) {
      seen.add(key);
      effects++;
    }
    return Response.json({
      accepted: true,
      duplicate: keys.filter((value) => value === key).length > 1,
    });
  });
  return {
    get url() {
      return `http://127.0.0.1:${port}/effect`;
    },
    requestCount: () => keys.length,
    effectCount: () => effects,
    keys: () => keys,
    async close() {
      abort.abort();
      await server.finished.catch(() => undefined);
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function waitFor(predicate: () => Promise<boolean>) {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
}
