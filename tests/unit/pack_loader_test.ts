import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";

const root = `kind: Pack
apiVersion: operant.dev/v1
metadata: { namespace: default, name: test, version: 0.1.0 }
spec: {}
`;
const resource = `kind: Resource
apiVersion: operant.dev/v1
metadata: { name: lead }
spec:
  fields:
    name: { type: string, required: true }
`;

Deno.test("pack loader rejects filename/name mismatches", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/contact.yaml", text: resource },
      ]),
    Error,
    "metadata.name 'lead' must match basename 'contact'",
  );
});

Deno.test("pack loader rejects invalid hook script refs and unpaired scripts", async () => {
  const badHook = `kind: Hook
apiVersion: operant.dev/v1
metadata: { name: validate_lead }
spec: { script: ../validate_lead.ts }
`;
  await assertRejects(() =>
    loadPackFromFiles([
      { path: "pack.yaml", text: root },
      { path: "hooks/validate_lead.yaml", text: badHook },
    ]), Error);
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "hooks/validate_lead.ts", text: "console.log('{}')" },
      ]),
    Error,
    "requires paired",
  );
});

Deno.test("pack loader rejects advanced YAML features", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: `${root}\n---\nkind: Pack`,
      }]),
    Error,
    "exactly one YAML document",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: "!custom { kind: Pack }",
      }]),
    Error,
    "custom YAML tags",
  );
});

Deno.test("pack loader canonicalizes YAML merge keys", async () => {
  const merged = `kind: Resource
apiVersion: operant.dev/v1
metadata: { name: lead }
spec:
  common: &field { type: string, required: true }
  fields:
    name:
      <<: *field
`;
  const pack = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: merged },
  ]);
  assertEquals(pack.resources.lead.spec.fields, {
    name: { required: true, type: "string" },
  });
  assert(pack.revision.startsWith("default.test@0.1.0:"));
});

Deno.test("pack loader accepts canonical CRM fixture", async () => {
  const files: UploadedPackFile[] = [];
  async function collect(dir: string, prefix = "") {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await collect(path, rel);
      else if (rel.endsWith(".yaml") || rel.endsWith(".ts")) {
        files.push({ path: rel, text: await Deno.readTextFile(path) });
      }
    }
  }
  await collect("tests/fixtures/packs/crm-default-pack");
  const pack = await loadPackFromFiles(files);
  assertEquals(pack.namespace, "default");
  assertEquals(Object.keys(pack.resources).length, 12);
  assertEquals(Object.keys(pack.actions).length, 4);
  assertEquals(Object.keys(pack.hooks).length, 7);
});
