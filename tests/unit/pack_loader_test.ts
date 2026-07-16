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

Deno.test("strict pack loader broadly rejects superseded schema and unsafe source forms", async () => {
  const cases: Array<{
    name: string;
    files: UploadedPackFile[];
    message: string;
  }> = [
    {
      name: "missing apiVersion",
      files: [{
        path: "pack.yaml",
        text: root.replace("apiVersion: operant.dev/v1\n", ""),
      }],
      message: "apiVersion",
    },
    {
      name: "child namespace alias",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "metadata: { name: lead }",
          "metadata: { name: lead, namespace: default }",
        ),
      }],
      message: "additional properties",
    },
    {
      name: "field defaults",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "required: true",
          "required: true, default: legacy",
        ),
      }],
      message: "additional properties",
    },
    {
      name: "extension bags",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("axi: {}", "extensions: {}\n  axi: {}"),
      }],
      message: "additional properties",
    },
    {
      name: "inline action hook and array input",
      files: [{ path: "pack.yaml", text: root }, {
        path: "actions/run.yaml",
        text:
          `kind: Action\napiVersion: operant.dev/v1\nmetadata: {name: run}\nspec: {hook: run, input: [id], axi: {}}\n`,
      }],
      message: "additional properties",
    },
    {
      name: "policy allow alias",
      files: [{ path: "pack.yaml", text: root }, {
        path: "policies/access.yaml",
        text:
          `kind: Policy\napiVersion: operant.dev/v1\nmetadata: {name: access}\nspec: {rules: [{role: admin, allow: ['*']}], axi: {}}\n`,
      }],
      message: "default_assignment",
    },
    {
      name: "relationship endpoint fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "relationships/link.yaml",
        text:
          `kind: Relationship\napiVersion: operant.dev/v1\nmetadata: {name: link}\nspec: {from: {resource: lead, field: id}, to: {resource: lead}, axi: {}}\n`,
      }],
      message: "additional properties",
    },
    {
      name: "binary fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("type: string", "type: binary"),
      }],
      message: "schema",
    },
    {
      name: "reserved platform fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("name: {", "project_id: {"),
      }],
      message: "reserved platform field",
    },
    {
      name: "unknown layout",
      files: [{ path: "pack.yaml", text: root }, {
        path: "docs/readme.yaml",
        text: "kind: Docs",
      }],
      message: "unexpected pack path",
    },
    {
      name: "hook imports",
      files: [{ path: "pack.yaml", text: root }, {
        path: "hooks/run.ts",
        kind: "script",
        text: `await import("npm:x");\n`,
      }],
      message: "imports are not supported",
    },
    {
      name: "duplicate mapping keys",
      files: [{
        path: "pack.yaml",
        text: root.replace("kind: Pack", "kind: Pack\nkind: Pack"),
      }],
      message: "Map keys must be unique",
    },
    {
      name: "non-finite YAML numbers",
      files: [{
        path: "pack.yaml",
        text: root.replace("version: 0.1.0", "version: .inf"),
      }],
      message: "only JSON safe integers",
    },
    {
      name: "duplicate uploaded paths",
      files: [{ path: "pack.yaml", text: root }, {
        path: "pack.yaml",
        text: root,
      }],
      message: "duplicate pack path",
    },
    {
      name: "backslash paths",
      files: [{ path: "resources\\lead.yaml", text: resource }],
      message: "invalid pack path",
    },
  ];
  for (const testCase of cases) {
    await assertRejects(
      () => loadPackFromFiles(testCase.files),
      Error,
      testCase.message,
      testCase.name,
    );
  }
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
