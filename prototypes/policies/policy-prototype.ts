import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
type Action =
  | "read"
  | "create"
  | "update"
  | "archive"
  | "comment"
  | "transition";
type Resource = "lead" | "opportunity";
type Style = "rbac" | "abac" | "rebac" | "mixed";

type Expr =
  | { op: "all"; exprs: Expr[] }
  | { op: "any"; exprs: Expr[] }
  | { op: "not"; expr: Expr }
  | { op: "active" }
  | { op: "role_in"; roles: string[] }
  | {
    op: "field_eq_actor";
    field: string;
    attr: "id" | "department" | "region";
  }
  | { op: "field_in_actor_set"; field: string; set: "team_ids" | "company_ids" }
  | { op: "field_eq"; field: string; value: string | number | boolean }
  | { op: "field_neq"; field: string; value: string | number | boolean }
  | { op: "field_gte"; field: string; value: number }
  | { op: "field_lte"; field: string; value: number }
  | { op: "actor_attr_eq"; attr: "department" | "region"; value: string }
  | {
    op: "one_hop";
    relation: "team_member" | "company_assignment";
    objectField: "team_id" | "company_id";
  }
  | { op: "deep_relation"; path: string };

type Policy = {
  id: string;
  style: Style;
  resource: Resource;
  actions: Action[];
  expr: Expr;
  expectAllowedIds: string[];
};

type Actor = {
  id: string;
  roles: string[];
  department: string;
  region: string;
  team_ids: string[];
  company_ids: string[];
};

type SqlPredicate = { sql: string; params: unknown[]; joins: string[] };

type ScenarioResult = {
  id: string;
  style: Style;
  sqlAllowedIds: string[];
  runtimeAllowedIds: string[];
  expectAllowedIds: string[];
  ok: boolean;
};

const actor: Actor = {
  id: "alice",
  roles: ["sales_rep", "commenter"],
  department: "sales",
  region: "west",
  team_ids: ["team_west"],
  company_ids: ["company_a"],
};

export async function main() {
  const db = new PGlite();
  await initialize(db);
  const results = await runScenarios(db, policies());
  console.log(
    JSON.stringify(
      {
        total: results.length,
        passed: results.filter((r) => r.ok).length,
        failed: results.filter((r) => !r.ok),
        byStyle: byStyle(results),
      },
      null,
      2,
    ),
  );
}

async function initialize(db: PGlite) {
  await db.exec(`
    create table res_lead(
      id text primary key,
      archived_at timestamptz,
      owner_id text not null,
      team_id text not null,
      company_id text not null,
      department text not null,
      region text not null,
      status text not null,
      score integer not null,
      amount integer not null,
      priority text not null,
      source text not null,
      confidential boolean not null default false
    );
    create table actor_team_memberships(actor_id text not null, team_id text not null, primary key(actor_id, team_id));
    create table actor_company_assignments(actor_id text not null, company_id text not null, primary key(actor_id, company_id));
    insert into actor_team_memberships values ('alice', 'team_west'), ('bob', 'team_east');
    insert into actor_company_assignments values ('alice', 'company_a'), ('bob', 'company_b');
    insert into res_lead(id, archived_at, owner_id, team_id, company_id, department, region, status, score, amount, priority, source, confidential) values
      ('lead_own_hot', null, 'alice', 'team_west', 'company_a', 'sales', 'west', 'new', 80, 1000, 'high', 'web', false),
      ('lead_team_cold', null, 'bob', 'team_west', 'company_b', 'sales', 'west', 'qualified', 30, 7000, 'low', 'partner', false),
      ('lead_company_conf', null, 'carol', 'team_east', 'company_a', 'sales', 'east', 'new', 95, 9000, 'high', 'web', true),
      ('lead_other', null, 'dave', 'team_east', 'company_b', 'support', 'east', 'lost', 10, 500, 'low', 'manual', false),
      ('lead_archived', now(), 'alice', 'team_west', 'company_a', 'sales', 'west', 'new', 99, 10000, 'high', 'web', false);
  `);
}

