import { diffValidatedPacks } from "./migration-validated-packs-spike.ts";

Deno.test("validated YAML packs feed migration classification and SQL generation", () => {
  const v1 = [{
    path: "pack.yaml",
    text:
      "kind: Pack\nmetadata: {namespace: default, name: crm, version: 0.1.0}\nspec: {}\n",
  }, {
    path: "resources/lead.yaml",
    text:
      "kind: Resource\nmetadata: {name: lead}\nspec:\n  fields:\n    name: {type: string, required: true}\n    score: {type: integer}\n",
  }];
  const v2 = [{
    path: "pack.yaml",
    text:
      "kind: Pack\nmetadata: {namespace: default, name: crm, version: 0.2.0}\nspec: {}\n",
  }, {
    path: "resources/lead.yaml",
    text:
      "kind: Resource\nmetadata: {name: lead}\nspec:\n  fields:\n    name: {type: string, required: true}\n    email: {type: string}\n    score: {type: string}\n",
  }];
  const diff = diffValidatedPacks(v1, v2) as any;
  if (!diff.ok) throw new Error(JSON.stringify(diff.errors));
  if (
    !diff.issues.some((i: any) => i.type === "add_field" && i.field === "email")
  ) throw new Error(JSON.stringify(diff));
  if (
    !diff.issues.some((i: any) =>
      i.type === "change_field_type" && i.field === "score" &&
      i.class === "destructive"
    )
  ) throw new Error(JSON.stringify(diff));
  if (!diff.sql.some((sql: string) => sql.includes('add column "email"'))) {
    throw new Error(JSON.stringify(diff.sql));
  }
});

Deno.test("invalid candidate pack blocks migration planning", () => {
  const diff = diffValidatedPacks([], [{
    path: "resources/lead.yaml",
    text:
      "kind: Resource\nmetadata: {name: lead}\nspec:\n  fields:\n    bad: {type: nope}\n",
  }]) as any;
  if (diff.ok) throw new Error("expected validation failure");
  if (!diff.errors.length) throw new Error("expected errors");
});
