import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  authorizeObjectRuntime,
  compilePolicyPredicate,
  normalizeActor,
} from "../../src/domain/policies/policy_engine.ts";
import type { Queryable } from "../../src/adapters/outbound/postgres/client.ts";

function fakePolicySql(rules: unknown[]): Queryable {
  return {
    unsafe(sql: string) {
      if (sql.includes("from policy_definitions")) {
        return [{
          namespace: "default",
          name: "sales_access",
          spec: { rules },
        }];
      }
      if (sql.includes("from generated_sql_objects")) return [];
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

const fields = {
  id: { type: "string" as const },
  owner_id: { type: "string" as const },
  sales_team_id: { type: "string" as const },
};

Deno.test("policy SQL/runtime parity for RBAC ABAC allow", async () => {
  const rules = [{
    name: "sales_rep_own_or_team",
    effect: "allow",
    roles: ["sales_rep"],
    actions: ["read"],
    resources: ["default.lead"],
    where: "owner_id == actor.id || sales_team_id in actor.sales_team_ids",
  }];
  const sql = fakePolicySql(rules);
  const actor = normalizeActor({
    id: "user_1",
    roles: ["sales_rep"],
    sales_team_ids: ["direct"],
  });
  const compiled = await compilePolicyPredicate(sql, {
    actor,
    resource: "default.lead",
    action: "read",
    fields,
  });
  assertStringIncludes(compiled.sql, '"owner_id" = $1');
  assertEquals(compiled.params, ["user_1", ["direct"]]);
  const runtime = await authorizeObjectRuntime(sql, {
    actor,
    resource: "default.lead",
    action: "read",
    fields,
    object: { id: "lead_1", owner_id: "user_2", sales_team_id: "direct" },
  });
  assertEquals(runtime.allowed, true);
  assertEquals(runtime.matched_rules, ["sales_rep_own_or_team"]);
});

Deno.test("policy rejects unmatched role/resource and deep ReBAC-shaped rules", async () => {
  const actor = normalizeActor({ id: "user_1", roles: ["viewer"] });
  const denied = await authorizeObjectRuntime(
    fakePolicySql([{ roles: ["admin"], actions: ["read"], resources: ["*"] }]),
    {
      actor,
      resource: "default.lead",
      action: "read",
      fields,
      object: { id: "lead_1", owner_id: "user_1" },
    },
  );
  assertEquals(denied.allowed, false);

  const deep = fakePolicySql([{
    roles: ["sales_rep"],
    actions: ["read"],
    resources: ["default.lead"],
    relation: {
      relationship: "default.team_member->default.team_region",
      objectSide: "from",
      subjectIdsFromActor: "team_ids",
    },
  }]);
  await assertRejectsDeepRebac(deep);
});

async function assertRejectsDeepRebac(sql: Queryable) {
  try {
    await compilePolicyPredicate(sql, {
      actor: normalizeActor({ id: "u", roles: ["sales_rep"], team_ids: ["t"] }),
      resource: "default.lead",
      action: "read",
      fields,
    });
  } catch (error) {
    assertStringIncludes(String(error), "deep ReBAC");
    return;
  }
  throw new Error("expected deep ReBAC rejection");
}
