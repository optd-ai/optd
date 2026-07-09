import {
  ExpressionLoweringError,
  lowerCelToSql,
  parseWithBufCel,
} from "./cel-ast-sql-spike.ts";

Deno.test("@bufbuild/cel exposes a protobuf-shaped AST suitable for conservative SQL lowering", () => {
  const ast = parseWithBufCel('status == "new" && active()') as any;
  if (ast.expr.exprKind.case !== "callExpr") {
    throw new Error("expected call AST root");
  }
  if (ast.expr.exprKind.value.function !== "_&&_") {
    throw new Error("expected CEL && function");
  }
});

Deno.test("lowers supported query predicates to parameterized SQL", () => {
  const lowered = lowerCelToSql('status == "new" && active()');
  if (lowered.sql !== '(("status" = $1) and ("archived_at" is null))') {
    throw new Error(`unexpected SQL ${lowered.sql}`);
  }
  if (JSON.stringify(lowered.params) !== JSON.stringify(["new"])) {
    throw new Error(`unexpected params ${JSON.stringify(lowered.params)}`);
  }
});

Deno.test("lowers presence comparisons and list membership", () => {
  const lowered = lowerCelToSql(
    'present(email) && score >= 10 && status in ["new", "qualified"]',
  );
  if (!lowered.sql.includes('"email" is not null')) {
    throw new Error(lowered.sql);
  }
  if (!lowered.sql.includes('"score" >= $1')) throw new Error(lowered.sql);
  if (!lowered.sql.includes('"status" = any($2)')) throw new Error(lowered.sql);
  if (
    JSON.stringify(lowered.params) !==
      JSON.stringify([10, ["new", "qualified"]])
  ) throw new Error(`unexpected params ${JSON.stringify(lowered.params)}`);
});

Deno.test("binds actor selectors as SQL parameters for policy lowering", () => {
  const lowered = lowerCelToSql(
    "owner_id == actor.id || sales_team_id in actor.sales_team_ids",
  );
  if (!lowered.sql.includes('"owner_id" = $1')) throw new Error(lowered.sql);
  if (!lowered.sql.includes('"sales_team_id" = any($2)')) {
    throw new Error(lowered.sql);
  }
  if (
    JSON.stringify(lowered.params) !== JSON.stringify(["actor_1", ["direct"]])
  ) throw new Error(JSON.stringify(lowered.params));
});

Deno.test("supports self field alias null semantics and unary not", () => {
  const self = lowerCelToSql(
    'self.status == "new" && email != null && !(archived())',
  );
  if (!self.sql.includes('"status" = $1')) throw new Error(self.sql);
  if (!self.sql.includes('"email" is not null')) throw new Error(self.sql);
  if (!self.sql.includes('not ("archived_at" is not null)')) {
    throw new Error(self.sql);
  }

  const nullEq = lowerCelToSql("email == null");
  if (nullEq.sql !== '("email" is null)') throw new Error(nullEq.sql);
});

Deno.test("supports has alias boolean fields and nested parenthesized logic", () => {
  const lowered = lowerCelToSql(
    "(has(email) || contacted == true) && score < 100",
  );
  if (!lowered.sql.includes('"email" is not null')) {
    throw new Error(lowered.sql);
  }
  if (!lowered.sql.includes('"contacted" = $1')) throw new Error(lowered.sql);
  if (!lowered.sql.includes('"score" < $2')) throw new Error(lowered.sql);
  if (JSON.stringify(lowered.params) !== JSON.stringify([true, 100])) {
    throw new Error(JSON.stringify(lowered.params));
  }
});

Deno.test("parameterizes malicious string literals instead of interpolating SQL", () => {
  const lowered = lowerCelToSql('email == "x\'; drop table res_lead; --"');
  if (lowered.sql !== '("email" = $1)') throw new Error(lowered.sql);
  if (lowered.params[0] !== "x'; drop table res_lead; --") {
    throw new Error(JSON.stringify(lowered.params));
  }
});

Deno.test("rejects unknown fields unsupported functions arithmetic and non-boolean roots", () => {
  expectError("secret_field == true", "unknown_field");
  expectError("matches(email, '.*')", "unsupported_function");
  expectError("score + 1 > 2", "unsupported_function");
  expectError("status", "non_boolean_root");
});

Deno.test("rejects type mismatches heterogeneous lists bad actor fields and complex expressions", () => {
  expectError("status > 5", "type_mismatch");
  expectError('status in ["new", 1]', "type_mismatch");
  expectError("owner_id == actor.missing", "unknown_actor_field");
  expectError("present(actor.id)", "invalid_argument");
  expectError('status == "new"', "expression_too_complex", { maxNodes: 1 });
});

function expectError(expression: string, code: string, options?: any) {
  try {
    lowerCelToSql(
      expression,
      options ? { ...defaultContextForTest(), ...options } : undefined,
    );
    throw new Error(`expected ${code} for ${expression}`);
  } catch (error) {
    if (!(error instanceof ExpressionLoweringError)) throw error;
    if (error.code !== code) {
      throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
    }
  }
}

function defaultContextForTest() {
  return {
    fields: {
      id: { type: "string" as const },
      status: { type: "string" as const },
      stage: { type: "string" as const },
      email: { type: "string" as const, nullable: true },
      score: { type: "integer" as const, nullable: true },
      owner_id: { type: "string" as const, nullable: true },
      sales_team_id: { type: "string" as const, nullable: true },
      archived_at: { type: "timestamp" as const, nullable: true },
      contacted: { type: "boolean" as const, nullable: true },
    },
    actor: {
      id: { type: "string" as const, value: "actor_1" },
      sales_team_ids: {
        type: "string" as const,
        array: true,
        value: ["direct"],
      },
    },
    allowSelfAlias: true,
    maxNodes: 80,
    maxLength: 1000,
  };
}
