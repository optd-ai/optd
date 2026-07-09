import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { runQuery } from "../../src/application/services/query_objects.ts";

Deno.test("query_objects validates projection and emits parameterized SQL", async () => {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const fake = {
    unsafe(text: string, params: unknown[]) {
      calls.push({ text, params });
      if (text.includes("from resource_definitions")) {
        return Promise.resolve([{
          namespace: "default",
          name: "lead",
          revision: "rev1",
          table_name: "res_lead",
          spec: {
            fields: {
              name: { type: "string" },
              status: { type: "string" },
              email: { type: "string" },
              score: { type: "integer" },
            },
            axi: { list: { fields: ["id", "name", "email"] } },
          },
        }]);
      }
      return Promise.resolve([{
        id: "lead_1",
        name: "A",
        email: "a@example.com",
      }]);
    },
  };
  const result = await runQuery(fake, {
    resource: "default.lead",
    fields: ["id", "email"],
    where: 'email == "x\'; drop table res_lead; --" && score >= 10',
    sort: [{ field: "score", direction: "desc" }],
    limit: 1,
  });
  assertEquals(result.items.length, 1);
  const select = calls.at(-1)!;
  assertStringIncludes(select.text, '"email" = $1');
  assertStringIncludes(select.text, '"score" >= $2');
  assertStringIncludes(select.text, '"archived_at" is null');
  assert(!select.text.includes("drop table"));
  assertEquals(select.params.slice(0, 2), ["x'; drop table res_lead; --", 10]);
});
