import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert";
import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import {
  compileContract,
  errorEnvelope,
  strictObject,
  successEnvelope,
} from "../../../src/schemas/api/contracts.ts";
import {
  canonicalJson,
  canonicalSha256,
} from "../../../src/domain/ids/canonical_json.ts";
import {
  assertUuidV7,
  isUuidV7,
  uuidV7,
} from "../../../src/domain/ids/uuid_v7.ts";
import { toHttpStatus } from "../../../src/domain/errors/result.ts";

Deno.test("strict contracts reject unknown fields with sorted stable issues", () => {
  const schema = strictObject({ name: Type.String(), count: Type.Integer() });
  type Value = Static<typeof schema>;
  const validator = compileContract<Value>(schema);
  assert(validator.check({ name: "ok", count: 1 }));
  assertEquals(validator.issues({ extra: true }), [
    { path: "/", code: "unknown_field", message: "unknown field" },
    {
      path: "/count",
      code: "required",
      message: "must have required property 'count'",
    },
    {
      path: "/name",
      code: "required",
      message: "must have required property 'name'",
    },
  ]);
});

Deno.test("API envelopes generate non-overridable UUIDv7 request ids and safe details", () => {
  const success = successEnvelope({ value: 1 }, { request_id: "caller" });
  const failure = errorEnvelope({
    code: "bad_request",
    message: "bad",
    details: "unsafe",
  }, { request_id: "caller" });
  assert(isUuidV7(success.meta.request_id));
  assert(isUuidV7(failure.meta.request_id));
  assertEquals(success.meta.request_id === "caller", false);
  assertEquals(failure.meta.request_id === "caller", false);
  assertEquals(failure.error.details, {});
});

Deno.test("UUIDv7 is valid and monotonic for a shared timestamp", () => {
  const values = Array.from({ length: 16 }, () => uuidV7(1_700_000_000_000));
  assert(values.every(isUuidV7));
  assertEquals([...values].sort(), values);
  assertThrows(() => assertUuidV7(crypto.randomUUID()));
});

Deno.test("canonical JSON sorts UTF-16 keys, rejects non-I-JSON, and hashes deterministically", async () => {
  assertEquals(
    canonicalJson({
      z: 1,
      a: [true, null, "x"],
      nested: { b: 2, a: 1 },
      minus: -0,
    }),
    '{"a":[true,null,"x"],"minus":0,"nested":{"a":1,"b":2},"z":1}',
  );
  assertThrows(() => canonicalJson({ value: Number.NaN }));
  assertThrows(() => canonicalJson("\ud800"));
  assertRejects(async () => await canonicalSha256({ value: undefined }));
  assertEquals(
    await canonicalSha256({ b: 2, a: 1 }),
    await canonicalSha256({ a: 1, b: 2 }),
  );
});

Deno.test("stable errors use the central HTTP classification", () => {
  assertEquals(
    toHttpStatus({
      code: "validation_failed",
      message: "",
      severity: "validation",
    }),
    422,
  );
  assertEquals(
    toHttpStatus({
      code: "authentication_required",
      message: "",
      severity: "authentication",
    }),
    401,
  );
  assertEquals(
    toHttpStatus({ code: "unavailable", message: "", severity: "unavailable" }),
    503,
  );
});
