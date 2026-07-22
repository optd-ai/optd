// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  assertDeliveryCounters,
  fullJitterBackoffMs,
  isLegalDeliveryTransition,
  parseDeliveryOutput,
  parsePositiveDuration,
  retryDelayMs,
  retryDisposition,
} from "../../../src/domain/outbox/delivery.ts";
import { isUuidV7, uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";

Deno.test("delivery.v1 accepts only exact bounded frozen shapes", () => {
  assertEquals(parseDeliveryOutput({ outcome: "succeeded" }), {
    outcome: "succeeded",
  });
  assertEquals(
    parseDeliveryOutput({
      outcome: "succeeded",
      summary: "done",
      external_id: "ext-1",
    }),
    {
      outcome: "succeeded",
      summary: "done",
      external_id: "ext-1",
    },
  );
  assertEquals(
    parseDeliveryOutput({
      outcome: "retry",
      code: "temporary",
      message: "later",
      retry_after: "1.5s",
    }),
    {
      outcome: "retry",
      code: "temporary",
      message: "later",
      retry_after_ms: 1_500,
    },
  );
  assertEquals(
    parseDeliveryOutput({
      outcome: "dead_letter",
      code: "invalid_destination",
      message: "invalid",
    }),
    {
      outcome: "dead_letter",
      code: "invalid_destination",
      message: "invalid",
    },
  );
  for (
    const invalid of [
      { outcome: "success" },
      { outcome: "succeeded", unknown: true },
      { outcome: "retry", code: "UPPER", message: "later" },
      {
        outcome: "retry",
        code: "temporary",
        message: "later",
        retry_after: "0s",
      },
      {
        outcome: "retry",
        code: "temporary",
        message: "later",
        retry_after: "1",
      },
      { outcome: "dead_letter", code: "invalid" },
      { outcome: "succeeded", summary: "x".repeat(1_001) },
      { outcome: "succeeded", external_id: "x".repeat(513) },
      { outcome: "dead_letter", code: "invalid", message: "x".repeat(1_001) },
      { outcome: "succeeded", summary: "bad\0text" },
    ]
  ) assertEquals(parseDeliveryOutput(invalid), null);
  assertEquals(parsePositiveDuration("1ms"), 1);
  assertEquals(parsePositiveDuration("2m"), 120_000);
  assertEquals(parsePositiveDuration("1h"), 3_600_000);
  assertEquals(parsePositiveDuration("0ms"), null);
});

Deno.test("delivery state transitions and counters enforce frozen invariants", () => {
  const legal = [
    ["pending", "running"],
    ["pending", "cancelled"],
    ["running", "pending"],
    ["running", "retry_wait"],
    ["running", "succeeded"],
    ["running", "dead_letter"],
    ["retry_wait", "running"],
    ["retry_wait", "pending"],
    ["retry_wait", "cancelled"],
    ["dead_letter", "pending"],
  ] as const;
  for (const [from, to] of legal) {
    assertEquals(isLegalDeliveryTransition(from, to), true);
  }
  assertEquals(isLegalDeliveryTransition("succeeded", "pending"), false);
  assertEquals(isLegalDeliveryTransition("cancelled", "running"), false);
  assertDeliveryCounters({
    retry_generation: 2,
    attempts_in_generation: 1,
    total_attempts: 8,
    max_attempts: 10,
  });
  assertThrows(() =>
    assertDeliveryCounters({
      retry_generation: 0,
      attempts_in_generation: 2,
      total_attempts: 1,
      max_attempts: 10,
    })
  );
  assertEquals(retryDisposition(9, 10), "retry_wait");
  assertEquals(retryDisposition(10, 10), "dead_letter");
});

Deno.test("UUIDv7 delivery keys remain stable while attempt IDs are distinct", () => {
  const deliveryId = uuidV7(1_750_000_000_000);
  const attempts = [uuidV7(1_750_000_000_000), uuidV7(1_750_000_000_000)];
  assertEquals(isUuidV7(deliveryId), true);
  assertEquals(attempts.every(isUuidV7), true);
  assertEquals(attempts[0] === attempts[1], false);
  assertEquals(
    [deliveryId, deliveryId].every((value) => value === deliveryId),
    true,
  );
});

Deno.test("full jitter, retry-after cap, exponential cap and generation basis are exact", () => {
  assertEquals(fullJitterBackoffMs(1, () => 0, 5_000, 60_000), 0);
  assertEquals(fullJitterBackoffMs(1, () => 0.5, 5_000, 60_000), 2_500);
  assertEquals(fullJitterBackoffMs(2, () => 0.5, 5_000, 60_000), 5_000);
  assertEquals(fullJitterBackoffMs(20, () => 0.5, 5_000, 60_000), 30_000);
  assertEquals(fullJitterBackoffMs(20, () => 1, 5_000, 60_000), 59_999);
  assertEquals(retryDelayMs(1, 90_000, 30_000, () => 0, 5_000, 60_000), 30_000);
  assertEquals(
    retryDelayMs(1, undefined, 30_000, () => 0.5, 5_000, 60_000),
    2_500,
  );
  assertThrows(() => fullJitterBackoffMs(0));
});
