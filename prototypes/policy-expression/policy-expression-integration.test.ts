import { compilePolicyForQuery } from "./policy-expression-integration.ts";
import { defaultContext } from "../expression/cel-ast-sql-spike.ts";

Deno.test("policy YAML schema plus expression lowerer compile query SQL", () => {
  const policy = {
    kind: "Policy",
    metadata: { name: "sales_access" },
    spec: {
      rules: [{
        name: "own_leads",
        effect: "allow",
        roles: ["sales_rep"],
        actions: ["read"],
        resources: ["default.lead"],
        where: "owner_id == actor.id || sales_team_id in actor.sales_team_ids",
      }],
    },
  };
  const compiled = compilePolicyForQuery(policy, {
    resource: "default.lead",
    action: "read",
    roles: ["sales_rep"],
    context: defaultContext,
  });
  if (!compiled.sql.includes('"owner_id" = $1')) throw new Error(compiled.sql);
  if (
    JSON.stringify(compiled.params) !== JSON.stringify(["actor_1", ["direct"]])
  ) throw new Error(JSON.stringify(compiled.params));
  if (compiled.explanations[0] !== "own_leads") {
    throw new Error("missing explanation");
  }
});

Deno.test("one-level ReBAC relation compiles to exists clause", () => {
  const policy = {
    kind: "Policy",
    metadata: { name: "company_access" },
    spec: {
      rules: [{
        name: "company_member",
        effect: "allow",
        roles: ["sales_rep"],
        actions: ["read"],
        resources: ["default.opportunity"],
        relation: {
          relationship: "default.opportunity_company",
          objectSide: "from",
          subjectResource: "default.company",
          subjectIdsFromActor: "company_ids",
        },
      }],
    },
  };
  const compiled = compilePolicyForQuery(policy, {
    resource: "default.opportunity",
    action: "read",
    roles: ["sales_rep"],
    context: defaultContext,
  });
  if (!compiled.sql.includes("exists")) throw new Error(compiled.sql);
  if (!compiled.sql.includes("from_id = obj.id")) throw new Error(compiled.sql);
  if (JSON.stringify(compiled.params) !== JSON.stringify([["company_1"]])) {
    throw new Error(JSON.stringify(compiled.params));
  }
});
