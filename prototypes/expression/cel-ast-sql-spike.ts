import { parse } from "npm:@bufbuild/cel";

export type FieldType =
  | "string"
  | "integer"
  | "decimal"
  | "boolean"
  | "timestamp";
type ValueType = FieldType | "null" | "array";
type FieldSpec = { type: FieldType; nullable?: boolean };
type ActorSpec = { type: FieldType; array?: boolean; value: unknown };
export type SqlLowerContext = {
  fields: Record<string, FieldSpec>;
  actor?: Record<string, ActorSpec>;
  allowSelfAlias?: boolean;
  maxNodes?: number;
  maxLength?: number;
};
export type SqlLowerResult = { sql: string; params: unknown[] };
type LowerState = { params: unknown[]; nodes: number };
type Lowered = {
  sql: string;
  type: ValueType;
  isNull?: boolean;
  isArray?: boolean;
};

export class ExpressionLoweringError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const defaultContext: SqlLowerContext = {
  fields: {
    id: { type: "string" },
    status: { type: "string" },
    stage: { type: "string" },
    email: { type: "string", nullable: true },
    score: { type: "integer", nullable: true },
    owner_id: { type: "string", nullable: true },
    sales_team_id: { type: "string", nullable: true },
    archived_at: { type: "timestamp", nullable: true },
    contacted: { type: "boolean", nullable: true },
  },
  actor: {
    id: { type: "string", value: "actor_1" },
    roles: { type: "string", array: true, value: ["sales_rep"] },
    sales_team_ids: { type: "string", array: true, value: ["direct"] },
    company_ids: { type: "string", array: true, value: ["company_1"] },
  },
  allowSelfAlias: true,
  maxNodes: 80,
  maxLength: 1_000,
};

export function parseWithBufCel(expression: string) {
  return parse(expression);
}

export function lowerCelToSql(
  expression: string,
  context: SqlLowerContext = defaultContext,
): SqlLowerResult {
  if (expression.length > (context.maxLength ?? 1_000)) {
    throw new ExpressionLoweringError(
      "expression_too_long",
      "expression is too long",
      { maxLength: context.maxLength ?? 1_000 },
    );
  }
  let parsed: any;
  try {
    parsed = parseWithBufCel(expression);
  } catch (error) {
    throw new ExpressionLoweringError(
      "parse_error",
      error instanceof Error ? error.message : String(error),
    );
  }
  const state: LowerState = { params: [], nodes: 0 };
  const lowered = lowerExpr(parsed.expr, context, state);
  if (lowered.type !== "boolean") {
    throw new ExpressionLoweringError(
      "non_boolean_root",
      "expression must lower to a boolean predicate",
      { type: lowered.type },
    );
  }
  return { sql: lowered.sql, params: state.params };
}

function lowerExpr(
  expr: any,
  context: SqlLowerContext,
  state: LowerState,
): Lowered {
  state.nodes++;
  if (state.nodes > (context.maxNodes ?? 80)) {
    throw new ExpressionLoweringError(
      "expression_too_complex",
      "expression has too many AST nodes",
      { maxNodes: context.maxNodes ?? 80 },
    );
  }
  const kind = expr.exprKind;
  if (!kind) {
    throw new ExpressionLoweringError("invalid_ast", "missing exprKind");
  }
  if (kind.case === "identExpr") return lowerIdent(kind.value.name, context);
  if (kind.case === "selectExpr") {
    return lowerSelect(kind.value, context, state);
  }
  if (kind.case === "constExpr") return lowerConst(kind.value, state);
  if (kind.case === "listExpr") return lowerList(kind.value, state);
  if (kind.case === "callExpr") return lowerCall(kind.value, context, state);
  throw new ExpressionLoweringError(
    "unsupported_expression",
    `unsupported expression kind ${kind.case}`,
    { kind: kind.case },
  );
}