export async function runScenarios(
  db: PGlite,
  rules: Policy[],
): Promise<ScenarioResult[]> {
  const out: ScenarioResult[] = [];
  for (const policy of rules) {
    const sqlAllowedIds = await queryAllowedIds(db, policy, actor);
    const runtimeAllowedIds = await runtimeAllowedIdsForPolicy(
      db,
      policy,
      actor,
    );
    const expectAllowedIds = [...policy.expectAllowedIds].sort();
    out.push({
      id: policy.id,
      style: policy.style,
      sqlAllowedIds,
      runtimeAllowedIds,
      expectAllowedIds,
      ok: eq(sqlAllowedIds, expectAllowedIds) &&
        eq(runtimeAllowedIds, expectAllowedIds),
    });
  }
  return out;
}

async function queryAllowedIds(
  db: PGlite,
  policy: Policy,
  actor: Actor,
): Promise<string[]> {
  const pred = compileExpr(policy.expr, actor);
  const result = await db.query<{ id: string }>(
    `select distinct o.id from ${tableFor(policy.resource)} o ${
      pred.joins.join(" ")
    } where ${pred.sql} order by o.id`,
    pred.params,
  );
  return result.rows.map((r) => r.id);
}

async function runtimeAllowedIdsForPolicy(
  db: PGlite,
  policy: Policy,
  actor: Actor,
): Promise<string[]> {
  const result = await db.query<Json>(
    `select * from ${tableFor(policy.resource)} order by id`,
  );
  return result.rows.filter((row) => evalExpr(policy.expr, actor, row)).map((
    row,
  ) => row.id as string).sort();
}

function compileExpr(expr: Expr, actor: Actor): SqlPredicate {
  const params: unknown[] = [];
  const joins: string[] = [];
  const next = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const compile = (e: Expr): string => {
    switch (e.op) {
      case "all":
        return `(${e.exprs.map(compile).join(" and ") || "true"})`;
      case "any":
        return `(${e.exprs.map(compile).join(" or ") || "false"})`;
      case "not":
        return `(not ${compile(e.expr)})`;
      case "active":
        return "o.archived_at is null";
      case "role_in":
        return actor.roles.some((role) => e.roles.includes(role))
          ? "true"
          : "false";
      case "field_eq_actor":
        return `o.${qi(e.field)} = ${next(actor[e.attr])}`;
      case "field_in_actor_set":
        return `o.${qi(e.field)} = any(${next(actor[e.set])})`;
      case "field_eq":
        return `o.${qi(e.field)} = ${next(e.value)}`;
      case "field_neq":
        return `o.${qi(e.field)} <> ${next(e.value)}`;
      case "field_gte":
        return `o.${qi(e.field)} >= ${next(e.value)}`;
      case "field_lte":
        return `o.${qi(e.field)} <= ${next(e.value)}`;
      case "actor_attr_eq":
        return actor[e.attr] === e.value ? "true" : "false";
      case "one_hop": {
        const alias = `r${joins.length}`;
        if (e.relation === "team_member") {
          joins.push(
            `left join actor_team_memberships ${alias} on ${alias}.actor_id = ${
              next(actor.id)
            } and ${alias}.team_id = o.${qi(e.objectField)}`,
          );
        }
        if (e.relation === "company_assignment") {
          joins.push(
            `left join actor_company_assignments ${alias} on ${alias}.actor_id = ${
              next(actor.id)
            } and ${alias}.company_id = o.${qi(e.objectField)}`,
          );
        }
        return `${alias}.actor_id is not null`;
      }
      case "deep_relation":
        throw new Error(`deep ReBAC is not supported: ${e.path}`);
    }
  };
  return { sql: compile(expr), params, joins };
}

function evalExpr(expr: Expr, actor: Actor, row: Json): boolean {
  switch (expr.op) {
    case "all":
      return expr.exprs.every((e) => evalExpr(e, actor, row));
    case "any":
      return expr.exprs.some((e) => evalExpr(e, actor, row));
    case "not":
      return !evalExpr(expr.expr, actor, row);
    case "active":
      return !row.archived_at;
    case "role_in":
      return actor.roles.some((role) => expr.roles.includes(role));
    case "field_eq_actor":
      return row[expr.field] === actor[expr.attr];
    case "field_in_actor_set":
      return actor[expr.set].includes(row[expr.field] as string);
    case "field_eq":
      return row[expr.field] === expr.value;
    case "field_neq":
      return row[expr.field] !== expr.value;
    case "field_gte":
      return Number(row[expr.field]) >= expr.value;
    case "field_lte":
      return Number(row[expr.field]) <= expr.value;
    case "actor_attr_eq":
      return actor[expr.attr] === expr.value;
    case "one_hop":
      return expr.relation === "team_member"
        ? actor.team_ids.includes(row[expr.objectField] as string)
        : actor.company_ids.includes(row[expr.objectField] as string);
    case "deep_relation":
      throw new Error(`deep ReBAC is not supported: ${expr.path}`);
  }
}

