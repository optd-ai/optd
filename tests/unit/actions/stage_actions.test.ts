// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { validateActionInput } from "../../../src/application/services/actions/stage_actions.ts";

Deno.test("action input is strict and validates reviewed descriptors", () => {
  const fields = {
    id: { type: "string", required: true, format: "uuid" },
    count: { type: "integer", minimum: 1, maximum: 3 },
    mode: { type: "string", enum: ["safe", "fast"] },
  };
  const id = "019b7a2e-7c10-7000-8000-000000000001";
  assertEquals(
    validateActionInput({ id, count: 2, mode: "safe" }, fields),
    null,
  );
  assertEquals(
    validateActionInput({ id, extra: true }, fields),
    "Field 'extra' is not declared",
  );
  assertEquals(
    validateActionInput({ count: 2 }, fields),
    "Required field 'id' is missing",
  );
  assertEquals(
    validateActionInput({ id, count: 4 }, fields),
    "Field 'count' is above its maximum",
  );
  assertEquals(
    validateActionInput({ id, mode: "other" }, fields),
    "Field 'mode' is not an allowed value",
  );
});
