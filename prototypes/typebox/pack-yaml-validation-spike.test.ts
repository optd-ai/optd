import { validatePackYamlFiles } from "./pack-yaml-validation-spike.ts";

Deno.test("yaml parser shenanigans normalize to JS objects and TypeBox validates them", () => {
  const result = validatePackYamlFiles([
    {
      path: "pack.yaml",
      text: `kind: Pack
metadata: {namespace: default, name: crm, version: 0.1.0}
spec:
  purpose: CRM
`,
    },
    {
      path: "resources/lead.yaml",
      text: `kind: Resource
metadata:
  name: lead
spec:
  fields:
    name: &stringField
      type: string
      required: true
    email:
      <<: *stringField
      required: false
`,
    },
  ]);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const lead = (result.normalized as any)["resources/lead.yaml"] as any;
  if (lead.spec.fields.email.type !== "string") {
    throw new Error("anchor/merge did not normalize");
  }
});

Deno.test("multi-file YAML validation returns stable errors", () => {
  const result = validatePackYamlFiles([
    { path: "docs/readme.yaml", text: "kind: Nope" },
    {
      path: "resources/lead.yaml",
      text: `kind: Resource
metadata: {name: contact}
spec:
  fields:
    score: {type: numberish}
`,
    },
  ]);
  if (result.ok) throw new Error("expected validation errors");
  if (!result.errors.some((e: any) => e.code === "unexpected_pack_path")) {
    throw new Error(JSON.stringify(result.errors));
  }
  if (
    !result.errors.some((e: any) =>
      String(e.path).includes("/spec/fields/score/type")
    )
  ) throw new Error(JSON.stringify(result.errors));
});