function lowerCall(
  call: any,
  context: SqlLowerContext,
  state: LowerState,
): Lowered {
  const args = call.args ?? [];
  const fn = call.function;
  if (["_&&_", "_||_"].includes(fn)) {
    assertArity(fn, args, 2);
    const left = requireBoolean(lowerExpr(args[0], context, state), fn);
    const right = requireBoolean(lowerExpr(args[1], context, state), fn);
    return {
      sql: `(${left.sql} ${fn === "_&&_" ? "and" : "or"} ${right.sql})`,
      type: "boolean",
    };
  }
  if (fn === "!_") {
    assertArity(fn, args, 1);
    const value = requireBoolean(lowerExpr(args[0], context, state), fn);
    return { sql: `(not ${value.sql})`, type: "boolean" };
  }
  if (["_==_", "_!=_", "_<_", "_<=_", "_>_", "_>=_"].includes(fn)) {
    assertArity(fn, args, 2);
    return lowerComparison(
      fn,
      lowerExpr(args[0], context, state),
      lowerExpr(args[1], context, state),
    );
  }
  if (fn === "_in_" || fn === "@in") {
    assertArity(fn, args, 2);
    const left = lowerExpr(args[0], context, state);
    const right = lowerExpr(args[1], context, state);
    if (!right.isArray) {
      throw new ExpressionLoweringError(
        "type_mismatch",
        "right side of in must be an array",
        { rightType: right.type },
      );
    }
    return { sql: `(${left.sql} = any(${right.sql}))`, type: "boolean" };
  }
  if (fn === "present" || fn === "has") {
    assertArity(fn, args, 1);
    const value = lowerFieldOnly(args[0], context, state, fn);
    return { sql: `(${value.sql} is not null)`, type: "boolean" };
  }
  if (fn === "missing") {
    assertArity(fn, args, 1);
    const value = lowerFieldOnly(args[0], context, state, fn);
    return { sql: `(${value.sql} is null)`, type: "boolean" };
  }
  if (fn === "active") {
    assertArity(fn, args, 0);
    requireField("archived_at", context);
    return { sql: `("archived_at" is null)`, type: "boolean" };
  }
  if (fn === "archived") {
    assertArity(fn, args, 0);
    requireField("archived_at", context);
    return { sql: `("archived_at" is not null)`, type: "boolean" };
  }
  throw new ExpressionLoweringError(
    "unsupported_function",
    `unsupported function ${fn}`,
    { function: fn },
  );
}

function lowerComparison(fn: string, left: Lowered, right: Lowered): Lowered {
  if (left.isNull || right.isNull) {
    if (fn !== "_==_" && fn !== "_!=_") {
      throw new ExpressionLoweringError(
        "type_mismatch",
        "null can only be compared with == or !=",
      );
    }
    const nonNull = left.isNull ? right : left;
    return {
      sql: `(${nonNull.sql} is ${fn === "_!=_" ? "not " : ""}null)`,
      type: "boolean",
    };
  }
  if (!compatible(left.type, right.type)) {
    throw new ExpressionLoweringError(
      "type_mismatch",
      `cannot compare ${left.type} with ${right.type}`,
      { left: left.type, right: right.type },
    );
  }
  if (
    ["_<_", "_<=_", "_>_", "_>=_"].includes(fn) &&
    [left.type, right.type].includes("boolean")
  ) {
    throw new ExpressionLoweringError(
      "type_mismatch",
      "ordered comparisons are not valid for booleans",
    );
  }
  const op = fn.slice(1, -1).replace("==", "=").replace("!=", "<>");
  return { sql: `(${left.sql} ${op} ${right.sql})`, type: "boolean" };
}

function lowerIdent(name: string, context: SqlLowerContext): Lowered {
  const field = requireField(name, context);
  return { sql: qi(name), type: field.type };
}

