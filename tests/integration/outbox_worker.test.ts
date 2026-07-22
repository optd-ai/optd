// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertGreater } from "jsr:@std/assert";
import {
  fullJitterBackoffMs,
  parseDeliveryOutput,
} from "../../src/domain/outbox/delivery.ts";

Deno.test("delivery.v1 is strict and rejects the legacy success alias", () => {
  assertEquals(parseDeliveryOutput({ outcome: "success" }), null);
  assertEquals(parseDeliveryOutput({ outcome: "succeeded" }), {
    outcome: "succeeded",
  });
  assertEquals(
    parseDeliveryOutput({
      outcome: "retry",
      code: "provider_unavailable",
      message: "retry later",
      retry_after: "30s",
    }),
    {
      outcome: "retry",
      code: "provider_unavailable",
      message: "retry later",
      retry_after_ms: 30_000,
    },
  );
  assertEquals(
    parseDeliveryOutput({
      outcome: "dead_letter",
      code: "invalid_destination",
      message: "destination is invalid",
    }),
    {
      outcome: "dead_letter",
      code: "invalid_destination",
      message: "destination is invalid",
    },
  );
  assertEquals(
    parseDeliveryOutput({ outcome: "succeeded", extra: true }),
    null,
  );
  assertEquals(
    parseDeliveryOutput({
      outcome: "retry",
      code: "temporary",
      message: "later",
      retry_after: "0s",
    }),
    null,
  );
});

Deno.test("full jitter uses the generation attempt and never reaches its ceiling", () => {
  assertEquals(fullJitterBackoffMs(1, () => 0), 0);
  assertEquals(fullJitterBackoffMs(2, () => 0.5), 5_000);
  const capped = fullJitterBackoffMs(100, () => 1, 5_000, 60_000);
  assertGreater(capped, 59_000);
  assertEquals(capped < 60_000, true);
});
