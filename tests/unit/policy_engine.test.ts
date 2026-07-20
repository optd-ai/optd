import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  compilePolicyPredicate,
  normalizeActor,
} from "../../src/domain/policies/policy_engine.ts";
import type { Queryable } from "../../src/adapters/outbound/postgres/client.ts";
const fields = {
  id: { type: "string" as const },
  owner_id: { type: "string" as const },
};
function sqlFor(where: string): Queryable {
  return {
    unsafe(sql: string) {
      if (sql.includes("from policy_definitions")) {
        return [{
          namespace: "default",
          name: "access",
          spec: {
            rules: [{
              name: "own",
              effect: "allow",
              roles: ["reader"],
              actions: ["read"],
              resources: ["default.lead"],
              where,
            }],
          },
        }];
      }
      if (sql.includes("from generated_sql_objects")) return [];
      throw new Error(sql);
    },
  };
}
Deno.test("legacy policy entry delegates scalar ABAC to the frozen lowerer", async () => {
  const compiled = await compilePolicyPredicate(
    sqlFor("owner_id == actor.id"),
    {
      actor: normalizeActor({ id: "user_1", roles: ["reader"] }),
      resource: "default.lead",
      action: "read",
      fields,
    },
  );
  assertStringIncludes(compiled.sql, '"owner_id" = $1');
  assertEquals(compiled.params, ["user_1"]);
});
Deno.test("actor arrays and traversal fail closed", async () => {
  await assertRejects(() =>
    compilePolicyPredicate(sqlFor("owner_id in actor.owner_ids"), {
      actor: normalizeActor({
        id: "user_1",
        roles: ["reader"],
        owner_ids: ["user_1"],
      }),
      resource: "default.lead",
      action: "read",
      fields,
    })
  );
  await assertRejects(() =>
    compilePolicyPredicate(sqlFor("related.team.id == actor.id"), {
      actor: normalizeActor({ id: "user_1", roles: ["reader"] }),
      resource: "default.lead",
      action: "read",
      fields,
    })
  );
});
