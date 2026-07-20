import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  ExpressionLoweringError,
  lowerCelToSql,
} from "../../src/domain/queries/expression_lowerer.ts";

const context = {
  fields: {
    id: { type: "string" as const },
    status: { type: "string" as const },
    score: { type: "integer" as const },
    amount: { type: "decimal" as const },
    due: { type: "date" as const },
    at: { type: "timestamp" as const },
    archived_at: { type: "timestamp" as const, nullable: true },
  },
  maxNodes: 80,
  maxLength: 1000,
};
Deno.test("one CEL lowerer parameterizes and types the frozen subset", () => {
  const lowered = lowerCelToSql(
    'status == "x\';drop table lead;--" && amount >= 10 && due < "2027-01-01" && active()',
    context,
  );
  assertEquals(lowered.params, ["x';drop table lead;--", 10, "2027-01-01"]);
  assertStringIncludes(lowered.sql, '"amount" >= ($2)::numeric');
  assertStringIncludes(lowered.sql, "($3)::date");
});
Deno.test("CEL lowerer fails closed on forbidden forms", () => {
  for (
    const [source, code] of [
      ["null == null", "expression_unsupported"],
      ["amount > 1.2", "expression_unsupported"],
      ["status in []", "expression_array_empty"],
      ['status in ["x", 1]', "expression_array_heterogeneous"],
      ["actor.ids[0] == id", "expression_unsupported"],
      ['matches(status, "x")', "expression_unsupported"],
      ["status", "expression_type"],
      ["secret == true", "expression_unknown_symbol"],
    ]
  ) expect(source, code);
});
Deno.test("CEL syntax preserves safe location", () => {
  try {
    lowerCelToSql("status ==", context);
  } catch (error) {
    if (!(error instanceof ExpressionLoweringError)) throw error;
    assertEquals(error.code, "expression_syntax");
    assertEquals(error.details.line, 1);
  }
});
function expect(source: string, code: string) {
  try {
    lowerCelToSql(source, context);
    throw new Error("expected rejection");
  } catch (error) {
    if (!(error instanceof ExpressionLoweringError)) throw error;
    assertEquals(error.code, code);
  }
}
