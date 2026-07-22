// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { parse } from "npm:@bufbuild/cel";
import { canonicalJson } from "../ids/canonical_json.ts";

export type FieldType =
  | "string"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "timestamp";
export type FieldSpec = Readonly<{
  type: FieldType;
  nullable?: boolean;
  column?: string;
  format?: "uuid";
}>;
export type ActorValue = Readonly<{
  type: "string";
  value: unknown;
  array?: boolean;
}>;
export type ExpressionContext = Readonly<{
  fields: Readonly<Record<string, FieldSpec>>;
  actor?: Readonly<Record<string, ActorValue>>;
  alias?: string;
  parameterOffset?: number;
  maxLength?: number;
  maxNodes?: number;
  allowNull?: boolean;
}>;
export type LoweredExpression = Readonly<
  { sql: string; params: unknown[]; normalized: unknown }
>;

type CelExpr = NonNullable<ReturnType<typeof parse>["expr"]>;
type ExprKind = NonNullable<CelExpr["exprKind"]>;
type KindValue<C extends ExprKind["case"]> = Extract<
  ExprKind,
  { case: C }
>["value"];
type Scalar = FieldType | "null";
type Value = {
  sql: string;
  type: Scalar | "array";
  normalized: unknown;
  field?: FieldSpec;
  literal?: unknown;
  elements?: Value[];
};
type State = { params: unknown[]; nodes: number; context: ExpressionContext };
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);

export class ExpressionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function parseCel(source: string): ReturnType<typeof parse> {
  try {
    return parse(source);
  } catch (error) {
    const location = (error as {
      location?: {
        start?: { line?: number; column?: number; offset?: number };
        end?: { offset?: number };
      };
    }).location;
    throw new ExpressionError(
      "expression_syntax",
      "expression syntax is invalid",
      {
        line: location?.start?.line ?? 1,
        column: location?.start?.column ?? 1,
        span: location
          ? { start: location.start?.offset, end: location.end?.offset }
          : undefined,
      },
    );
  }
}

export function lowerExpression(
  source: string,
  context: ExpressionContext,
): LoweredExpression {
  if (typeof source !== "string" || source.length === 0) {
    throw new ExpressionError(
      "expression_syntax",
      "expression must not be empty",
    );
  }
  if (source.length > (context.maxLength ?? 1000)) {
    throw new ExpressionError("expression_too_long", "expression is too long");
  }
  const parsed = parseCel(source);
  const state: State = { params: [], nodes: 0, context };
  if (!parsed.expr) {
    throw new ExpressionError("expression_syntax", "expression AST is missing");
  }
  const value = lower(parsed.expr, state);
  if (value.type !== "boolean") {
    throw new ExpressionError(
      "expression_type",
      "expression root must be boolean",
    );
  }
  return { sql: value.sql, params: state.params, normalized: value.normalized };
}

export function expressionHelp(context = "query"): string {
  return [
    `Operant CEL subset (${context})`,
    "operators: && || ! == != < <= > >= in",
    "helpers: present(field), active(), archived()",
    "literals: strings, JSON-safe integers, booleans, non-empty homogeneous arrays",
    "unsupported: null, fractional numbers, maps, methods, indexing, traversal, regex, arbitrary calls",
  ].join("\n");
}

export async function expressionDigest(normalized: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(normalized)),
  );
  return `sha256:${
    [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0"))
      .join("")
  }`;
}

function lower(expr: CelExpr, state: State): Value {
  if (++state.nodes > (state.context.maxNodes ?? 80)) {
    throw new ExpressionError(
      "expression_too_complex",
      "expression is too complex",
    );
  }
  const kind = expr?.exprKind;
  switch (kind?.case) {
    case "identExpr":
      return ident(kind.value.name, state);
    case "selectExpr":
      return select(kind.value, state);
    case "constExpr":
      return constant(kind.value, state);
    case "listExpr":
      return list(kind.value, state);
    case "callExpr":
      return call(kind.value, state);
    default:
      throw unsupported("expression form", kind?.case);
  }
}

