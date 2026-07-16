import { assert, assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import {
  type CliResult,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
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

    const initial = await preview(harness, "prototypes/crm-default-pack");
    await validateReady(harness, initial.id, null);
    await expectError(
      harness,
      ["migration", "apply", initial.id, "--reviewed"],
      "migration_acknowledgement_invalid",
      secrets,
    );
    const initialApply = await runOk(harness, [
      "migration",
      "apply",
      initial.id,
      "--safe",
    ], secrets);
    const repeated = await runOk(harness, [
      "migration",
      "apply",
      initial.id,
      "--safe",
    ], secrets);
    assertEquals(repeated.data, initialApply.data);

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
    lead.spec.axi.list.fields = lead.spec.axi.list.fields.filter((
      field: string,
    ) => field !== "phone");
    await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));

    const destructiveA = await preview(harness, destructiveDir);
    assertEquals(destructiveA.class, "destructive");
    const token1 = await validateToken(harness, destructiveA.id);
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
    const rootPrincipal = (await query<{ id: string }>(
      harness.server.sql,
      "select p.id::text id from principals p join human_users h on h.principal_id=p.id where h.username='root'",
    )).rows[0].id;
    const rowId = uuidV7();
    await query(
      harness.server.sql,
      `insert into "${leadTable}"(id,project_id,created_by,updated_by,name,status,phone) values($1,$2,$3,$3,'Fact changed','new','555')`,
      [rowId, projectId, rootPrincipal],
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

    for (const slug of ["alpha", "beta"]) {
      await runOk(harness, ["project", "select", slug], secrets);
      const metadata = await runOk(harness, [
        "metadata",
        "resource",
        "operant/crm:lead",
      ], secrets);
      assertEquals(metadata.data.spec.fields.phone, undefined);
    }
    assertEquals(
      (await query<{ count: string }>(
        harness.server.sql,
        "select count(*)::text count from pack_migration_applications",
      )).rows[0].count,
      "4",
    );
    assertEquals(
      (await query<{ leaked: boolean }>(
        harness.server.sql,
        "select exists(select 1 from pack_migration_confirmation_tokens where length(token_digest)<>64) leaked",
      )).rows[0].leaked,
      false,
    );
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
