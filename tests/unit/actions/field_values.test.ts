// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  compareDecimal,
  validateFieldValue,
} from "../../../src/schemas/changesets/field_values.ts";

Deno.test("canonical field validator covers exact scalar boundaries without IEEE decimal coercion", () => {
  const valid = (value: unknown, field: Record<string, unknown>) =>
    assertEquals(validateFieldValue("x", value, field), null);
  const invalid = (value: unknown, field: Record<string, unknown>) =>
    assertEquals(validateFieldValue("x", value, field) !== null, true);
  valid("é", { type: "string", minLength: 1, maxLength: 1 });
  invalid("ab", { type: "string", maxLength: 1 });
  valid("a@example.test", { type: "string", format: "email" });
  invalid("a@bad", { type: "string", format: "email" });
  valid("https://example.test/a", { type: "string", format: "uri" });
  invalid("not a uri", { type: "string", format: "uri" });
  valid("019b7a2e-7c10-7000-8000-000000000001", {
    type: "string",
    format: "uuid",
  });
  invalid("019B7A2E-7C10-7000-8000-000000000001", {
    type: "string",
    format: "uuid",
  });
  valid(Number.MAX_SAFE_INTEGER, { type: "integer", minimum: 0 });
  invalid(Number.MAX_SAFE_INTEGER + 1, { type: "integer" });
  valid("999999999999999999999999999999.99", {
    type: "decimal",
    precision: 32,
    scale: 2,
    minimum: "1",
    maximum: "1000000000000000000000000000000",
  });
  invalid("1000000000000000000000000000000.01", {
    type: "decimal",
    maximum: "1000000000000000000000000000000",
  });
  invalid("1.230", { type: "decimal" });
  invalid("-0", { type: "decimal" });
  assertEquals(
    compareDecimal("999999999999999999999999", "1000000000000000000000000"),
    -1,
  );
  assertEquals(compareDecimal("-10.1", "-10.01"), -1);
  valid(true, { type: "boolean" });
  invalid(1, { type: "boolean" });
  valid("2024-02-29", { type: "date" });
  invalid("2023-02-29", { type: "date" });
  valid("2024-01-01T00:00:00Z", { type: "timestamp" });
  invalid("2024-01-01T00:00:00+00:00", { type: "timestamp" });
});
