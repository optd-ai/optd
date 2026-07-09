import { parse } from "npm:@bufbuild/cel";
import {
  type FieldSpec,
  lowerCelToSql,
} from "../queries/expression_lowerer.ts";
import {
  query,
  type Queryable,
  quoteIdentifier,
} from "../../adapters/outbound/postgres/client.ts";

export type ActorContext = {
  id: string;
  roles: string[];
  [key: string]: unknown;
};

export type PolicyRule = {
  name: string;
  roles: string[];
  actions: string[];
  resources: string[];
  where?: string;
  relation?: {
    relationship: string;
    objectSide: "from" | "to";
    subjectIdsFromActor: string;
  };
};

export type PolicyDecision = {
  allowed: boolean;
  bypassed: boolean;
  digest: string;
  matched_rules: string[];
  checked_rules: string[];
  reason: string;
};

export class PolicyDeniedError extends Error {
  readonly code = "policy_denied";
  constructor(
    message: string,
    public details: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function normalizeActor(input: unknown): ActorContext {
  if (typeof input === "string") {
    return { id: input, roles: input === "super_admin" ? ["super_admin"] : [] };
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const id = typeof rec.id === "string"
      ? rec.id
      : typeof rec.actor_id === "string"
      ? rec.actor_id
      : "anonymous";
    const roles = Array.isArray(rec.roles)
      ? rec.roles.filter((r): r is string => typeof r === "string")
      : typeof rec.role === "string"
      ? [rec.role]
      : [];
    return { ...rec, id, roles };
  }
  return { id: "anonymous", roles: [] };
}

export function actorExpressionFields(actor: ActorContext) {
  const fields: Record<
    string,
    { type: "string"; array?: boolean; value: unknown }
  > = {
    id: { type: "string", value: actor.id },
    roles: { type: "string", array: true, value: actor.roles },
    sales_team_ids: { type: "string", array: true, value: [] },
    company_ids: { type: "string", array: true, value: [] },
    team_ids: { type: "string", array: true, value: [] },
  };
  for (const [key, value] of Object.entries(actor)) {
    if (key === "id" || key === "roles") continue;
    if (Array.isArray(value)) {
      fields[key] = { type: "string", array: true, value };
    } else if (typeof value === "string") {
      fields[key] = { type: "string", value };
    }
  }
  return fields;
}

export async function loadPolicyRules(
  sql: Queryable,
  namespace?: string,
): Promise<PolicyRule[]> {
  const rows = await query<{ namespace: string; name: string; spec: unknown }>(
    sql,
    `select namespace,name,spec from policy_definitions
     where revision in (select revision from pack_revisions where active=true)
       and ($1::text is null or namespace=$1)
     order by namespace,name`,
    [namespace ?? null],
  );
  const rules: PolicyRule[] = [];
  for (const policy of rows.rows) {
    const spec = asRecord(policy.spec);
    const rawRules = Array.isArray(spec.rules)
      ? spec.rules.filter(isRecord)
      : [];
    rawRules.forEach((rule, index) => {
      const normalized = normalizeRule(
        policy.namespace,
        policy.name,
        rule,
        index,
      );
      if (normalized) rules.push(normalized);
    });
  }
  return rules;
}

export async function compilePolicyPredicate(
  sql: Queryable,
  input: {
    actor: ActorContext;
    resource: string;
    action: string;
    fields: Record<string, FieldSpec>;
  },
): Promise<{ sql: string; params: unknown[]; decision: PolicyDecision }> {
  const digest = await actorPolicyDigest(
    input.actor,
    input.resource,
    input.action,
  );
  if (input.actor.roles.includes("super_admin")) {
    return {
      sql: "true",
      params: [],
      decision: {
        allowed: true,
        bypassed: true,
        digest,
        matched_rules: ["super_admin_bypass"],
        checked_rules: [],
        reason: "super_admin bypass",
      },
    };
  }
  const rules = (await loadPolicyRules(sql, input.resource.split(".")[0]))
    .filter((rule) =>
      ruleMatches(rule, input.actor, input.resource, input.action)
    );
  const params: unknown[] = [];
  const clauses: string[] = [];
  const checked = rules.map((r) => r.name);
  const matched: string[] = [];
  for (const rule of rules) {
    const parts: string[] = [];
    if (rule.where) {
      const lowered = lowerCelToSql(rule.where, {
        fields: input.fields,
        actor: actorExpressionFields(input.actor),
        allowSelfAlias: true,
        maxNodes: 80,
        maxLength: 1_000,
      });
      parts.push(offsetParams(lowered.sql, params.length));
      params.push(...lowered.params);
    }
    if (rule.relation) {
      const relation = await getRelationshipTable(
        sql,
        rule.relation.relationship,
      );
      if (!relation) continue;
      const ids = input.actor[rule.relation.subjectIdsFromActor];
      params.push(Array.isArray(ids) ? ids : []);
      const objectColumn = rule.relation.objectSide === "from"
        ? "from_object_id"
        : "to_object_id";
      const subjectColumn = rule.relation.objectSide === "from"
        ? "to_object_id"
        : "from_object_id";
      parts.push(
        `exists (select 1 from ${
          quoteIdentifier(relation.tableName)
        } pol_rel where pol_rel.${quoteIdentifier(objectColumn)} = ${
          quoteIdentifier("id")
        } and pol_rel.${
          quoteIdentifier(subjectColumn)
        } = any($${params.length}))`,
      );
    }
    clauses.push(parts.length ? `(${parts.join(" and ")})` : "true");
    matched.push(rule.name);
  }
  return {
    sql: clauses.length ? `(${clauses.join(" or ")})` : "false",
    params,
    decision: {
      allowed: clauses.length > 0,
      bypassed: false,
      digest,
      matched_rules: matched,
      checked_rules: checked,
      reason: clauses.length ? "matched allow rule" : "no matching allow rule",
    },
  };
}

export async function authorizeObjectRuntime(
  sql: Queryable,
  input: {
    actor: ActorContext;
    resource: string;
    action: string;
    fields: Record<string, FieldSpec>;
    object: Record<string, unknown> | null;
  },
): Promise<PolicyDecision> {
  const digest = await actorPolicyDigest(
    input.actor,
    input.resource,
    input.action,
  );
  if (input.actor.roles.includes("super_admin")) {
    return {
      allowed: true,
      bypassed: true,
      digest,
      matched_rules: ["super_admin_bypass"],
      checked_rules: [],
      reason: "super_admin bypass",
    };
  }
  const rules = (await loadPolicyRules(sql, input.resource.split(".")[0]))
    .filter((rule) =>
      ruleMatches(rule, input.actor, input.resource, input.action)
    );
  const checked = rules.map((r) => r.name);
  const matched: string[] = [];
  for (const rule of rules) {
    const whereOk = rule.where
      ? evalCel(rule.where, input.object ?? {}, input.actor) === true
      : true;
    const relationOk = rule.relation
      ? input.object &&
        await evalRelation(
          sql,
          rule.relation,
          String(input.object.id ?? ""),
          input.actor,
        )
      : true;
    if (whereOk && relationOk) matched.push(rule.name);
  }
  return {
    allowed: matched.length > 0,
    bypassed: false,
    digest,
    matched_rules: matched,
    checked_rules: checked,
    reason: matched.length ? "matched allow rule" : "no matching allow rule",
  };
}

export async function assertPolicyAllowed(
  sql: Queryable,
  decision: PolicyDecision,
  input: {
    actor: ActorContext;
    resource: string;
    action: string;
    object_id?: string;
  },
): Promise<void> {
  if (decision.bypassed) {
    await auditPolicy(sql, input, decision, "policy.bypassed");
  }
  if (decision.allowed) return;
  await auditPolicy(sql, input, decision, "policy.denied");
  throw new PolicyDeniedError(
    `actor is not allowed to ${input.action} ${input.resource}`,
    {
      actor_id: input.actor.id,
      resource: input.resource,
      action: input.action,
      object_id: input.object_id,
      checked_rules: decision.checked_rules,
      matched_rules: decision.matched_rules,
    },
  );
}

export async function auditPolicy(
  sql: Queryable,
  input: {
    actor: ActorContext;
    resource: string;
    action: string;
    object_id?: string;
  },
  decision: PolicyDecision,
  eventType = decision.bypassed
    ? "policy.bypassed"
    : decision.allowed
    ? "policy.allowed"
    : "policy.denied",
) {
  await query(
    sql,
    `insert into audit_events(id, actor_id, event_type, resource, object_id, action, decision, policy_summary_json)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [
      crypto.randomUUID(),
      input.actor.id,
      eventType,
      input.resource,
      input.object_id ?? null,
      input.action,
      decision.bypassed ? "bypassed" : decision.allowed ? "allowed" : "denied",
      JSON.stringify(decision),
    ],
  );
}

function normalizeRule(
  namespace: string,
  policyName: string,
  raw: Record<string, unknown>,
  index: number,
): PolicyRule | null {
  const roles = stringArray(raw.roles) ??
    (typeof raw.role === "string" ? [raw.role] : undefined);
  const actions = stringArray(raw.actions) ?? stringArray(raw.allow);
  const resources = stringArray(raw.resources) ?? ["*"];
  if (!roles?.length || !actions?.length) return null;
  const relation = isRecord(raw.relation) ? raw.relation : undefined;
  if (
    relation &&
    (typeof relation.relationship !== "string" ||
      relation.relationship.includes("->") ||
      relation.relationship.includes(
        "." + String(relation.subjectIdsFromActor) + ".",
      ))
  ) {
    throw new Error(
      "deep ReBAC traversal is not supported; policy relation must be one relationship hop",
    );
  }
  return {
    name: typeof raw.name === "string"
      ? raw.name
      : `${namespace}.${policyName}[${index}]`,
    roles,
    actions,
    resources,
    where: typeof raw.where === "string" ? raw.where : undefined,
    relation: relation
      ? {
        relationship: String(relation.relationship),
        objectSide: relation.objectSide === "to" ? "to" : "from",
        subjectIdsFromActor: String(relation.subjectIdsFromActor),
      }
      : undefined,
  };
}

function ruleMatches(
  rule: PolicyRule,
  actor: ActorContext,
  resource: string,
  action: string,
) {
  return matches(rule.resources, resource) && matches(rule.actions, action) &&
    rule.roles.some((role) => role === "*" || actor.roles.includes(role));
}
function matches(values: string[], value: string) {
  return values.includes("*") || values.includes(value);
}
function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? value
    : undefined;
}
async function getRelationshipTable(
  sql: Queryable,
  id: string,
): Promise<{ tableName: string } | null> {
  const [namespace, name] = splitId(id);
  if (!namespace || !name) return null;
  const rows = await query<{ table_name: string }>(
    sql,
    `select table_name from generated_sql_objects where kind='relationship_table' and namespace=$1 and name=$2 and revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  return rows.rows[0] ? { tableName: rows.rows[0].table_name } : null;
}
async function evalRelation(
  sql: Queryable,
  relation: NonNullable<PolicyRule["relation"]>,
  objectId: string,
  actor: ActorContext,
) {
  const table = await getRelationshipTable(sql, relation.relationship);
  if (!table) return false;
  const ids = actor[relation.subjectIdsFromActor];
  if (!Array.isArray(ids) || ids.length === 0) return false;
  const objectColumn = relation.objectSide === "from"
    ? "from_object_id"
    : "to_object_id";
  const subjectColumn = relation.objectSide === "from"
    ? "to_object_id"
    : "from_object_id";
  const rows = await query<{ ok: number }>(
    sql,
    `select 1 as ok from ${quoteIdentifier(table.tableName)} where ${
      quoteIdentifier(objectColumn)
    }=$1 and ${quoteIdentifier(subjectColumn)}=any($2) limit 1`,
    [objectId, ids],
  );
  return rows.rows.length > 0;
}

function evalCel(
  expression: string,
  object: Record<string, unknown>,
  actor: ActorContext,
): unknown {
  const parsed: any = parse(expression);
  return evalExpr(parsed.expr, object, actor);
}
function evalExpr(
  expr: any,
  object: Record<string, unknown>,
  actor: ActorContext,
): unknown {
  const kind = expr.exprKind;
  if (kind.case === "identExpr") {
    const name = kind.value.name;
    if (name === "true") return true;
    if (name === "false") return false;
    return object[name];
  }
  if (kind.case === "selectExpr") {
    const root = kind.value.operand?.exprKind?.value?.name;
    if (root === "actor") return actor[kind.value.field];
    if (root === "self") return object[kind.value.field];
  }
  if (kind.case === "constExpr") return constValue(kind.value);
  if (kind.case === "listExpr") {
    return (kind.value.elements ?? []).map((e: any) =>
      evalExpr(e, object, actor)
    );
  }
  if (kind.case === "callExpr") {
    const fn = kind.value.function;
    const args = kind.value.args ?? [];
    if (fn === "_&&_") {
      return Boolean(evalExpr(args[0], object, actor)) &&
        Boolean(evalExpr(args[1], object, actor));
    }
    if (fn === "_||_") {
      return Boolean(evalExpr(args[0], object, actor)) ||
        Boolean(evalExpr(args[1], object, actor));
    }
    if (fn === "!_") return !Boolean(evalExpr(args[0], object, actor));
    const left = evalExpr(args[0], object, actor);
    const right = evalExpr(args[1], object, actor);
    if (fn === "_==_") return left === right;
    if (fn === "_!=_") return left !== right;
    if (fn === "_in_" || fn === "@in") {
      return Array.isArray(right) && right.includes(left);
    }
    if (fn === "_<_") return Number(left) < Number(right);
    if (fn === "_<=_") return Number(left) <= Number(right);
    if (fn === "_>_") return Number(left) > Number(right);
    if (fn === "_>=_") return Number(left) >= Number(right);
  }
  throw new Error("unsupported policy expression");
}
function constValue(value: any) {
  const kind = value.constantKind;
  if (!kind) return null;
  if (
    ["stringValue", "int64Value", "uint64Value", "doubleValue", "boolValue"]
      .includes(kind.case)
  ) return kind.value;
  if (kind.case === "nullValue") return null;
  return null;
}
async function actorPolicyDigest(
  actor: ActorContext,
  resource: string,
  action: string,
): Promise<string> {
  const value = { actor, resource, action };
  const bytes = new TextEncoder().encode(
    JSON.stringify(value, Object.keys(value).sort()),
  );
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function offsetParams(sql: string, offset: number) {
  return sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}
function splitId(id: string): [string | null, string | null] {
  const parts = String(id).split(".");
  return parts.length === 2 ? [parts[0], parts[1]] : [null, null];
}
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "string"
    ? JSON.parse(value)
    : isRecord(value)
    ? value
    : {};
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
