import {
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { dirname, join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";

Deno.test("compiled pack preview persists inactive reusable candidates and distinct plans for both proof packs", async () => {
  const harness = await startLiveHarness();
  try {
    const bootstrap = await harness.bootstrap({
      username: "root",
      password: "strict pack preview password",
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);
    let crmCandidate = "";
    let firstPlan = "";
    for (
      const dir of [
        "prototypes/crm-default-pack",
        "prototypes/project-management-pack",
      ] as const
    ) {
      const preview = await harness.runOptctl([
        "--json",
        "pack",
        "preview",
        dir,
      ]);
      assertEquals(preview.code, 0, preview.stderr);
      const data = JSON.parse(preview.stdout).data;
      assertEquals(data.active, false);
      assertEquals(data.pack.active, false);
      assertEquals(data.plan.schema_version, "migration.plan.v1");
      assertEquals(data.plan.from_pack_revision_id, null);
      if (dir.includes("crm")) {
        crmCandidate = data.plan.to_pack_revision_id;
        firstPlan = data.plan.id;
      }
    }
    const repeated = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      "prototypes/crm-default-pack",
    ]);
    assertEquals(repeated.code, 0, repeated.stderr);
    const repeatedData = JSON.parse(repeated.stdout).data;
    assertEquals(repeatedData.candidate.reused, true);
    assertEquals(repeatedData.plan.to_pack_revision_id, crmCandidate);
    assertNotEquals(repeatedData.plan.id, firstPlan);
    const sqlPreview = await harness.runOptctl([
      "--json",
      "migration",
      "inspect",
      repeatedData.plan.id,
      "--sql",
    ]);
    assertEquals(sqlPreview.code, 0, sqlPreview.stderr);
    const statements = JSON.parse(sqlPreview.stdout).data
      .statements as string[];
    assertEquals(statements.length > 0, true);
    assertEquals(
      statements.some((statement) =>
        /^create table \"(?:res|rel)_/.test(statement)
      ),
      true,
    );
    assertEquals(
      statements.every((statement) => !statement.trimStart().startsWith("--")),
      true,
    );
    assertEquals(
      statements.every((statement) => !/\$[0-9]+/.test(statement)),
      true,
    );
    assertEquals(repeatedData.plan.dependency_graph.edges.length > 0, true);
    assertEquals(
      repeatedData.plan.dependency_graph.topological_order,
      repeatedData.plan.steps.map((step: { id: string }) => step.id),
    );
    const violations = await harness.runOptctl([
      "--json",
      "migration",
      "inspect",
      repeatedData.plan.id,
      "--violations",
    ]);
    assertEquals(violations.code, 0, violations.stderr);
    assertEquals(JSON.parse(violations.stdout).data, {
      migration_id: repeatedData.plan.id,
      blockers: [],
      hazards: [],
    });
    const validation = await harness.runOptctl([
      "--json",
      "migration",
      "validate",
      repeatedData.plan.id,
    ]);
    assertEquals(validation.code, 0, validation.stderr);
    assertEquals(JSON.parse(validation.stdout).data.status, "ready");
    assertEquals(JSON.parse(validation.stdout).data.confirmation_token, null);
    const metadata = await harness.runOptctl(["--json", "metadata", "packs"]);
    assertEquals(metadata.code, 0, metadata.stderr);
    assertEquals(JSON.parse(metadata.stdout).data.packs, []);
    const canonicalMetadata = await harness.runOptctl([
      "--json",
      "metadata",
      "resource",
      "optd/crm:lead",
    ]);
    assertEquals(canonicalMetadata.code, 1);
    assertEquals(JSON.parse(canonicalMetadata.stderr).error.code, "not_found");
    for (
      const legacy of [
        ["metadata", "resource", "default.lead"],
        ["metadata", "pack", "default.crm"],
      ]
    ) {
      const rejected = await harness.runOptctl(["--json", ...legacy]);
      assertEquals(rejected.code, 2);
      assertEquals(JSON.parse(rejected.stderr).error.code, "usage_error");
    }
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text as count from pack_active_revisions",
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text as count from pack_candidate_revisions",
      )).rows[0].count,
      "2",
    );

    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot().replace(
          "publisher: optd",
          "namespace: default",
        ),
      },
      "pack.yaml",
      "additional properties",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "type: string",
          "type: string, ref: default.company",
        ),
      },
      "resources/lead.yaml",
      "must match pattern",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "axi: {}",
          "unknown: true\n  axi: {}",
        ),
      },
      "resources/lead.yaml",
      "additional properties",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "name: {type: string, required: true}",
          "name: {type: string, required: true}\n    amount: {type: decimal, required: true}\n  constraints:\n    - {name: strict_lead_active_name, kind: unique, fields: [name], where: 'active()'}",
        ),
        "seeds/leads.yaml":
          `kind: Seed\napiVersion: optd.dev/v1\nmetadata: {name: leads}\nspec: {resource: lead, key: name, mode: changeset, rows: [{name: first, amount: 1.25}], axi: {}}\n`,
      },
      "seeds/leads.yaml",
      "only JSON safe integers",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "hooks/run.ts":
          `import value from "npm:forbidden";\nconsole.log(value);\n`,
      },
      "hooks/run.ts",
      "imports are not supported",
    );
    await assertMalformedPack(
      harness,
      { "pack.yaml": "!custom {kind: Pack}" },
      "pack.yaml",
      "custom YAML tags",
    );
    await assertMalformedPack(
      harness,
      { "pack.yaml": `${strictRoot()}\n---\nkind: Pack\n` },
      "pack.yaml",
      "exactly one YAML document",
    );
    await assertMalformedPack(
      harness,
      { "pack.yaml": strictRoot().replace("version: 0.1.0", "version: .inf") },
      "pack.yaml",
      "only JSON safe integers",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "type: string",
          "type: binary",
        ),
      },
      "resources/lead.yaml",
      "schema",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "axi: {}",
          "extensions: {}\n  axi: {}",
        ),
      },
      "resources/lead.yaml",
      "additional properties",
    );
    await assertMalformedPack(
      harness,
      {
        "pack.yaml": strictRoot(),
        "resources/lead.yaml": strictResource().replace(
          "name: {",
          "project_id: {",
        ),
      },
      "resources/lead.yaml",
      "reserved platform field",
    );
    const unknownDir = await Deno.makeTempDir({
      prefix: "optd-unknown-pack-",
    });
    try {
      await Deno.writeTextFile(`${unknownDir}/pack.yaml`, strictRoot());
      await Deno.mkdir(`${unknownDir}/extensions`);
      await Deno.writeTextFile(
        `${unknownDir}/extensions/legacy.yaml`,
        "kind: Extension\n",
      );
      const unknown = await harness.runOptctl([
        "--json",
        "pack",
        "preview",
        unknownDir,
      ]);
      assertNotEquals(unknown.code, 0);
      assertStringIncludes(unknown.stderr, "unexpected directory extensions");
    } finally {
      await Deno.remove(unknownDir, { recursive: true });
    }
    await assertMalformedMultipart(
      harness,
      "../pack.yaml",
      "invalid pack path ../pack.yaml",
    );
    await assertUnknownMultipartName(harness);
  } finally {
    await harness.close();
  }
});

