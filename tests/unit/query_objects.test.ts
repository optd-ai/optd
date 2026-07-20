import { assertEquals } from "jsr:@std/assert";
import { queryRequestContract } from "../../src/schemas/queries/query.ts";

Deno.test("query contract is strict, Project-scoped, and bounded", () => {
  const valid = {
    project_id: "019b7a2e-7c10-7000-8000-000000000002",
    definition: {
      kind: "resource",
      publisher: "operant",
      pack: "crm",
      name: "lead",
    },
    sort: [{ field: "updated_at", direction: "desc" }],
    limit: 500,
  };
  assertEquals(queryRequestContract.issues(valid), []);
  assertEquals(
    queryRequestContract.issues({ ...valid, actor: [] })[0]?.code,
    "unknown_field",
  );
  assertEquals(
    queryRequestContract.issues({ ...valid, limit: 501 })[0]?.code,
    "maximum",
  );
  assertEquals(
    queryRequestContract.issues({ ...valid, sort: [] })[0]?.code,
    "minItems",
  );
});
