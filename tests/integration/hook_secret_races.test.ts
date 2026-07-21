// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "../support/authenticated_harness.ts";
import { startHttpProvider } from "../support/http_provider.ts";

Deno.test({
  name: "secret lifecycle and grant heads serialize concurrent mutations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const previousKey = Deno.env.get("OPERANT_SECRET_MASTER_KEY");
    Deno.env.set(
      "OPERANT_SECRET_MASTER_KEY",
      btoa(String.fromCharCode(...new Uint8Array(32).fill(19))),
    );
    const provider = startHttpProvider([{
      kind: "success",
      body: { allowed: true },
    }]);
    const harness = await startAuthenticatedHarness();
    const pack = await Deno.makeTempDir({
      prefix: "operant-hook-secret-pack-",
    });
    try {
      for (const legacyPath of ["/secrets", "/hook-secret-grants"]) {
        const legacy = await fetch(`${harness.baseUrl}${legacyPath}`);
        await legacy.body?.cancel();
        assertEquals(legacy.status, 404);
      }
      await writePack(pack, provider.url);
      const apply = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(apply.code, 0, apply.stderr);

      for (const name of ["first", "second", "third"]) {
        const created = await harness.runOptctl([
          "--json",
          "secret",
          "create",
          name,
          "--stdin",
        ], `${name}-value\n`);
        assertEquals(created.code, 0, created.stderr);
        assert(!created.stdout.includes(`${name}-value`));
      }
      const rotations = await harness.runConcurrent(
        Array.from({ length: 8 }, (_, index) => ({
          args: ["--json", "secret", "rotate", "first", "--stdin"],
          stdin: `rotation-${index}\n`,
        })),
      );
      assert(rotations.every((result) => result.code === 0));
      const rotated = (await query<{ value_version: string; status: string }>(
        harness.server.sql,
        "select value_version,status from platform_secrets where name='first'",
      )).rows[0];
      assertEquals(rotated, { value_version: "9", status: "active" });
      const ciphertextRows = await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from platform_secrets where name='first'",
      );
      assertEquals(ciphertextRows.rows[0].count, "1");

      const grantRace = await harness.runConcurrent([
        {
          args: [
            "--json",
            "secret",
            "grant",
            "first",
            "--hook",
            "test/secrets:guard",
            "--slot",
            "token",
          ],
        },
        {
          args: [
            "--json",
            "secret",
            "grant",
            "second",
            "--hook",
            "test/secrets:guard",
            "--slot",
            "token",
          ],
        },
      ]);
      assertEquals(
        grantRace.filter((result) => result.code === 0).length,
        1,
        JSON.stringify(grantRace),
      );
      assertEquals(grantRace.filter((result) => result.code !== 0).length, 1);
      const head = (await query<{ grant_id: string }>(
        harness.server.sql,
        "select grant_id from hook_secret_grant_heads",
      )).rows[0];
      assert(head?.grant_id);
      const project = await harness.runOptctl([
        "--json",
        "project",
        "create",
        "hook-secret-stage",
        "--display-name",
        "Hook Secret Stage",
      ]);
      assertEquals(project.code, 0, project.stderr);
      const projectId = JSON.parse(project.stdout).data.id as string;
      const staged = await harness.runJson([
        "--json",
        "changeset",
        "stage",
      ], {
        project_id: projectId,
        operations: [{
          op: "create",
          project_id: projectId,
          resource: "test/secrets:item",
          fields: { name: "proof" },
        }],
      });
      assertEquals(
        staged.code,
        0,
        `${staged.stderr}\n${(await harness.diagnostics()).server}`,
      );
      const stageData = JSON.parse(staged.stdout).data;
      assertEquals(stageData.hook_executions.length, 1);
      assertEquals(
        stageData.hook_executions[0].grant_snapshot.grants.length,
        1,
      );
      assertEquals(
        Object.keys(stageData.hook_executions[0].authority_snapshot).sort(),
        [
          "assignment_digest",
          "auth_context_id",
          "policy_digest",
          "principal_id",
        ],
      );
      assertEquals(
        stageData.hook_executions[0].grant_snapshot.grants[0].grant_id,
        head.grant_id,
      );
      assert(!staged.stdout.includes("first-value"));
      assert(!staged.stdout.includes("rotation-"));
      assert(stageData.hook_executions[0].stderr.includes("[REDACTED_SECRET]"));
      const attempts = await provider.waitForAttempts(1);
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].path, "/validate");
      const replacements = await harness.runConcurrent([
        {
          args: [
            "--json",
            "secret",
            "replace-grant",
            head.grant_id,
            "--secret",
            "second",
          ],
        },
        {
          args: [
            "--json",
            "secret",
            "replace-grant",
            head.grant_id,
            "--secret",
            "third",
          ],
        },
      ]);
      assertEquals(
        replacements.filter((result) => result.code === 0).length,
        1,
      );
      assertEquals(
        replacements.filter((result) => result.code !== 0).length,
        1,
      );
      const lineage = await query<
        { grants: string; heads: string; successors: string }
      >(
        harness.server.sql,
        `select count(*)::text grants,
                (select count(*)::text from hook_secret_grant_heads) heads,
                count(*) filter(where supersedes_grant_id is not null)::text successors
           from hook_secret_grants`,
      );
      assertEquals(lineage.rows[0], {
        grants: "2",
        heads: "1",
        successors: "1",
      });
      await Deno.writeTextFile(
        `${pack}/pack.yaml`,
        (await Deno.readTextFile(`${pack}/pack.yaml`)).replace(
          "1.0.0",
          "1.0.1",
        ),
      );
      const upgradedPack = await harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(upgradedPack.code, 0, upgradedPack.stderr);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          `select count(*)::text count from audit_events
            where event_type='hook_secret_grant.inherited'`,
        )).rows[0].count,
        "1",
      );
      const currentGrant = (await query<{ grant_id: string; name: string }>(
        harness.server.sql,
        `select head.grant_id,secret.name
           from hook_secret_grant_heads head
           join hook_secret_grants grant_row on grant_row.id=head.grant_id
           join platform_secrets secret on secret.id=grant_row.secret_id`,
      )).rows[0];
      await assertRejects(() =>
        query(
          harness.server.sql,
          "update hook_secret_grant_heads set slot='corrupt' where grant_id=$1",
          [currentGrant.grant_id],
        )
      );
      const lifecycleAudit = (await query<
        { event_type: string; metadata: string }
      >(
        harness.server.sql,
        `select event_type,request_metadata_json::text metadata from audit_events
          where resource='system:hook-secret-grant'
          order by created_at,event_type`,
      )).rows;
      assertEquals(
        lifecycleAudit.map((event) => event.event_type).sort(),
        [
          "hook_secret_grant.created",
          "hook_secret_grant.inherited",
          "hook_secret_grant.replaced",
        ],
      );
      for (const event of lifecycleAudit) {
        assert(event.metadata.includes("auth_context_id"));
        assert(event.metadata.includes("super_admin_bypass"));
        const decoded = JSON.parse(event.metadata);
        const metadata = typeof decoded === "string"
          ? JSON.parse(decoded)
          : decoded;
        assertEquals(metadata.super_admin_bypass, true);
        assert(!event.metadata.includes("-value"));
        assert(!event.metadata.includes("rotation-"));
      }
      const beforeDisabledStage = (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from staged_changesets",
      )).rows[0].count;
      const disabled = await harness.runOptctl([
        "--json",
        "secret",
        "disable",
        currentGrant.name,
      ]);
      assertEquals(disabled.code, 0, disabled.stderr);
      const unavailable = await harness.runJson([
        "--json",
        "changeset",
        "stage",
      ], {
        project_id: projectId,
        operations: [{
          op: "create",
          project_id: projectId,
          resource: "test/secrets:item",
          fields: { name: "disabled" },
        }],
      });
      assertEquals(unavailable.code, 1, unavailable.stderr);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        beforeDisabledStage,
      );
      const reenabled = await harness.runOptctl([
        "--json",
        "secret",
        "rotate",
        currentGrant.name,
        "--stdin",
      ], "reenabled-value\n");
      assertEquals(reenabled.code, 0, reenabled.stderr);
      provider.enqueue({ kind: "success", body: { allowed: true } });
      const futureStage = await harness.runJson([
        "--json",
        "changeset",
        "stage",
      ], {
        project_id: projectId,
        operations: [{
          op: "create",
          project_id: projectId,
          resource: "test/secrets:item",
          fields: { name: "reenabled" },
        }],
      });
      assertEquals(futureStage.code, 0, futureStage.stderr);
      assertEquals(
        JSON.parse(futureStage.stdout).data.hook_executions[0].grant_snapshot
          .grants[0].value_version,
        2,
      );
      const revoke = await harness.runOptctl([
        "--json",
        "secret",
        "revoke-grant",
        currentGrant.grant_id,
      ]);
      assertEquals(revoke.code, 0, revoke.stderr);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from hook_secret_grant_heads",
        )).rows[0].count,
        "1",
      );
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from hook_secret_grant_revocations",
        )).rows[0].count,
        "1",
      );
      await assertRejects(() =>
        query(
          harness.server.sql,
          "update hook_secret_grants set slot=slot where id=$1",
          [currentGrant.grant_id],
        )
      );
      await assertRejects(() =>
        query(
          harness.server.sql,
          "delete from hook_secret_grant_revocations where grant_id=$1",
          [currentGrant.grant_id],
        )
      );
      const audit = (await query<{ id: string; metadata: string }>(
        harness.server.sql,
        `select id,request_metadata_json::text metadata from audit_events
          where object_id=$1 and event_type='hook_secret_grant.revoked'`,
        [currentGrant.grant_id],
      )).rows[0];
      assert(audit);
      assert(audit.metadata.includes("auth_context_id"));
      assert(audit.metadata.includes("super_admin_bypass"));
      assert(!audit.metadata.includes("reenabled-value"));
      await assertRejects(() =>
        query(harness.server.sql, "delete from audit_events where id=$1", [
          audit.id,
        ])
      );
      const leaked = await query<{ leaked: boolean }>(
        harness.server.sql,
        `select exists(
           select 1 from platform_secrets
            where encode(ciphertext,'escape') like '%rotation-%'
               or encode(ciphertext,'escape') like '%-value%'
         ) leaked`,
      );
      assertEquals(leaked.rows[0].leaked, false);
    } finally {
      await harness.close();
      await provider.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
      if (previousKey === undefined) {
        Deno.env.delete("OPERANT_SECRET_MASTER_KEY");
      } else Deno.env.set("OPERANT_SECRET_MASTER_KEY", previousKey);
    }
  },
});

async function writePack(root: string, providerUrl: string): Promise<void> {
  const provider = new URL(providerUrl);
  const endpoint = `${provider.hostname}:${provider.port}`;
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: secrets, version: 1.0.0 }\nspec: { purpose: Secret race proof., axi: {} }\n`,
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    name: { type: string, required: true }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/guard.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: guard }\nspec:\n  script: guard.ts\n  permissions: { net: [${endpoint}], env: false, read: false, write: false, run: false }\n  secrets:\n    - { slot: token, env: TOKEN }\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: item, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/guard.ts`,
    `const input=JSON.parse(await new Response(Deno.stdin.readable).text()); const token=Deno.env.get("TOKEN"); const response=await fetch(${
      JSON.stringify(`${providerUrl}/validate`)
    }); const body=await response.json(); console.error(token); const curated=input.authority_snapshot===undefined&&input.grant_snapshot===undefined; const allow=!!token&&body.allowed===true&&curated; console.log(JSON.stringify({allow,errors:allow?[]:[{path:"/",code:"missing",message:"missing"}],warnings:[],required_approvals:[]}));`,
  );
}
