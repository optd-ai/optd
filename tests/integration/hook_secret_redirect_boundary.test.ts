// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";

Deno.test({
  name: "compiled stage rejects declared provider redirects before destination",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    let destinationAttempts = 0;
    let sourceAttempts = 0;
    const destinationController = new AbortController();
    const destination = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: destinationController.signal,
      onListen() {},
    }, () => {
      destinationAttempts++;
      return Response.json({ allowed: true });
    });
    const destinationAddress = destination.addr as Deno.NetAddr;
    const sourceController = new AbortController();
    const source = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: sourceController.signal,
      onListen() {},
    }, () => {
      sourceAttempts++;
      return new Response(null, {
        status: 302,
        headers: {
          location: `http://127.0.0.1:${destinationAddress.port}/destination`,
        },
      });
    });
    const sourceAddress = source.addr as Deno.NetAddr;
    const harness = await startAuthenticatedHarness();
    const pack = await Deno.makeTempDir({ prefix: "optd-redirect-pack-" });
    try {
      await writeRedirectPack(
        pack,
        sourceAddress.port,
        destinationAddress.port,
      );
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
        "redirect-boundary",
        "--display-name",
        "Redirect Boundary",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id;
      const before = (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from staged_changesets",
      )).rows[0].count;
      const staged = await harness.runJson([
        "--json",
        "changeset",
        "stage",
      ], {
        project_id: projectId,
        operations: [{
          op: "create",
          resource: "test/redirect:item",
          fields: { name: "redirect denied" },
        }],
      });
      assertEquals(staged.code, 1, staged.stderr);
      assertEquals(JSON.parse(staged.stderr).error.code, "hook_failed");
      assertEquals(sourceAttempts, 1);
      assertEquals(destinationAttempts, 0);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        before,
      );
    } finally {
      await harness.close();
      sourceController.abort();
      destinationController.abort();
      await Promise.all([
        source.finished.catch(() => undefined),
        destination.finished.catch(() => undefined),
      ]);
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

async function writeRedirectPack(
  root: string,
  sourcePort: number,
  destinationPort: number,
): Promise<void> {
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: redirect, version: 1.0.0 }\nspec: { purpose: Redirect boundary proof., axi: {} }\n`,
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    name: { type: string, required: true }\n  axi: {}\n`,
  );
  const endpoints = [
    `127.0.0.1:${sourcePort}`,
    `127.0.0.1:${destinationPort}`,
  ].sort();
  await Deno.writeTextFile(
    `${root}/hooks/redirect.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: redirect }\nspec:\n  script: redirect.ts\n  permissions: { net: [${
      endpoints.join(", ")
    }], env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: item, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/redirect.ts`,
    `await fetch("http://127.0.0.1:${sourcePort}/redirect", {redirect:"follow"}); console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[]}));`,
  );
}