function call(node: KindValue<"callExpr">, state: State): Value {
  const fn = node.function;
  const args = node.args ?? [];
  if (fn === "_&&_" || fn === "_||_") {
    arity(fn, args, 2);
    const a = lower(args[0], state);
    const b = lower(args[1], state);
    bool(a);
    bool(b);
    const op = fn === "_&&_" ? "and" : "or";
    return {
      sql: `(${a.sql} ${op} ${b.sql})`,
      type: "boolean",
      normalized: [op, a.normalized, b.normalized],
    };
  }
  if (fn === "!_") {
    arity(fn, args, 1);
    const a = lower(args[0], state);
    bool(a);
    return {
      sql: `(not ${a.sql})`,
      type: "boolean",
      normalized: ["not", a.normalized],
    };
  }
  if (["_==_", "_!=_", "_<_", "_<=_", "_>_", "_>=_"].includes(fn)) {
    arity(fn, args, 2);
    return comparison(fn, lower(args[0], state), lower(args[1], state));
  }
  if (fn === "_in_" || fn === "@in") {
    arity(fn, args, 2);
    const left = lower(args[0], state);
    const right = lower(args[1], state);
    if (right.type !== "array" || !right.elements?.length) {
      throw new ExpressionError(
        "expression_type",
        "right side of in must be a non-empty array",
      );
    }
    for (const item of right.elements) compatible(left, item, "in");
    return {
      sql: `(${left.sql} in (${
        right.elements.map((v) => castPair(left, v)[1]).join(",")
      }))`,
      type: "boolean",
      normalized: ["in", left.normalized, right.normalized],
    };
  }
  if (fn === "present") {
    arity(fn, args, 1);
    const value = lower(args[0], state);
    if (!value.field) {
      throw new ExpressionError(
        "expression_argument",
        "present expects a row field",
      );
    }
    return {
      sql: `(${value.sql} is not null)`,
      type: "boolean",
      normalized: ["present", value.normalized],
    };
  }
  if (fn === "active" || fn === "archived") {
    arity(fn, args, 0);
    const value = ident("archived_at", state);
    return {
      sql: `(${value.sql} is ${fn === "archived" ? "not " : ""}null)`,
      type: "boolean",
      normalized: [fn],
    };
  }
  throw unsupported("function", fn);
}

function comparison(fn: string, left: Value, right: Value): Value {
  compatible(left, right, fn);
  if (left.type === "null" || right.type === "null") {
    if (!["_==_", "_!=_"].includes(fn)) {
      throw new ExpressionError("expression_type", "null is not ordered");
    }
    const value = left.type === "null" ? right : left;
    return {
      sql: `(${typedSql(value)} is ${fn === "_!=_" ? "not " : ""}null)`,
      type: "boolean",
      normalized: [fn === "_!=_" ? "is-not-null" : "is-null", value.normalized],
    };
  }
  if (
    (left.type === "boolean" || right.type === "boolean") &&
    !["_==_", "_!=_"].includes(fn)
  ) throw new ExpressionError("expression_type", "booleans are not ordered");
  const [a, b] = castPair(left, right);
  const op = ({
    "_==_": "=",
    "_!=_": "<>",
    "_<_": "<",
    "_<=_": "<=",
    "_>_": ">",
    "_>=_": ">=",
  } as Record<string, string>)[fn];
  return {
    sql: `(${a} ${op} ${b})`,
    type: "boolean",
    normalized: [op, left.normalized, right.normalized],
  };
}

function compatible(a: Value, b: Value, operation: string) {
  if (a.type === b.type) return;
  if (a.type === "null" || b.type === "null") {
    if (operation === "_==_" || operation === "_!=_") return;
    throw new ExpressionError("expression_type", "null is not ordered");
  }
  if (
    (a.type === "decimal" && b.type === "integer") ||
    (a.type === "integer" && b.type === "decimal")
  ) return;
  if (
    (a.type === "date" || a.type === "timestamp") && b.type === "string" &&
    b.literal !== undefined
  ) {
    validateTemporal(a.type, String(b.literal));
    return;
  }
  if (
    (b.type === "date" || b.type === "timestamp") && a.type === "string" &&
    a.literal !== undefined
  ) {
    validateTemporal(b.type, String(a.literal));
    return;
  }
  throw new ExpressionError(
    "expression_type",
    `incompatible operands for ${operation}`,
    { left: a.type, right: b.type },
  );
}
function typedSql(value: Value): string {
  if (value.field) return value.sql;
  const cast = value.type === "integer"
    ? "bigint"
    : value.type === "decimal"
    ? "numeric"
    : value.type === "boolean"
    ? "boolean"
    : value.type === "date"
    ? "date"
    : value.type === "timestamp"
    ? "timestamptz"
    : "text";
  return `(${value.sql})::${cast}`;
}
function castPair(a: Value, b: Value): [string, string] {
  if (a.type === "decimal" && b.type === "integer") {
    return [a.sql, `(${b.sql})::numeric`];
  }
  if (b.type === "decimal" && a.type === "integer") {
    return [`(${a.sql})::numeric`, b.sql];
  }
  if (a.type === "date" && b.type === "string") {
    return [a.sql, `(${b.sql})::date`];
  }
  if (b.type === "date" && a.type === "string") {
    return [`(${a.sql})::date`, b.sql];
  }
  if (a.type === "timestamp" && b.type === "string") {
    return [a.sql, `(${b.sql})::timestamptz`];
  }
  if (b.type === "timestamp" && a.type === "string") {
    return [`(${a.sql})::timestamptz`, b.sql];
  }
  return [a.sql, b.sql];
}

