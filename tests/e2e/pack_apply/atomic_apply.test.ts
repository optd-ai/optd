// deno-lint-ignore-file no-import-prefix no-unversioned-import no-explicit-any
import { assert, assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import {
  type CliResult,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { opaqueToken, tokenDigest } from "../../../src/domain/auth/token.ts";
import { parseYamlJsonObject } from "../../../src/adapters/outbound/yaml/pack_loader.ts";

Deno.test("compiled optctl completes safe, destructive, stale, timeout, risky, and global apply flows", async () => {
  const harness = await startLiveHarness();
  const secrets: string[] = [];
  try {
    const rootPassword = "atomic pack apply root password";
    const bootstrap = await harness.bootstrap({
      username: "root",
      password: rootPassword,
    });
    assertEquals(bootstrap.code, 0, bootstrap.stderr);

    const acknowledgementPlan = await preview(
      harness,
      "prototypes/crm-default-pack",
    );
    await validateReady(harness, acknowledgementPlan.id, null);
    await expectError(
      harness,
      ["migration", "apply", acknowledgementPlan.id, "--reviewed"],
      "migration_acknowledgement_invalid",
      secrets,
    );
    const initialApply = await runOk(harness, [
      "pack",
      "apply",
      "prototypes/crm-default-pack",
      "--safe",
    ], secrets);
    const initial = initialApply.data.plan;
    assertEquals(initialApply.data.validation.status, "ready");
    assert(initialApply.data.application.id);
    const repeated = await runOk(harness, [
      "migration",
      "apply",
      initial.id,
      "--safe",
    ], secrets);
    assertEquals(repeated.data, initialApply.data.application);

    const projectsApply = await runOk(
      harness,
      [
        "pack",
        "apply",
        "prototypes/project-management-pack",
        "--safe",
      ],
      secrets,
    );
    assert(projectsApply.data.application.id);
    const projectsMetadata = await runOk(
      harness,
      ["metadata", "pack", "operant/projects"],
      secrets,
    );
    assertEquals(projectsMetadata.data.axi_readiness, {
      ready: true,
      missing_guidance: [],
    });
    assertEquals(projectsMetadata.data.resources.includes("task"), true);
    const aggregatedHome = await runOk(harness, ["home"], secrets);
    assertEquals(aggregatedHome.data.system.active_packs, [
      "operant/crm@0.1.0",
      "operant/projects@0.1.0",
    ]);

    for (const slug of ["alpha", "beta"]) {
      await runOk(
        harness,
        ["project", "create", slug, "--display-name", slug],
        secrets,
      );
    }

    const destructiveDir = join(harness.rootDir, "crm-destructive");
    await copyPack("prototypes/crm-default-pack", destructiveDir);
    await setVersion(destructiveDir, "0.2.0");
    const leadPath = join(destructiveDir, "resources", "lead.yaml");
    const lead = parseYamlJsonObject(
      await Deno.readTextFile(leadPath),
      leadPath,
    ) as Record<string, any>;
    delete lead.spec.fields.phone;
    lead.spec.axi.list.defaultFields = lead.spec.axi.list.defaultFields.filter((
      field: string,
    ) => field !== "phone");
    await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));
    const actionPath = join(destructiveDir, "actions", "convert_lead.yaml");
    const action = parseYamlJsonObject(
      await Deno.readTextFile(actionPath),
      actionPath,
    ) as Record<string, any>;
    action.spec.reads.lead.fields = action.spec.reads.lead.fields.filter((
      field: string,
    ) => field !== "phone");
    await Deno.writeTextFile(actionPath, JSON.stringify(action, null, 2));

    const destructiveStart = await runOk(
      harness,
      ["pack", "apply", destructiveDir],
      secrets,
    );
    const destructiveA = destructiveStart.data.plan;
    assertEquals(destructiveA.class, "destructive");
    assertEquals(destructiveStart.data.application, null);
    assertEquals(
      destructiveStart.data.next_command,
      `optctl migration apply ${destructiveA.id} --confirm-token <token>`,
    );
    const token1 = destructiveStart.data.validation
      .confirmation_token as string;
    assert(typeof token1 === "string" && token1.length === 43);
    secrets.push(token1);
    await expectError(
      harness,
      ["migration", "apply", destructiveA.id, "--confirm-token", "wrong-token"],
      "migration_confirmation_invalid",
      secrets,
    );
    await query(
      harness.server.sql,
      "update pack_migration_confirmation_tokens set expires_at=now()-interval '1 second' where plan_id=$1 and consumed_at is null",
      [destructiveA.id],
    );
    await expectError(
      harness,
      ["migration", "apply", destructiveA.id, "--confirm-token", token1],
      "migration_confirmation_invalid",
      secrets,
    );

    const token2 = await validateToken(harness, destructiveA.id);
    secrets.push(token2);
    const otherPassword = "atomic pack apply other password";
    const created = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "other",
      "--display-name",
      "Other",
      "--password-stdin",
    ], `${otherPassword}\n`);
    assertEquals(created.code, 0, created.stderr);
    const otherPrincipal = (await query<{ principal_id: string }>(
      harness.server.sql,
      "select principal_id::text principal_id from human_users where username='other'",
    )).rows[0].principal_id;
    await query(
      harness.server.sql,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:super_admin','system',true)",
      [uuidV7(), otherPrincipal],
    );
    assertEquals(
      (await harness.login({ username: "other", password: otherPassword }))
        .code,
      0,
    );
    await expectError(
      harness,
      ["migration", "apply", destructiveA.id, "--confirm-token", token2],
      "migration_confirmation_invalid",
      secrets,
    );
    assertEquals(
      (await harness.login({ username: "root", password: rootPassword })).code,
      0,
    );

    const agentPrincipal = uuidV7();
    const agentUser = uuidV7();
    const rootOne = uuidV7();
    const rootTwo = uuidV7();
    await query(
      harness.server.sql,
      "insert into principals(id,type,active) values($1,'agent_user',true)",
      [agentPrincipal],
    );
    await query(
      harness.server.sql,
      "insert into agent_users(id,principal_id,human_user_id,name) select $1,$2,id,'root-binding-agent' from human_users where username='root'",
      [agentUser, agentPrincipal],
    );
    for (const authorizationId of [rootOne, rootTwo]) {
      await query(
        harness.server.sql,
        `insert into agent_authorizations(
           id,agent_user_id,human_user_id,parent_authorization_id,
           root_authorization_id,approved_by_auth_context_id)
         select $1,$2,h.id,null,$1,c.id from human_users h
         join auth_contexts c on c.human_user_id=h.id
         where h.username='root' order by c.created_at desc limit 1`,
        [authorizationId, agentUser],
      );
      await query(
        harness.server.sql,
        "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type) values($1,$2,'system:super_admin','system')",
        [uuidV7(), authorizationId],
      );
    }
    const rootTokens: string[] = [];
    for (const authorizationId of [rootOne, rootTwo]) {
      const value = opaqueToken();
      rootTokens.push(value);
      await query(
        harness.server.sql,
        `insert into auth_sessions(
           id,principal_id,human_user_id,credential_kind,token_digest,authorization_id)
         select $1,$2,h.id,'agent_authorization',$3,$4 from human_users h where h.username='root'`,
        [uuidV7(), agentPrincipal, await tokenDigest(value), authorizationId],
      );
    }
    const rootBoundValidation = await fetch(
      `${harness.baseUrl}/api/v1/migrations/${destructiveA.id}/validate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rootTokens[0]}`,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assertEquals(rootBoundValidation.status, 200);
    const rootBoundToken = (await rootBoundValidation.json()).data
      .confirmation_token as string;
    secrets.push(rootBoundToken);
    const crossRootApply = await fetch(
      `${harness.baseUrl}/api/v1/migrations/${destructiveA.id}/apply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${rootTokens[1]}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          acknowledgement: "destructive",
          confirmation_token: rootBoundToken,
        }),
      },
    );
    assertEquals(
      (await crossRootApply.json()).error.code,
      "migration_confirmation_invalid",
    );
    assertEquals(
      (await harness.login({ username: "root", password: rootPassword })).code,
      0,
    );

    const noopDir = join(harness.rootDir, "crm-noop");
    await copyPack("prototypes/crm-default-pack", noopDir);
    await setVersion(noopDir, "0.1.1");
    const noop = await preview(harness, noopDir);
    assertEquals(noop.class, "safe");
    const safeTokenRejected = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      noop.id,
      "--safe",
      "--confirm-token",
      token2,
    ]);
    assertEquals(safeTokenRejected.code, 2);
    assertEquals(
      JSON.parse(safeTokenRejected.stderr).error.code,
      "usage_error",
    );
    assertNoSecrets(safeTokenRejected, secrets);
    await validateReady(harness, noop.id, null);
    await runOk(harness, ["migration", "apply", noop.id, "--safe"], secrets);
    await expectError(
      harness,
      ["migration", "apply", destructiveA.id, "--confirm-token", token2],
      "migration_stale",
      secrets,
    );

    const destructiveB = await preview(harness, destructiveDir);
    const token3 = await validateToken(harness, destructiveB.id);
    secrets.push(token3);
    const leadTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    const projectId = (await query<{ id: string }>(
      harness.server.sql,
      "select id::text id from projects where slug='alpha'",
    )).rows[0].id;
    const rootAuthContext = (await query<{ id: string }>(
      harness.server.sql,
      `select c.id::text id from auth_contexts c
       join human_users h on h.id=c.human_user_id
       where h.username='root' order by c.created_at desc,c.id desc limit 1`,
    )).rows[0].id;
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        `select count(*)::text count from projects p
         join auth_contexts c on c.id=$2 where p.id=$1`,
        [projectId, rootAuthContext],
      )).rows[0].count,
      "1",
    );
    const rowId = uuidV7();
    await query(
      harness.server.sql,
      `insert into "${leadTable}"(id,project_id,created_by,updated_by,name,status,phone) values($1,$2,$3,$3,'Fact changed','new','555')`,
      [rowId, projectId, rootAuthContext],
    );
    await expectError(
      harness,
      ["migration", "apply", destructiveB.id, "--confirm-token", token3],
      "migration_blocked",
      secrets,
    );
    await query(harness.server.sql, `delete from "${leadTable}" where id=$1`, [
      rowId,
    ]);
    const token4 = await validateToken(harness, destructiveB.id);
    secrets.push(token4);
    await expectError(
      harness,
      ["migration", "apply", destructiveB.id, "--reviewed"],
      "migration_acknowledgement_invalid",
      secrets,
    );
    await runOk(harness, [
      "migration",
      "apply",
      destructiveB.id,
      "--confirm-token",
      token4,
    ], secrets);

    const riskyDir = join(harness.rootDir, "crm-risky");
    await copyPack(destructiveDir, riskyDir);
    await setVersion(riskyDir, "0.3.0");
    const hookPath = await firstFile(join(riskyDir, "hooks"), ".yaml");
    const hook = parseYamlJsonObject(
      await Deno.readTextFile(hookPath),
      hookPath,
    ) as Record<string, any>;
    hook.spec.timeout = "3s";
    await Deno.writeTextFile(hookPath, JSON.stringify(hook, null, 2));
    const risky = await preview(harness, riskyDir);
    assertEquals(risky.class, "risky");
    await validateReady(harness, risky.id, null);
    const riskyTokenRejected = await harness.runOptctl([
      "--json",
      "migration",
      "apply",
      risky.id,
      "--reviewed",
      "--confirm-token",
      token4,
    ]);
    assertEquals(riskyTokenRejected.code, 2);
    assertEquals(
      JSON.parse(riskyTokenRejected.stderr).error.code,
      "usage_error",
    );
    assertNoSecrets(riskyTokenRejected, secrets);

    const lockedTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' order by case definition_kind when 'resource' then 0 else 1 end,definition_name,table_name limit 1",
    )).rows[0].table_name;
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = harness.server.sql.begin(async (tx) => {
      await query(tx, `lock table "${lockedTable}" in row exclusive mode`);
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    await expectError(
      harness,
      ["migration", "apply", risky.id, "--reviewed", "--timeout", "1ms"],
      "pack_install_busy",
      secrets,
    );
    release.resolve();
    await blocker;
    await runOk(harness, [
      "migration",
      "apply",
      risky.id,
      "--reviewed",
      "--timeout",
      "10s",
    ], secrets);

    const riskyPackDir = join(harness.rootDir, "crm-risky-pack-apply");
    await copyPack(riskyDir, riskyPackDir);
    await setVersion(riskyPackDir, "0.3.1");
    const riskyHookPath = await firstFile(join(riskyPackDir, "hooks"), ".yaml");
    const riskyHook = parseYamlJsonObject(
      await Deno.readTextFile(riskyHookPath),
      riskyHookPath,
    ) as Record<string, any>;
    riskyHook.spec.timeout = "4s";
    await Deno.writeTextFile(
      riskyHookPath,
      JSON.stringify(riskyHook, null, 2),
    );
    const riskyPackApply = await runOk(
      harness,
      ["pack", "apply", riskyPackDir, "--reviewed", "--timeout", "10s"],
      secrets,
    );
    assertEquals(riskyPackApply.data.plan.class, "risky");
    assertEquals(riskyPackApply.data.validation.status, "ready");
    assert(riskyPackApply.data.application.id);

    const stalePackDir = join(harness.rootDir, "crm-stale-pack-apply");
    await copyPack(riskyPackDir, stalePackDir);
    await setVersion(stalePackDir, "0.3.2");
    const staleHookPath = await firstFile(join(stalePackDir, "hooks"), ".yaml");
    const staleHook = parseYamlJsonObject(
      await Deno.readTextFile(staleHookPath),
      staleHookPath,
    ) as Record<string, any>;
    staleHook.spec.timeout = "5s";
    await Deno.writeTextFile(staleHookPath, JSON.stringify(staleHook, null, 2));
    const staleLockHeld = Promise.withResolvers<void>();
    const releaseStaleLock = Promise.withResolvers<void>();
    const staleBlocker = harness.server.sql.begin(async (tx) => {
      await query(tx, `lock table "${lockedTable}" in row exclusive mode`);
      staleLockHeld.resolve();
      await releaseStaleLock.promise;
    });
    await staleLockHeld.promise;
    const stalePackApply = harness.runOptctl([
      "--json",
      "pack",
      "apply",
      stalePackDir,
      "--reviewed",
    ]);
    try {
      await waitForPackApplyLock(harness);
      await query(
        harness.server.sql,
        "update pack_active_revisions set candidate_revision_id=$1,activated_at=now() where publisher='operant' and pack_name='crm'",
        [initial.to_pack_revision_id],
      );
    } finally {
      releaseStaleLock.resolve();
      await staleBlocker;
    }
    const stalePackResult = await stalePackApply;
    assertEquals(stalePackResult.code, 1, stalePackResult.stderr);
    assertEquals(
      JSON.parse(stalePackResult.stderr).error.code,
      "migration_stale",
    );
    assertNoSecrets(stalePackResult, secrets);
    await query(
      harness.server.sql,
      "update pack_active_revisions set candidate_revision_id=$1,activated_at=now() where publisher='operant' and pack_name='crm'",
      [riskyPackApply.data.plan.to_pack_revision_id],
    );

    for (const slug of ["alpha", "beta"]) {
      await runOk(harness, ["project", "select", slug], secrets);
      const metadata = await runOk(harness, [
        "metadata",
        "resource",
        "operant/crm:lead",
      ], secrets);
      assertEquals(metadata.data.schema.fields.phone, undefined);
    }
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from pack_migration_applications",
      )).rows[0].count,
      "6",
    );
    assertEquals(
      (await query<{ leaked: boolean }>(
        harness.server.sql,
        "select exists(select 1 from pack_migration_confirmation_tokens where length(token_digest)<>64) leaked",
      )).rows[0].leaked,
      false,
    );
    const failures = await query<
      { attempts: string; audits: string; redacted: boolean }
    >(
      harness.server.sql,
      `select
         (select count(*)::text from pack_migration_attempts) attempts,
         (select count(*)::text from pack_migration_audit_events where decision='denied') audits,
         not exists(select 1 from pack_migration_audit_events where decision='denied' and (details - 'error_code') <> '{}'::jsonb) redacted`,
    );
    assertEquals(failures.rows[0].audits, failures.rows[0].attempts);
    assertEquals(failures.rows[0].redacted, true);
  } finally {
    await harness.close();
  }
});

async function preview(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  dir: string,
) {
  return (await runOk(harness, ["pack", "preview", dir], [])).data.plan;
}

async function validateReady(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  id: string,
  token: string | null,
) {
  const data =
    (await runOk(harness, ["migration", "validate", id], token ? [token] : []))
      .data;
  assertEquals(data.status, "ready");
  assertEquals(data.confirmation_token, token);
  return data;
}

async function validateToken(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  id: string,
) {
  const result = await harness.runOptctl([
    "--json",
    "migration",
    "validate",
    id,
  ]);
  assertEquals(result.code, 0, result.stderr);
  const token = JSON.parse(result.stdout).data.confirmation_token;
  assert(typeof token === "string" && token.length === 43);
  assertEquals(result.stderr, "");
  return token;
}

async function runOk(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  args: string[],
  secrets: string[],
) {
  const result = await harness.runOptctl(["--json", ...args]);
  assertEquals(result.code, 0, result.stderr);
  assertNoSecrets(result, secrets);
  return JSON.parse(result.stdout);
}

async function expectError(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  args: string[],
  code: string,
  secrets: string[],
) {
  const result = await harness.runOptctl(["--json", ...args]);
  assertEquals(result.code, 1, result.stderr);
  assertEquals(JSON.parse(result.stderr).error.code, code);
  assertEquals(result.stdout, "");
  assertNoSecrets(result, secrets);
}

function assertNoSecrets(result: CliResult, secrets: string[]) {
  const output = `${result.stdout}\n${result.stderr}`;
  for (const secret of secrets) assertEquals(output.includes(secret), false);
  assertEquals(/bearer\s+[a-z0-9._~-]+/i.test(output), false);
}

async function waitForPackApplyLock(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
) {
  for (let attempt = 0; attempt < 3_000; attempt++) {
    const waiting = await query<{ waiting: boolean }>(
      harness.server.sql,
      `select exists(
         select 1 from pg_stat_activity
          where pid <> pg_backend_pid()
            and cardinality(pg_blocking_pids(pid)) > 0
            and query like 'lock table %share row exclusive mode%'
       ) waiting`,
    );
    if (waiting.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("compiled pack apply did not reach the runtime lock barrier");
}

async function copyPack(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const source = join(from, entry.name), destination = join(to, entry.name);
    if (entry.isDirectory) await copyPack(source, destination);
    else await Deno.copyFile(source, destination);
  }
}

async function setVersion(dir: string, version: string) {
  const path = join(dir, "pack.yaml");
  const document = parseYamlJsonObject(
    await Deno.readTextFile(path),
    path,
  ) as Record<string, any>;
  document.metadata.version = version;
  await Deno.writeTextFile(path, JSON.stringify(document, null, 2));
}

async function firstFile(dir: string, suffix: string) {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.isFile && entry.name.endsWith(suffix)) {
      return join(dir, entry.name);
    }
  }
  throw new Error(`no ${suffix} file in ${dir}`);
}