function lowerSelect(
  select: any,
  context: SqlLowerContext,
  state: LowerState,
): Lowered {
  const operand = select.operand;
  if (operand?.exprKind?.case === "identExpr") {
    const root = operand.exprKind.value.name;
    if (root === "self" && context.allowSelfAlias !== false) {
      return lowerIdent(select.field, context);
    }
    if (root === "actor") {
      const actor = context.actor?.[select.field];
      if (!actor) {
        throw new ExpressionLoweringError(
          "unknown_actor_field",
          `unknown actor field ${select.field}`,
          { field: select.field },
        );
      }
      state.params.push(actor.value);
      return {
        sql: `$${state.params.length}`,
        type: actor.array ? "array" : actor.type,
        isArray: Boolean(actor.array),
      };
    }
  }
  throw new ExpressionLoweringError(
    "unsupported_select",
    "only self.<field> and actor.<field> selects are supported",
  );
}

function lowerConst(value: any, state: LowerState): Lowered {
  const v = constantValue(value);
  if (v === null) return { sql: "null", type: "null", isNull: true };
  state.params.push(v);
  return { sql: `$${state.params.length}`, type: valueType(v) };
}

function lowerList(value: any, state: LowerState): Lowered {
  const items = (value.elements ?? []).map((expr: any) => {
    if (expr.exprKind?.case !== "constExpr") {
      throw new ExpressionLoweringError(
        "unsupported_list",
        "list literals may only contain constants",
      );
    }
    return constantValue(expr.exprKind.value);
  });
  const nonNullTypes = items.filter((item: unknown) => item !== null).map(
    valueType,
  );
  if (new Set(nonNullTypes).size > 1) {
    throw new ExpressionLoweringError(
      "type_mismatch",
      "list literals must be homogeneous",
      { types: nonNullTypes },
    );
  }
  state.params.push(items);
  return { sql: `$${state.params.length}`, type: "array", isArray: true };
}

function lowerFieldOnly(
  expr: any,
  context: SqlLowerContext,
  state: LowerState,
  fn: string,
): Lowered {
  const value = lowerExpr(expr, context, state);
  if (value.sql.startsWith("$")) {
    throw new ExpressionLoweringError(
      "invalid_argument",
      `${fn} expects a field reference`,
    );
  }
  return value;
}

function requireField(name: string, context: SqlLowerContext): FieldSpec {
  const field = context.fields[name];
  if (!field) {
    throw new ExpressionLoweringError(
      "unknown_field",
      `unknown field ${name}`,
      { field: name },
    );
  }
  return field;
}

function requireBoolean(value: Lowered, fn: string) {
  if (value.type !== "boolean") {
    throw new ExpressionLoweringError(
      "type_mismatch",
      `${fn} expects boolean operands`,
      { type: value.type },
    );
  }
  return value;
}

function constantValue(value: any): unknown {
  const kind = value.constantKind;
  if (kind.case === "stringValue") return kind.value;
  if (kind.case === "boolValue") return kind.value;
  if (kind.case === "int64Value" || kind.case === "uint64Value") {
    return Number(kind.value);
  }
  if (kind.case === "doubleValue") return kind.value;
  if (kind.case === "nullValue") return null;
  throw new ExpressionLoweringError(
    "unsupported_constant",
    `unsupported constant ${kind.case}`,
    { kind: kind.case },
  );
}

function valueType(value: unknown): FieldType {
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "decimal";
  }
  throw new ExpressionLoweringError(
    "unsupported_constant",
    `unsupported constant value ${String(value)}`,
  );
}

function compatible(left: ValueType, right: ValueType) {
  if (left === right) return true;
  return (left === "integer" && right === "decimal") ||
    (left === "decimal" && right === "integer");
}

function assertArity(fn: string, args: unknown[], expected: number) {
  if (args.length !== expected) {
    throw new ExpressionLoweringError(
      "invalid_arity",
      `${fn} expects ${expected} args`,
      { function: fn, expected, actual: args.length },
    );
  }
}

function qi(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}

if (import.meta.main) {
  for (const expr of Deno.args) {
    console.log(
      JSON.stringify({ expression: expr, ...lowerCelToSql(expr) }, null, 2),
    );
  }
}