function ident(name: string, state: State): Value {
  const spec = state.context.fields[name];
  if (!spec) {
    throw new ExpressionError(
      "expression_unknown_symbol",
      `unknown field ${name}`,
      { field: name },
    );
  }
  return {
    sql: `${state.context.alias ? `${qi(state.context.alias)}.` : ""}${
      qi(spec.column ?? name)
    }`,
    type: spec.type,
    field: spec,
    normalized: ["field", name],
  };
}
function select(node: KindValue<"selectExpr">, state: State): Value {
  if (node.operand?.exprKind?.case !== "identExpr") {
    throw unsupported("traversal");
  }
  const root = node.operand.exprKind.value.name;
  if (root === "self") return ident(node.field, state);
  if (root !== "actor") throw unsupported("traversal", root);
  const actor = state.context.actor?.[node.field];
  if (!actor) {
    throw new ExpressionError(
      "expression_unknown_symbol",
      `unknown actor field ${node.field}`,
      { field: node.field },
    );
  }
  if (
    actor.array || (typeof actor.value !== "string" && actor.value !== null)
  ) {
    throw unsupported("actor arrays or non-scalar actor values");
  }
  return parameter(actor.value, actor.type, state, ["actor", node.field]);
}
function constant(node: KindValue<"constExpr">, state: State): Value {
  const kind = node.constantKind;
  if (kind.case === "stringValue") {
    return parameter(
      kind.value,
      "string",
      state,
      ["string", kind.value],
      kind.value,
    );
  }
  if (kind.case === "boolValue") {
    return parameter(
      kind.value,
      "boolean",
      state,
      ["boolean", kind.value],
      kind.value,
    );
  }
  if (kind.case === "int64Value" || kind.case === "uint64Value") {
    const integer = BigInt(kind.value);
    if (integer > SAFE_MAX || integer < -SAFE_MAX) {
      throw new ExpressionError(
        "expression_integer_range",
        "integer literal exceeds JSON-safe range",
      );
    }
    const value = Number(integer);
    return parameter(value, "integer", state, ["integer", value], value);
  }
  if (kind.case === "doubleValue") throw unsupported("fractional literal");
  if (kind.case === "nullValue") {
    if (!state.context.allowNull) throw unsupported("null literal");
    return {
      sql: "null",
      type: "null",
      normalized: ["null"],
      literal: null,
    };
  }
  throw unsupported("literal", kind.case);
}
function list(node: KindValue<"listExpr">, state: State): Value {
  const elements: Value[] = (node.elements ?? []).map((item: CelExpr) => {
    if (item.exprKind?.case !== "constExpr") throw unsupported("array element");
    return constant(item.exprKind.value, state);
  });
  if (!elements.length) {
    throw new ExpressionError(
      "expression_array_empty",
      "arrays must not be empty",
    );
  }
  if (new Set(elements.map((v) => v.type)).size !== 1) {
    throw new ExpressionError(
      "expression_array_heterogeneous",
      "arrays must be homogeneous",
    );
  }
  return {
    sql: "",
    type: "array",
    elements,
    normalized: ["array", ...elements.map((v) => v.normalized)],
  };
}
function parameter(
  value: unknown,
  type: Exclude<Scalar, "null">,
  state: State,
  normalized: unknown,
  literal?: unknown,
): Value {
  state.params.push(value);
  return {
    sql: `$${(state.context.parameterOffset ?? 0) + state.params.length}`,
    type,
    normalized,
    literal,
  };
}
function validateTemporal(type: "date" | "timestamp", value: string) {
  if (type === "date") {
    const parsed = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
    const instant = parsed
      ? new Date(
        Date.UTC(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3])),
      )
      : null;
    if (
      !instant || Number.isNaN(instant.getTime()) ||
      instant.toISOString().slice(0, 10) !== value
    ) {
      throw new ExpressionError(
        "expression_date",
        "date literal must be YYYY-MM-DD",
      );
    }
  } else if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ExpressionError(
      "expression_timestamp",
      "timestamp literal must be RFC3339 UTC",
    );
  }
}
function bool(value: Value) {
  if (value.type !== "boolean") {
    throw new ExpressionError("expression_type", "boolean operand required");
  }
}
function arity(fn: string, args: unknown[], count: number) {
  if (args.length !== count) {
    throw new ExpressionError(
      "expression_arity",
      `${fn} expects ${count} arguments`,
    );
  }
}
function unsupported(what: string, value?: unknown): ExpressionError {
  return new ExpressionError(
    "expression_unsupported",
    `${what} is not supported`,
    value === undefined ? {} : { value },
  );
}
function qi(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new ExpressionError(
      "expression_identifier",
      "unsafe metadata identifier",
    );
  }
  return `"${value}"`;
}