function strictRoot() {
  return `kind: Pack\napiVersion: optd.dev/v1\nmetadata: {publisher: optd, name: malformed, version: 0.1.0}\nspec: {purpose: Malformed strict pack., axi: {}}\n`;
}
function strictResource() {
  return `kind: Resource\napiVersion: optd.dev/v1\nmetadata: {name: lead}\nspec:\n  fields:\n    name: {type: string, required: true}\n  axi: {}\n`;
}
async function assertMalformedPack(
  harness: LiveHarness,
  files: Record<string, string>,
  path: string,
  message: string,
) {
  const directory = await Deno.makeTempDir({
    prefix: "optd-malformed-pack-",
  });
  try {
    for (const [relative, content] of Object.entries(files)) {
      const target = join(directory, relative);
      await Deno.mkdir(dirname(target), { recursive: true });
      await Deno.writeTextFile(target, content);
    }
    const result = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      directory,
    ]);
    assertNotEquals(result.code, 0, `${path}: ${result.stdout}`);
    assertStringIncludes(result.stderr, path);
    assertStringIncludes(result.stderr, message);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
async function harnessToken(harness: LiveHarness): Promise<string> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "optd", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin].token;
}
async function assertMalformedMultipart(
  harness: LiveHarness,
  filename: string,
  expected: string,
) {
  const form = new FormData();
  form.append("file", new File([strictRoot()], filename));
  const response = await fetch(`${harness.baseUrl}/api/v1/packs/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${await harnessToken(harness)}` },
    body: form,
  });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.code, "bad_pack");
  assertStringIncludes(body.error.message, expected);
}
async function assertUnknownMultipartName(harness: LiveHarness) {
  const form = new FormData();
  form.append("manifest", new File([strictRoot()], "pack.yaml"));
  const response = await fetch(`${harness.baseUrl}/api/v1/packs/preview`, {
    method: "POST",
    headers: { authorization: `Bearer ${await harnessToken(harness)}` },
    body: form,
  });
  assertEquals(response.status, 400);
  const body = await response.json();
  assertEquals(body.error.code, "bad_pack");
  assertEquals(
    body.error.message,
    "multipart parts must be files named 'file'",
  );
}
