import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  ExpressionLoweringError,
  lowerCelToSql,
} from "../../src/domain/queries/expression_lowerer.ts";

const context = {
  fields: {
    id: { type: "string" as const },
    status: { type: "string" as const },
    email: { type: "string" as const, nullable: true },
    score: { type: "integer" as const, nullable: true },
    archived_at: { type: "timestamp" as const, nullable: true },
    contacted: { type: "boolean" as const, nullable: true },
  },
  actor: { id: { type: "string" as const, value: "actor_1" } },
  allowSelfAlias: true,
  maxNodes: 80,
  maxLength: 1000,
};

Deno.test("CEL lowerer parameterizes filters and archive helpers", () => {
  const lowered = lowerCelToSql(
    'status == "new" && active() && email == "x\'; drop table res_lead; --"',
    context,
  );
  assertStringIncludes(lowered.sql, '"status" = $1');
  assertStringIncludes(lowered.sql, '"archived_at" is null');
  assertStringIncludes(lowered.sql, '"email" = $2');
  assertEquals(lowered.params, ["new", "x'; drop table res_lead; --"]);
});

Deno.test("CEL lowerer rejects unsupported and unsafe expressions", () => {
  expectCode("matches(email, '.*')", "unsupported_function");
  expectCode("secret_field == true", "unknown_field");
  expectCode("status > 5", "type_mismatch");
  expectCode("status", "non_boolean_root");
  expectCode('status == "new"', "expression_too_complex", {
    ...context,
    maxNodes: 1,
  });
});

function expectCode(expression: string, code: string, ctx = context) {
  try {
    lowerCelToSql(expression, ctx);
    throw new Error(`expected ${code}`);
  } catch (error) {
    if (!(error instanceof ExpressionLoweringError)) throw error;
    assertEquals(error.code, code);
  }
}
