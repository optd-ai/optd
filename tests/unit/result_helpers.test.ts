import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  err,
  ok,
  toHttpStatus,
  unwrapOrThrow,
  validationError,
} from "../../src/domain/errors/result.ts";

Deno.test("stable result helpers preserve success values", () => {
  const result = ok({ id: "obj_1" });
  assertEquals(result.ok, true);
  assertEquals(unwrapOrThrow(result).id, "obj_1");
});

Deno.test("stable error helpers map to deterministic HTTP statuses", () => {
  const error = validationError("bad_input", "Bad input", { field: "name" });
  const result = err(error);
  assertEquals(result.ok, false);
  assertEquals(result.error.code, "bad_input");
  assertEquals(toHttpStatus(error), 400);
  assertThrows(() => unwrapOrThrow(result), Error, "bad_input: Bad input");
});
