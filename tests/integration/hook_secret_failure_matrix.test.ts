// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

const CASES = [
  { name: "timeout", code: "hook_timeout" },
  { name: "invalid", code: "hook_invalid_output" },
  { name: "overflow", code: "hook_stdout_limit" },
  { name: "sandbox", code: "hook_failed" },
  { name: "environment", code: "hook_env_unavailable" },
  { name: "network", code: "hook_failed" },
] as const;

Deno.test({
  name:
    "compiled hooks fail closed across timeout output overflow env net and sandbox",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startAuthenticatedHarness();
    const pack = await Deno.makeTempDir({
      prefix: "optd-hook-failure-pack-",
    });
    try {
      await writeFailurePack(pack);
      const applied = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(applied.code, 0, applied.stderr);
      const project = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "hook-failure-matrix",
        "--display-name",
        "Hook Failure Matrix",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id;
      for (const item of CASES) {
        const before = await stageCount(harness);
        const result = await stage(harness, projectId, item.name);
        assertEquals(result.code, 1, result.stderr);
        assertEquals(JSON.parse(result.stderr).error.code, item.code);
        assertEquals(await stageCount(harness), before);
      }
      const retained = await stage(harness, projectId, "stderr");
      assertEquals(retained.code, 0, retained.stderr);
      const execution = JSON.parse(retained.stdout).data.hook_executions[0];
      assertEquals(execution.logs_truncated, true);
      assertEquals(execution.stderr.includes("[OPTD_LOG_TRUNCATED]"), true);
      assertEquals(
        execution.stderr.includes("failure-matrix-secret-prefix"),
        false,
      );
    } finally {
      await harness.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

function stage(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  projectId: string,
  name: string,
) {
  return harness.runJson(["--json", "changeset", "stage"], {
    project_id: projectId,
    operations: [{
      op: "create",
      resource: `test/failures:${name}`,
      fields: { name },
    }],
  });
}

async function stageCount(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
): Promise<string> {
  return (await query<{ count: string }>(
    harness.server.sql,
    "select count(*)::text count from staged_changesets",
  )).rows[0].count;
}

async function writeFailurePack(root: string): Promise<void> {
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: failures, version: 1.0.0 }\nspec: { purpose: Hook failure matrix., axi: {} }\n`,
  );
  for (const name of [...CASES.map((item) => item.name), "stderr"]) {
    await Deno.writeTextFile(
      `${root}/resources/${name}.yaml`,
      `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: ${name} }\nspec:\n  fields:\n    name: { type: string, required: true }\n  axi: {}\n`,
    );
  }
  const definitions = [
    {
      name: "timeout",
      timeout: "  timeout: 30ms\n",
      permissions: "net: false, env: false",
      script: `await new Promise(resolve=>setTimeout(resolve,10000));`,
    },
    {
      name: "invalid",
      timeout: "",
      permissions: "net: false, env: false",
      script:
        `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[],unknown:true}));`,
    },
    {
      name: "overflow",
      timeout: "",
      permissions: "net: false, env: false",
      script: `console.log("x".repeat(17*1024*1024));`,
    },
    {
      name: "sandbox",
      timeout: "",
      permissions: "net: false, env: false",
      script: `await Deno.readTextFile("/etc/passwd");`,
    },
    {
      name: "environment",
      timeout: "",
      permissions: "net: false, env: [SAFE_ENV]",
      script: `console.log(Deno.env.get("SAFE_ENV"));`,
    },
    {
      name: "network",
      timeout: "",
      permissions: "net: [127.0.0.1:9], env: false",
      script: `await fetch("http://127.0.0.1:10/denied");`,
    },
    {
      name: "stderr",
      timeout: "",
      permissions: "net: false, env: false",
      script:
        `console.error("z".repeat(5*1024*1024)); console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`,
    },
  ];
  for (const definition of definitions) {
    await Deno.writeTextFile(
      `${root}/hooks/${definition.name}.yaml`,
      `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: ${definition.name} }\nspec:\n  script: ${definition.name}.ts\n${definition.timeout}  permissions: { ${definition.permissions}, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: ${definition.name}, input: { proposed: '$proposed' } }\n  axi: {}\n`,
    );
    await Deno.writeTextFile(
      `${root}/hooks/${definition.name}.ts`,
      definition.script,
    );
  }
}
