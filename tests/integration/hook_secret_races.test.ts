// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
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
      const missingGrant = await stageItem(harness, projectId, "missing-grant");
      assertEquals(missingGrant.code, 1, missingGrant.stderr);
      assertEquals(
        JSON.parse(missingGrant.stderr).error.code,
        "hook_secret_unavailable",
      );
      assertEquals(provider.attempts.length, 0);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        "0",
      );

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
      const staged = await stageItem(harness, projectId, "proof");
      assertEquals(
        staged.code,
        0,
        `${staged.stderr}\n${(await harness.diagnostics()).server}`,
      );
      const stageData = JSON.parse(staged.stdout).data;
      assertEquals(stageData.hook_executions.length, 2);
      assertEquals(
        stageData.hook_executions[0].phase,
        "changeset.before_stage",
      );
      assertEquals(stageData.hook_executions[1].phase, "changeset.validate");
      assertEquals(
        stageData.hook_executions[0].output.patch_outputs[0].output.patches[0],
        { op: "add", path: "/normalized", value: true },
      );
      const guardExecution = stageData.hook_executions[1];
      assertEquals(guardExecution.grant_snapshot.grants.length, 1);
      assertEquals(
        Object.keys(guardExecution.authority_snapshot).sort(),
        [
          "assignment_digest",
          "auth_context_id",
          "policy_digest",
          "principal_id",
        ],
      );
      assertEquals(
        guardExecution.grant_snapshot.grants[0].grant_id,
        head.grant_id,
      );
      assert(!staged.stdout.includes("first-value"));
      assert(!staged.stdout.includes("rotation-"));
      assert(guardExecution.stderr.includes("[REDACTED_SECRET]"));
      const attempts = await provider.waitForAttempts(1);
      assertEquals(attempts.length, 1);
      assertEquals(attempts[0].path, "/validate");
      const superAssignment = (await query<{ id: string }>(
        harness.server.sql,
        `select assignment.id from role_assignments assignment
          join auth_contexts context on context.principal_id=assignment.principal_id
         where context.id=$1 and assignment.role_id='system:super_admin' and assignment.active`,
        [stageData.created_auth_context_id],
      )).rows[0].id;
      let releaseAuthority!: () => void;
      let authorityLocked!: () => void;
      const authorityLock = new Promise<void>((resolve) =>
        authorityLocked = resolve
      );
      const releaseAuthorityLock = new Promise<void>((resolve) =>
        releaseAuthority = resolve
      );
      const deactivation = harness.server.sql.begin(async (tx) => {
        await query(
          tx,
          "update role_assignments set active=false,disabled_at=now() where id=$1",
          [superAssignment],
        );
        authorityLocked();
        await releaseAuthorityLock;
      });
      await authorityLock;
      const preSpawnDenied = stageItem(harness, projectId, "pre-spawn-denied");
      await new Promise((resolve) => setTimeout(resolve, 100));
      assertEquals(provider.attempts.length, 1);
      releaseAuthority();
      await deactivation;
      const preSpawnResult = await preSpawnDenied;
      assertEquals(preSpawnResult.code, 1, preSpawnResult.stderr);
      assertEquals(provider.attempts.length, 1);
      await query(
        harness.server.sql,
        "update role_assignments set active=true,disabled_at=null where id=$1",
        [superAssignment],
      );

      provider.enqueue({
        kind: "delay",
        delayMs: 1_000,
        body: { allowed: true },
      });
      const finalRace = stageItem(harness, projectId, "final-recheck-denied");
      await provider.waitForAttemptsBefore(2, finalRace);
      await query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [superAssignment],
      );
      const finalRaceResult = await finalRace;
      assertEquals(finalRaceResult.code, 1, finalRaceResult.stderr);
      assertEquals(provider.attempts.length, 2);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        "1",
      );
      await query(
        harness.server.sql,
        "update role_assignments set active=true,disabled_at=null where id=$1",
        [superAssignment],
      );

      await query(
        harness.server.sql,
        `create function test_fail_trusted_stage_insert() returns trigger language plpgsql as $$
           begin raise exception 'injected trusted stage persistence failure'; end $$`,
      );
      await query(
        harness.server.sql,
        `create trigger test_fail_trusted_stage_insert before insert on staged_changesets
         for each row execute function test_fail_trusted_stage_insert()`,
      );
      provider.enqueue({ kind: "success", body: { allowed: true } });
      const persistenceFault = await stageItem(
        harness,
        projectId,
        "persistence-fault",
      );
      assertEquals(persistenceFault.code, 1, persistenceFault.stderr);
      assertEquals(provider.attempts.length, 3);
      assertEquals(
        (await query<{ count: string }>(
          harness.server.sql,
          "select count(*)::text count from staged_changesets",
        )).rows[0].count,
        "1",
      );
      await query(
        harness.server.sql,
        "drop trigger test_fail_trusted_stage_insert on staged_changesets",
      );
      await query(
        harness.server.sql,
        "drop function test_fail_trusted_stage_insert()",
      );
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
           join pack_component_revisions component
             on component.id=grant_row.hook_revision_id
           join pack_active_revisions active
             on active.candidate_revision_id=component.candidate_revision_id
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
        JSON.parse(futureStage.stdout).data.hook_executions.find((execution: {
          grant_snapshot: { grants: unknown[] };
        }) => execution.grant_snapshot.grants.length === 1).grant_snapshot
          .grants[0]
          .value_version,
        2,
      );

      provider.enqueue({
        kind: "delay",
        delayMs: 1_000,
        body: { allowed: true },
      });
      const pinnedInvocation = stageItem(harness, projectId, "pinned-version");
      await provider.waitForAttemptsBefore(5, pinnedInvocation);
      const rotatedDuringChild = await harness.runOptctl([
        "--json",
        "secret",
        "rotate",
        currentGrant.name,
        "--stdin",
      ], "post-snapshot-value\n");
      assertEquals(rotatedDuringChild.code, 0, rotatedDuringChild.stderr);
      const pinnedResult = await pinnedInvocation;
      assertEquals(pinnedResult.code, 0, pinnedResult.stderr);
      assertEquals(
        JSON.parse(pinnedResult.stdout).data.hook_executions.find((execution: {
          grant_snapshot: { grants: unknown[] };
        }) => execution.grant_snapshot.grants.length === 1).grant_snapshot
          .grants[0].value_version,
        2,
      );
      provider.enqueue({ kind: "success", body: { allowed: true } });
      const nextVersion = await stageItem(harness, projectId, "next-version");
      assertEquals(nextVersion.code, 0, nextVersion.stderr);
      assertEquals(
        JSON.parse(nextVersion.stdout).data.hook_executions.find((execution: {
          grant_snapshot: { grants: unknown[] };
        }) => execution.grant_snapshot.grants.length === 1).grant_snapshot
          .grants[0].value_version,
        3,
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
      const afterRevoke = await stageItem(harness, projectId, "revoked-grant");
      assertEquals(afterRevoke.code, 1, afterRevoke.stderr);
      assertEquals(
        JSON.parse(afterRevoke.stderr).error.code,
        "hook_secret_unavailable",
      );
      assertEquals(provider.attempts.length, 6);
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

      const ordinaryCases = [
        {
          username: "grant-dual",
          actions: ["secret.grant", "hook.secret.configure"],
          boundary: "system",
        },
        {
          username: "grant-secret-only",
          actions: ["secret.grant"],
          boundary: "system",
        },
        {
          username: "grant-hook-only",
          actions: ["hook.secret.configure"],
          boundary: "system",
        },
        {
          username: "grant-project-only",
          actions: ["secret.grant", "hook.secret.configure"],
          boundary: "project",
        },
      ] as const;
      const launchers = [];
      for (const ordinary of ordinaryCases) {
        const password = `${ordinary.username}-password-42!`;
        const createdUser = await harness.runOptctl([
          "--json",
          "auth",
          "user",
          "create",
          "--username",
          ordinary.username,
          "--password-stdin",
        ], `${password}\n`);
        assertEquals(createdUser.code, 0, createdUser.stderr);
        await installGrantCapabilities(
          harness,
          ordinary.username,
          [...ordinary.actions],
          ordinary.boundary,
          projectId,
        );
        const login = await harness.loginProcess({
          username: ordinary.username,
          password,
        });
        assertEquals(login.result.code, 0, login.result.stderr);
        launchers.push(login.launcher);
      }
      try {
        const ordinaryResults = [];
        for (const launcher of launchers) {
          ordinaryResults.push(
            await launcher.runOptctl([
              "--json",
              "secret",
              "grant",
              currentGrant.name,
              "--hook",
              "test/secrets:guard",
              "--slot",
              "token",
            ]),
          );
        }
        assertEquals(ordinaryResults[0].code, 0, ordinaryResults[0].stderr);
        for (const denied of ordinaryResults.slice(1)) {
          assertEquals(denied.code, 1, denied.stderr);
          assertEquals(
            JSON.parse(denied.stderr).error.code,
            "policy_denied",
          );
        }
      } finally {
        await Promise.all(launchers.map((launcher) => launcher.close()));
      }
      const ordinaryAudit = (await query<{ metadata: string }>(
        harness.server.sql,
        `select request_metadata_json::text metadata from audit_events
          where event_type='hook_secret_grant.created'
          order by created_at desc limit 1`,
      )).rows[0];
      const ordinaryMetadata = JSON.parse(ordinaryAudit.metadata);
      assertEquals(
        (typeof ordinaryMetadata === "string"
          ? JSON.parse(ordinaryMetadata)
          : ordinaryMetadata).super_admin_bypass,
        false,
      );

      const activeHead = (await query<{
        hook_revision_id: string;
        slot: string;
        secret_id: string;
        auth_context_id: string;
      }>(
        harness.server.sql,
        `select grant_row.hook_revision_id,grant_row.slot,grant_row.secret_id,
                grant_row.created_auth_context_id auth_context_id
           from hook_secret_grant_heads head
           join hook_secret_grants grant_row on grant_row.id=head.grant_id
           join pack_component_revisions component on component.id=grant_row.hook_revision_id
           join pack_active_revisions active
             on active.candidate_revision_id=component.candidate_revision_id`,
      )).rows[0];
      const mismatchedGrant = uuidV7();
      await query(
        harness.server.sql,
        `insert into hook_secret_grants(
           id,hook_revision_id,hook_security_digest,slot,secret_id,created_auth_context_id
         ) values($1,$2,$3,$4,$5,$6)`,
        [
          mismatchedGrant,
          activeHead.hook_revision_id,
          `sha256:${"f".repeat(64)}`,
          activeHead.slot,
          activeHead.secret_id,
          activeHead.auth_context_id,
        ],
      );
      await query(
        harness.server.sql,
        `update hook_secret_grant_heads set grant_id=$3
          where hook_revision_id=$1 and slot=$2`,
        [activeHead.hook_revision_id, activeHead.slot, mismatchedGrant],
      );
      const digestMismatch = await stageItem(
        harness,
        projectId,
        "digest-mismatch",
      );
      assertEquals(digestMismatch.code, 1, digestMismatch.stderr);
      assertEquals(
        JSON.parse(digestMismatch.stderr).error.code,
        "hook_secret_unavailable",
      );
      assertEquals(provider.attempts.length, 6);
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

function stageItem(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  projectId: string,
  name: string,
) {
  return harness.runJson(["--json", "changeset", "stage"], {
    project_id: projectId,
    operations: [{
      op: "create",
      project_id: projectId,
      resource: "test/secrets:item",
      fields: { name },
    }],
  });
}

async function installGrantCapabilities(
  harness: Awaited<ReturnType<typeof startAuthenticatedHarness>>,
  username: string,
  actions: string[],
  boundary: "system" | "project",
  projectId: string,
): Promise<void> {
  const identity =
    (await query<{ principal_id: string; auth_context_id: string }>(
      harness.server.sql,
      `select user_row.principal_id,
            (select id from auth_contexts order by created_at desc limit 1) auth_context_id
       from human_users user_row where user_row.username=$1`,
      [username],
    )).rows[0];
  const role = `test/grants:${username.replaceAll("-", "_")}`;
  const roleVersion = uuidV7();
  const policyVersion = uuidV7();
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      "insert into system_roles(id,display_name,active) values($1,$1,true)",
      [role],
    );
    await query(
      tx,
      "insert into role_definition_versions(id,role_id,version,active) values($1,$2,1,true)",
      [roleVersion, role],
    );
    await query(
      tx,
      "insert into policy_definition_versions(id,policy_id,version,active) values($1,$2,1,true)",
      [policyVersion, `${role}:policy`],
    );
    for (
      const action of [...actions, "secret.list", "pack.inspect_security"]
    ) {
      await query(
        tx,
        `insert into policy_rules(
           id,policy_definition_version_id,role_id,capability,resource,
           condition_kind,rule_name,relation_object_side,relation_subject_side
         ) values($1,$2,$3,$4,$5,'unconditional',$6,'from','to')`,
        [
          uuidV7(),
          policyVersion,
          role,
          action,
          action === "secret.list"
            ? "system:secret"
            : action === "pack.inspect_security"
            ? "*"
            : "system:hook-secret-grant",
          action.replaceAll(".", "_"),
        ],
      );
    }
    await query(
      tx,
      `insert into role_assignments(
         id,principal_id,role_id,boundary_type,project_id,active,created_by_auth_context_id
       ) values($1,$2,$3,$4,$5,true,$6)`,
      [
        uuidV7(),
        identity.principal_id,
        role,
        boundary,
        boundary === "project" ? projectId : null,
        identity.auth_context_id,
      ],
    );
    await query(
      tx,
      `insert into policy_assignments(
         id,policy_definition_version_id,boundary_type,project_id,active,source,
         created_by_auth_context_id
       ) values($1,$2,$3,$4,true,'operator',$5)`,
      [
        uuidV7(),
        policyVersion,
        boundary,
        boundary === "project" ? projectId : null,
        identity.auth_context_id,
      ],
    );
  });
}

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
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    name: { type: string, required: true }\n    normalized: { type: boolean }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/normalize.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: normalize }\nspec:\n  script: normalize.ts\n  permissions: { net: false, env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: patch.v1 }\n  attachments:\n    - { phase: changeset.before_stage, resource: item, order: 10, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/normalize.ts`,
    `console.log(JSON.stringify({patches:[{op:"add",path:"/normalized",value:true}]}));`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/guard.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: guard }\nspec:\n  script: guard.ts\n  permissions: { net: [${endpoint}], env: false, read: false, write: false, run: false }\n  secrets:\n    - { slot: token, env: TOKEN }\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: item, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/guard.ts`,
    `const input=JSON.parse(await new Response(Deno.stdin.readable).text()); const token=Deno.env.get("TOKEN"); const response=await fetch(${
      JSON.stringify(`${providerUrl}/validate`)
    }); const body=await response.json(); console.error(token); const curated=input.authority_snapshot===undefined&&input.grant_snapshot===undefined&&input.input.proposed.normalized===true; const allow=!!token&&body.allowed===true&&curated; console.log(JSON.stringify({allow,errors:allow?[]:[{path:"/",code:"missing",message:"missing"}],warnings:[],required_approvals:[]}));`,
  );
}
