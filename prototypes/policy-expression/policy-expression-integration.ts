import { PolicySchema, validateWithSchema } from "../typebox/typebox-spike.ts";
import {
  lowerCelToSql,
  type SqlLowerContext,
} from "../expression/cel-ast-sql-spike.ts";

type CompileResult = { sql: string; params: unknown[]; explanations: string[] };

export function compilePolicyForQuery(
  policy: unknown,
  input: {
    resource: string;
    action: string;
    roles: string[];
    context: SqlLowerContext;
  },
): CompileResult {
  const validation = validateWithSchema(PolicySchema, policy, "policy");
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  const params: unknown[] = [];
  const clauses: string[] = [];
  const explanations: string[] = [];
  for (const rule of (policy as any).spec.rules) {
    if (
      !matches(rule.resources, input.resource) ||
      !matches(rule.actions, input.action) || !rule.roles.some((r: string) =>
        input.roles.includes(r) || r === "*"
      )
    ) continue;
    const sub: string[] = [];
    if (rule.where) {
      const lowered = lowerCelToSql(rule.where, input.context);
      sub.push(renumber(lowered.sql, params.length));
      params.push(...lowered.params);
    }
    if (rule.relation) {
      const rel = rule.relation;
      const actor = input.context.actor?.[rel.subjectIdsFromActor]?.value;
      params.push(actor ?? []);
      const objectColumn = rel.objectSide === "from" ? "from_id" : "to_id";
      const subjectColumn = rel.objectSide === "from" ? "to_id" : "from_id";
      sub.push(
        `exists (select 1 from ${
          qi(rel.relationship.replace(".", "_rel_"))
        } r where r.${objectColumn} = obj.id and r.${subjectColumn} = any($${params.length}))`,
      );
    }
    clauses.push(sub.length ? `(${sub.join(" and ")})` : "true");
    explanations.push(rule.name);
  }
  return {
    sql: clauses.length ? `(${clauses.join(" or ")})` : "false",
    params,
    explanations,
  };
}

function matches(values: string[], value: string) {
  return values.includes("*") || values.includes(value);
}
function renumber(sql: string, offset: number) {
  return sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}
function qi(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}
