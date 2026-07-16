import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";

const root = `kind: Pack
apiVersion: operant.dev/v1
metadata: { publisher: operant, name: test, version: 0.1.0 }
spec: { purpose: Strict test pack., axi: {} }
`;
const resource = `kind: Resource
apiVersion: operant.dev/v1
metadata: { name: lead }
spec:
  fields:
    name: { type: string, required: true }
  axi: {}
`;

Deno.test("strict pack loader rejects legacy identities and unknown fields", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: root.replace("publisher: operant", "namespace: default"),
      }]),
    Error,
    "additional properties",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("axi: {}", "lifecycle: {}\n  axi: {}"),
      }]),
    Error,
    "additional properties",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "type: string",
          "type: string, ref: default.company",
        ),
      }]),
    Error,
    "must match pattern",
  );
});

Deno.test("strict pack loader rejects paths, filenames, YAML tags and documents", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/contact.yaml",
        text: resource,
      }]),
    Error,
    "must match basename",
  );
  await assertRejects(
    () => loadPackFromFiles([{ path: "../pack.yaml", text: root }]),
    Error,
    "invalid pack path",
  );
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
  await assertRejects(
    () => loadPackFromFiles([{ path: "pack.yaml", text: "1: value" }]),
    Error,
    "mapping keys must be strings",
  );
});

Deno.test("strict pack loader rejects numeric decimal seed values", async () => {
  const decimalResource = resource.replace(
    "name: { type: string, required: true }",
    "name: { type: string, required: true, unique: true }\n    amount: { type: decimal, required: true }",
  );
  const seed =
    `kind: Seed\napiVersion: operant.dev/v1\nmetadata: {name: leads}\nspec:\n  resource: lead\n  key: name\n  mode: changeset\n  rows: [{name: first, amount: 1.25}]\n  axi: {}\n`;
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/lead.yaml", text: decimalResource },
        { path: "seeds/leads.yaml", text: seed },
      ]),
    Error,
    "only JSON safe integers",
  );
});

Deno.test("strict pack loader canonicalizes bounded YAML aliases", async () => {
  const merged = resource.replace(
    "name: { type: string, required: true }",
    "name: &field { type: string, required: true }\n    code:\n      <<: *field",
  );
  const pack = await loadPackFromFiles([{ path: "pack.yaml", text: root }, {
    path: "resources/lead.yaml",
    text: merged,
  }]);
  assertEquals(pack.resources.lead.spec.fields, {
    code: { required: true, type: "string" },
    name: { required: true, type: "string" },
  });
  assert(pack.revision.startsWith("operant/test@0.1.0:sha256:"));
});

Deno.test("strict pack loader accepts both publisher-qualified proof packs", async () => {
  for (
    const [dir, expected] of [["prototypes/crm-default-pack", "operant/crm"], [
      "prototypes/project-management-pack",
      "operant/projects",
    ]] as const
  ) {
    const files: UploadedPackFile[] = [];
    async function collect(path: string, prefix = "") {
      for await (const entry of Deno.readDir(path)) {
        const child = `${path}/${entry.name}`;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) await collect(child, relative);
        else if (/\.(?:yaml|ts)$/.test(relative)) {
          files.push({ path: relative, text: await Deno.readTextFile(child) });
        }
      }
    }
    await collect(dir);
    const pack = await loadPackFromFiles(files);
    assertEquals(`${pack.publisher}/${pack.name}`, expected);
    assert(Object.keys(pack.roles).length > 0);
    assert(
      Object.values(pack.resources).every((definition) =>
        definition.identity.startsWith(`${expected}:`)
      ),
    );
  }
});