export function policies(): Policy[] {
  const active: Expr = { op: "active" };
  const roleSales: Expr = { op: "role_in", roles: ["sales_rep"] };
  const roleManager: Expr = { op: "role_in", roles: ["manager"] };
  const owner: Expr = {
    op: "field_eq_actor",
    field: "owner_id",
    attr: "id",
  };
  const team: Expr = {
    op: "one_hop",
    relation: "team_member",
    objectField: "team_id",
  };
  const company: Expr = {
    op: "one_hop",
    relation: "company_assignment",
    objectField: "company_id",
  };
  const own = ["lead_own_hot"];
  const activeIds = [
    "lead_company_conf",
    "lead_other",
    "lead_own_hot",
    "lead_team_cold",
  ];
  const teamIds = ["lead_own_hot", "lead_team_cold"];
  const companyIds = ["lead_company_conf", "lead_own_hot"];
  return [
    // RBAC-style combinations: role/action gate plus broad resource predicates.
    p("rbac_01_sales_read_active", "rbac", {
      op: "all",
      exprs: [roleSales, active],
    }, activeIds),
    p("rbac_02_manager_denied", "rbac", {
      op: "all",
      exprs: [roleManager, active],
    }, []),
    p("rbac_03_sales_or_manager", "rbac", {
      op: "all",
      exprs: [{ op: "any", exprs: [roleSales, roleManager] }, active],
    }, activeIds),
    p("rbac_04_commenter_role", "rbac", {
      op: "all",
      exprs: [{ op: "role_in", roles: ["commenter"] }, active],
    }, activeIds),
    p("rbac_05_admin_or_sales", "rbac", {
      op: "all",
      exprs: [{ op: "role_in", roles: ["admin", "sales_rep"] }, active],
    }, activeIds),
    p("rbac_06_not_manager", "rbac", {
      op: "all",
      exprs: [{ op: "not", expr: roleManager }, active],
    }, activeIds),
    p("rbac_07_sales_high_priority", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "priority",
        value: "high",
      }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("rbac_08_sales_not_confidential", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "confidential",
        value: false,
      }],
    }, ["lead_other", "lead_own_hot", "lead_team_cold"]),
    p("rbac_09_sales_region_west", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "region",
        value: "west",
      }],
    }, ["lead_own_hot", "lead_team_cold"]),
    p("rbac_10_sales_department_sales", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "department",
        value: "sales",
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("rbac_11_sales_new", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "status",
        value: "new",
      }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("rbac_12_sales_not_lost", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_neq",
        field: "status",
        value: "lost",
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("rbac_13_sales_score_gte_50", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_gte",
        field: "score",
        value: 50,
      }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("rbac_14_sales_amount_lte_1000", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_lte",
        field: "amount",
        value: 1000,
      }],
    }, ["lead_other", "lead_own_hot"]),
    p("rbac_15_sales_source_web", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq",
        field: "source",
        value: "web",
      }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("rbac_16_support_role_denied", "rbac", {
      op: "all",
      exprs: [{ op: "role_in", roles: ["support"] }, active],
    }, []),
    p("rbac_17_commenter_low_priority", "rbac", {
      op: "all",
      exprs: [{ op: "role_in", roles: ["commenter"] }, active, {
        op: "field_eq",
        field: "priority",
        value: "low",
      }],
    }, ["lead_other", "lead_team_cold"]),
    p("rbac_18_sales_high_or_partner", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "any",
        exprs: [{ op: "field_eq", field: "priority", value: "high" }, {
          op: "field_eq",
          field: "source",
          value: "partner",
        }],
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("rbac_19_sales_not_manual", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "not",
        expr: { op: "field_eq", field: "source", value: "manual" },
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("rbac_20_sales_archived_excluded", "rbac", {
      op: "all",
      exprs: [roleSales, active, {
        op: "field_eq_actor",
        field: "owner_id",
        attr: "id",
      }],
    }, own),

    // ABAC-style combinations: actor/object attributes and object state.
    p("abac_01_owner", "abac", { op: "all", exprs: [active, owner] }, own),
    p("abac_02_actor_department", "abac", {
      op: "all",
      exprs: [active, {
        op: "field_eq_actor",
        field: "department",
        attr: "department",
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("abac_03_actor_region", "abac", {
      op: "all",
      exprs: [active, {
        op: "field_eq_actor",
        field: "region",
        attr: "region",
      }],
    }, ["lead_own_hot", "lead_team_cold"]),
    p("abac_04_actor_attr_sales", "abac", {
      op: "all",
      exprs: [active, {
        op: "actor_attr_eq",
        attr: "department",
        value: "sales",
      }],
    }, activeIds),
    p("abac_05_actor_attr_east_denied", "abac", {
      op: "all",
      exprs: [active, { op: "actor_attr_eq", attr: "region", value: "east" }],
    }, []),
    p("abac_06_owner_or_west", "abac", {
      op: "all",
      exprs: [active, {
        op: "any",
        exprs: [owner, { op: "field_eq", field: "region", value: "west" }],
      }],
    }, ["lead_own_hot", "lead_team_cold"]),
    p("abac_07_high_score", "abac", {
      op: "all",
      exprs: [active, { op: "field_gte", field: "score", value: 80 }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("abac_08_low_amount", "abac", {
      op: "all",
      exprs: [active, { op: "field_lte", field: "amount", value: 1000 }],
    }, ["lead_other", "lead_own_hot"]),
    p("abac_09_not_confidential", "abac", {
      op: "all",
      exprs: [active, { op: "field_eq", field: "confidential", value: false }],
    }, ["lead_other", "lead_own_hot", "lead_team_cold"]),
    p("abac_10_confidential_owner", "abac", {
      op: "all",
      exprs: [
        active,
        { op: "field_eq", field: "confidential", value: true },
        owner,
      ],
    }, []),
    p("abac_11_new_or_qualified", "abac", {
      op: "all",
      exprs: [active, {
        op: "any",
        exprs: [{ op: "field_eq", field: "status", value: "new" }, {
          op: "field_eq",
          field: "status",
          value: "qualified",
        }],
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("abac_12_not_lost", "abac", {
      op: "all",
      exprs: [active, {
        op: "not",
        expr: { op: "field_eq", field: "status", value: "lost" },
      }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("abac_13_owner_high_score", "abac", {
      op: "all",
      exprs: [active, owner, { op: "field_gte", field: "score", value: 50 }],
    }, own),
    p("abac_14_department_sales_low_amount", "abac", {
      op: "all",
      exprs: [active, { op: "field_eq", field: "department", value: "sales" }, {
        op: "field_lte",
        field: "amount",
        value: 8000,
      }],
    }, ["lead_own_hot", "lead_team_cold"]),
    p("abac_15_region_west_not_low", "abac", {
      op: "all",
      exprs: [active, { op: "field_eq", field: "region", value: "west" }, {
        op: "field_neq",
        field: "priority",
        value: "low",
      }],
    }, ["lead_own_hot"]),
    p("abac_16_source_web_high", "abac", {
      op: "all",
      exprs: [active, { op: "field_eq", field: "source", value: "web" }, {
        op: "field_eq",
        field: "priority",
        value: "high",
      }],
    }, ["lead_company_conf", "lead_own_hot"]),
    p("abac_17_manual_or_lost", "abac", {
      op: "all",
      exprs: [active, {
        op: "any",
        exprs: [{ op: "field_eq", field: "source", value: "manual" }, {
          op: "field_eq",
          field: "status",
          value: "lost",
        }],
      }],
    }, ["lead_other"]),
    p("abac_18_not_archived_owner", "abac", {
      op: "all",
      exprs: [active, owner],
    }, own),
    p("abac_19_sales_dept_and_actor_region", "abac", {
      op: "all",
      exprs: [active, { op: "field_eq", field: "department", value: "sales" }, {
        op: "field_eq_actor",
        field: "region",
        attr: "region",
      }],
    }, ["lead_own_hot", "lead_team_cold"]),
    p("abac_20_complex_nested", "abac", {
      op: "all",
      exprs: [active, {
        op: "any",
        exprs: [{
          op: "all",
          exprs: [owner, { op: "field_gte", field: "score", value: 70 }],
        }, {
          op: "all",
          exprs: [{ op: "field_eq", field: "priority", value: "low" }, {
            op: "field_lte",
            field: "amount",
            value: 1000,
          }],
        }],
      }],
    }, ["lead_other", "lead_own_hot"]),

    // ReBAC-style combinations: exactly one relationship hop via SQL-lowerable joins.
    p(
      "rebac_01_team_member",
      "rebac",
      { op: "all", exprs: [active, team] },
      teamIds,
    ),
    p("rebac_02_company_assignment", "rebac", {
      op: "all",
      exprs: [active, company],
    }, companyIds),
    p("rebac_03_team_or_company", "rebac", {
      op: "all",
      exprs: [active, { op: "any", exprs: [team, company] }],
    }, ["lead_company_conf", "lead_own_hot", "lead_team_cold"]),
    p("rebac_04_team_and_company", "rebac", {
      op: "all",
      exprs: [active, team, company],
    }, own),
    p("rebac_05_team_not_confidential", "rebac", {
      op: "all",
      exprs: [active, team, {
        op: "field_eq",
        field: "confidential",
        value: false,
      }],
    }, teamIds),
    p("rebac_06_company_not_confidential", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_eq",
        field: "confidential",
        value: false,
      }],
    }, own),
    p("rebac_07_team_high_score", "rebac", {
      op: "all",
      exprs: [active, team, { op: "field_gte", field: "score", value: 50 }],
    }, own),
    p("rebac_08_company_high_score", "rebac", {
      op: "all",
      exprs: [active, company, { op: "field_gte", field: "score", value: 50 }],
    }, companyIds),
    p("rebac_09_team_west", "rebac", {
      op: "all",
      exprs: [active, team, { op: "field_eq", field: "region", value: "west" }],
    }, teamIds),
    p("rebac_10_company_east", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_eq",
        field: "region",
        value: "east",
      }],
    }, ["lead_company_conf"]),
    p("rebac_11_team_sales", "rebac", {
      op: "all",
      exprs: [active, team, {
        op: "field_eq",
        field: "department",
        value: "sales",
      }],
    }, teamIds),
    p("rebac_12_company_new", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_eq",
        field: "status",
        value: "new",
      }],
    }, companyIds),
    p("rebac_13_team_qualified", "rebac", {
      op: "all",
      exprs: [active, team, {
        op: "field_eq",
        field: "status",
        value: "qualified",
      }],
    }, ["lead_team_cold"]),
    p("rebac_14_company_not_lost", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_neq",
        field: "status",
        value: "lost",
      }],
    }, companyIds),
    p("rebac_15_team_or_owner", "rebac", {
      op: "all",
      exprs: [active, { op: "any", exprs: [team, owner] }],
    }, teamIds),
    p("rebac_16_company_or_owner", "rebac", {
      op: "all",
      exprs: [active, { op: "any", exprs: [company, owner] }],
    }, companyIds),
    p("rebac_17_team_low_amount", "rebac", {
      op: "all",
      exprs: [active, team, { op: "field_lte", field: "amount", value: 2000 }],
    }, ["lead_own_hot"]),
    p("rebac_18_company_high_amount", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_gte",
        field: "amount",
        value: 5000,
      }],
    }, ["lead_company_conf"]),
    p("rebac_19_team_source_partner", "rebac", {
      op: "all",
      exprs: [active, team, {
        op: "field_eq",
        field: "source",
        value: "partner",
      }],
    }, ["lead_team_cold"]),
    p("rebac_20_company_source_web", "rebac", {
      op: "all",
      exprs: [active, company, {
        op: "field_eq",
        field: "source",
        value: "web",
      }],
    }, companyIds),
  ];
}

export function deepRebacPolicy(): Policy {
  return p("rebac_deep_rejected", "rebac", {
    op: "all",
    exprs: [{ op: "active" }, {
      op: "deep_relation",
      path: "actor.team.parent.region",
    }],
  }, []);
}

function p(
  id: string,
  style: Style,
  expr: Expr,
  expectAllowedIds: string[],
): Policy {
  return {
    id,
    style,
    resource: "lead",
    actions: ["read"],
    expr,
    expectAllowedIds: [...expectAllowedIds].sort(),
  };
}

function byStyle(results: ScenarioResult[]) {
  const counts: Record<string, { total: number; passed: number }> = {};
  for (const result of results) {
    counts[result.style] ??= { total: 0, passed: 0 };
    counts[result.style].total++;
    if (result.ok) counts[result.style].passed++;
  }
  return counts;
}
function tableFor(resource: Resource) {
  return `res_${resource}`;
}
function qi(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier ${identifier}`);
  }
  return `"${identifier}"`;
}
function eq(a: string[], b: string[]) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

if (import.meta.main) await main();
