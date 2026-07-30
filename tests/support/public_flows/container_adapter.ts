// deno-lint-ignore-file no-import-prefix no-unversioned-import require-await
import { assertEquals } from "jsr:@std/assert";
import {
  type ContainerCliLauncher,
  type ContainerHarness,
  createContainerHarness,
} from "../container_harness.ts";
import { startHttpProvider } from "../http_provider.ts";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
  PublicFlowProcess,
  PublicFlowProcessTreeKind,
} from "../public_flow_contract.ts";
import { PublicFlowAssets } from "./assets.ts";
import type {
  CompletePublicFlowBackend,
  MigrationSideEffects,
  ProviderBehavior,
  PublicFlowAsset,
} from "./backend.ts";

export async function createContainerPublicFlowBackend(
  image: string,
): Promise<CompletePublicFlowBackend> {
  const provider = startHttpProvider([], {
    hostname: "0.0.0.0",
    advertisedHostname: "host.docker.internal",
  });
  const harness = await createContainerHarness(image);
  const assetRoot = await Deno.makeTempDir({
    prefix: "operant-public-flow-assets-",
  });
  const assets = new PublicFlowAssets(assetRoot);
  assets.setProviderUrl(provider.url);
  const copied = new Map<PublicFlowAsset, string>();
  const launchers = new Set<PublicFlowLauncher>();
  let requesterRoot: string | undefined;
  const agentRoots = new Set<string>();
  let cleaned = false;
  let lockChild: Deno.ChildProcess | undefined;
  try {
    await harness.startAppManaged([
      "--add-host",
      "host.docker.internal:host-gateway",
      "--env",
      `OPERANT_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
      "--env",
      "OPERANT_OUTBOX_POLL_INTERVAL_MS=60000",
      "--env",
      "OPERANT_OUTBOX_INITIAL_BACKOFF_MS=600000",
      "--env",
      "OPERANT_OUTBOX_MAX_BACKOFF_MS=600000",
    ]);
    await harness.waitReady();
  } catch (error) {
    await harness.cleanup();
    await provider.close();
    await Deno.remove(assetRoot, { recursive: true }).catch(() => undefined);
    throw error;
  }

  const wrap = (
    inner: ContainerCliLauncher,
    kind: PublicFlowProcessTreeKind,
  ): PublicFlowLauncher => {
    const launcher: PublicFlowLauncher = {
      kind,
      async runCli(args, options) {
        if (kind === "agent" && args.includes("wait") && requesterRoot) {
          await copyAuthStore(harness, requesterRoot, inner.root);
        }
        const result = await inner.runOptctl(
          [...args],
          options?.stdin,
          options?.env ? { ...options.env } : undefined,
        );
        if (
          kind === "request_only" && args.includes("request") &&
          result.code === 0
        ) {
          requesterRoot = inner.root;
          await Promise.all(
            [...agentRoots].map((root) =>
              copyAuthStore(harness, requesterRoot!, root)
            ),
          );
        }
        return result;
      },
      spawnCli(args, options) {
        return spawnContainerCli(harness, inner.root, args, options);
      },
      async close() {
        launchers.delete(launcher);
        agentRoots.delete(inner.root);
        await inner.close();
      },
    };
    launchers.add(launcher);
    if (kind === "agent") agentRoots.add(inner.root);
    return launcher;
  };

  const backend: CompletePublicFlowBackend = {
    backend: "release_container",
    serverOrigin: `http://127.0.0.1:${harness.port}`,
    async compileCurrentCli() {
      const expected = (await command("git", ["rev-parse", "HEAD"])).stdout
        .trim();
      const revision = (await harness.docker([
        "image",
        "inspect",
        image,
        "--format",
        '{{index .Config.Labels "org.opencontainers.image.revision"}}',
      ])).stdout.trim();
      assertEquals(revision, expected);
      const binary = await harness.docker([
        "exec",
        harness.container,
        "test",
        "-x",
        "/usr/local/bin/optctl",
      ]);
      assertEquals(binary.code, 0);
      return "/usr/local/bin/optctl";
    },
    async runCli(args, options) {
      return await harness.runOptctl(
        [...args],
        options?.stdin,
        options?.env ? { ...options.env } : undefined,
      );
    },
    spawnCli(args, options) {
      return spawnContainerCli(
        harness,
        `/data/.container-test-clients/spawn-${crypto.randomUUID()}`,
        args,
        options,
      );
    },
    async createProcessTreeLauncher(kind) {
      return wrap(await harness.createProcessTreeLauncher(kind), kind);
    },
    async runConcurrent(requests) {
      return await Promise.all(
        requests.map(({ args, options, launcher }) =>
          (launcher ?? backend).runCli(args, options)
        ),
      );
    },
    async packPath(pack) {
      return await backend.assetPath(
        pack === "migration" ? "crm_migration_v1" : pack,
      );
    },
    async uploadPack(path) {
      return await harness.copyPack(path);
    },
    async crashServer() {
      await harness.docker(["kill", harness.container]);
    },
    async restartServer(options) {
      const extra = [
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `OPERANT_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
      ];
      for (const [name, value] of Object.entries(options?.environment ?? {})) {
        if (value !== null) extra.push("--env", `${name}=${value}`);
      }
      await harness.recreateAppManaged(extra);
    },
    async waitUntilReady() {
      await harness.waitReady();
    },
    async waitForProviderBarrier(name) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (provider.activeHolds().includes(name)) return;
        await delay(20);
      }
      throw new Error(`provider barrier ${name} was not reached`);
    },
    async releaseProviderBarrier(name) {
      provider.release(name);
    },
    async diagnostics() {
      const topology = await harness.docker([
        "exec",
        harness.container,
        "sh",
        "-c",
        "for p in /proc/[0-9]*; do printf '%s ' ${p##*/}; cat $p/comm; done",
      ], { allowFailure: true });
      return {
        serverLogs: `${await harness.logs()}\n${topology.stdout}`,
        processTree: topology.stdout.split("\n").map((line) =>
          Number(line.split(" ")[0])
        ).filter(Number.isSafeInteger),
        runtimeResources: [harness.container, harness.volume],
      };
    },
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await Promise.all(
        [...launchers].map((launcher) =>
          launcher.close().catch(() => undefined)
        ),
      );
      if (lockChild) {
        try {
          lockChild.kill("SIGTERM");
        } catch { /* already exited */ }
        await lockChild.status.catch(() => undefined);
      }
      await harness.cleanup();
      await provider.close();
      await Deno.remove(assetRoot, { recursive: true }).catch(() => undefined);
    },
    async assetPath(asset) {
      if (asset === "crm") return "/opt/operant/prototypes/crm-default-pack";
      if (asset === "projects") {
        return "/opt/operant/prototypes/project-management-pack";
      }
      const existing = copied.get(asset);
      if (existing) return existing;
      const path = await harness.copyPack(await assets.path(asset));
      copied.set(asset, path);
      return path;
    },
    async materializeInput(name, value) {
      const path =
        `/data/.container-test-clients/${name}-${crypto.randomUUID()}.json`;
      await harness.docker([
        "exec",
        "--interactive",
        harness.container,
        "sh",
        "-c",
        `umask 077; cat > '${path}'`,
      ], { stdin: JSON.stringify(value) });
      return path;
    },
    async loginProcess(username, password) {
      const launcher = await backend.createProcessTreeLauncher("human");
      const result = await launcher.runCli([
        "--json",
        "auth",
        "login",
        "--username",
        username,
        "--password-stdin",
      ], { stdin: `${password}\n` });
      return { launcher, result };
    },
    async observeCrmApprovalPolicy() {
      return await sqlJson(
        harness,
        `select coalesce(json_agg(x),'[]'::json) from (select pr.role_id,pr.capability,pr.resource from policy_rules pr join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id where pdv.policy_id='operant/crm:sales_access' and pr.rule_name='sales_manager_approval') x`,
      );
    },
    async observeCrmRelationshipPolicy() {
      return await sqlJson(
        harness,
        `select coalesce(json_agg(x),'[]'::json) from (select pr.capability,pr.resource from policy_rules pr join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id where pdv.policy_id='operant/crm:sales_access' and pr.rule_name='crm_admin_relationship_links' order by pr.resource,pr.capability) x`,
      );
    },
    async observePersistenceCounts() {
      return await sqlJson(
        harness,
        `select json_build_object('stages',(select count(*)::text from staged_changesets),'versions',(select count(*)::text from object_versions))`,
      );
    },
    async observeAuthContextPrincipal(id) {
      return await sqlScalar(
        harness,
        `select principal_id from auth_contexts where id=${literal(id)}`,
      );
    },
    async observeCrmLostReasonId(projectId) {
      const table = await sqlScalar(
        harness,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lost_reason'",
      );
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid lost-reason table");
      }
      return await sqlScalar(
        harness,
        `select id from ${table} where project_id=${
          literal(projectId)
        } and archived_at is null order by id limit 1`,
      );
    },
    async observeProjectsTodoStageId(projectId) {
      const table = await sqlScalar(
        harness,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='task_stage'",
      );
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid task-stage table");
      }
      return await sqlScalar(
        harness,
        `select id from ${table} where project_id=${
          literal(projectId)
        } and name='todo' and archived_at is null limit 1`,
      );
    },
    async observeProjectsTaskCount(projectId, state) {
      const table = await sqlScalar(
        harness,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='task'",
      );
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error("invalid task table");
      return Number(
        await sqlScalar(
          harness,
          `select count(*)::int from ${table} where project_id=${
            literal(projectId)
          } and state=${literal(state)} and archived_at is null`,
        ),
      );
    },
    async observeProjectsTimesheets(projectId, principalId) {
      const table = await sqlScalar(
        harness,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='timesheet'",
      );
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid timesheet table");
      }
      const rows = await sqlJson<Array<{ principalId: string; hours: string }>>(
        harness,
        `select coalesce(json_agg(json_build_object('principalId',principal_id,'hours',hours::text)),'[]'::json) from ${table} where project_id=${
          literal(projectId)
        } and principal_id=${literal(principalId)} and archived_at is null`,
      );
      return rows.map((row) => ({
        principalId: row.principalId,
        hours: Number(row.hours).toString(),
      }));
    },
    async observeCrmRelationshipAuthority(input) {
      return Number(
        await sqlScalar(
          harness,
          `select count(*)::int from role_assignments ra join policy_rules pr on pr.role_id=ra.role_id join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id and pdv.active join policy_assignments pa on pa.policy_definition_version_id=pdv.id and pa.active where ra.principal_id=${
            literal(input.principalId)
          } and ra.active and ra.role_id='operant/crm:crm_admin' and ra.project_id=${
            literal(input.projectId)
          } and pr.capability='link' and pr.resource='operant/crm:opportunity_viewer' and pa.boundary_type='all_projects'`,
        ),
      );
    },
    async observeRelationshipTuple(input) {
      const publisher = "operant";
      const pack = input.pack === "crm" ? "crm" : "projects";
      const table = await sqlScalar(
        harness,
        `select table_name from pack_runtime_tables where publisher=${
          literal(publisher)
        } and pack_name=${
          literal(pack)
        } and definition_kind='relationship' and definition_name=${
          literal(input.relationship)
        }`,
      );
      if (!/^[a-z0-9_]+$/.test(table)) return null;
      return await sqlJson(
        harness,
        `select json_build_object('fromObjectId',from_object_id,'toObjectId',to_object_id) from ${table} where project_id=${
          literal(input.projectId)
        } and from_object_id=${
          literal(input.fromObjectId)
        } and archived_at is null limit 1`,
      );
    },
    async ciphertextContainsAny(values) {
      for (const value of values) {
        if (
          await sqlScalar(
            harness,
            `select exists(select 1 from platform_secrets where ciphertext::text like '%' || ${
              literal(value)
            } || '%')`,
          ) === "t"
        ) return true;
      }
      return false;
    },
    async configureProvider(behaviors: readonly ProviderBehavior[]) {
      provider.enqueue(...behaviors);
      await harness.recreateAppManaged([
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `OPERANT_HOOK_NET_ALLOW=${new URL(provider.url).host}`,
        "--env",
        "OPERANT_OUTBOX_POLL_INTERVAL_MS=20",
        "--env",
        "OPERANT_OUTBOX_INITIAL_BACKOFF_MS=20",
        "--env",
        "OPERANT_OUTBOX_MAX_BACKOFF_MS=100",
      ]);
      await harness.waitReady();
      return provider.url;
    },
    async providerAttempts() {
      return provider.attempts.map((
        { id, idempotencyKey, duplicate, body },
      ) => ({ id, idempotencyKey, duplicate, body }));
    },
    async providerEffects() {
      return provider.effects.map((
        { id, idempotencyKey, duplicate, body },
      ) => ({ id, idempotencyKey, duplicate, body }));
    },
    async installMigrationFailureBarrier() {
      await sqlExec(
        harness,
        `create function test_fail_migration_application() returns trigger language plpgsql as $$ begin raise exception 'acceptance injected failure'; end $$; create trigger test_fail_migration_application before insert on pack_migration_applications for each row execute function test_fail_migration_application()`,
      );
    },
    async removeMigrationFailureBarrier() {
      await sqlExec(
        harness,
        "drop trigger if exists test_fail_migration_application on pack_migration_applications; drop function if exists test_fail_migration_application()",
      );
    },
    async holdMigrationTableLock() {
      const table = await sqlScalar(
        harness,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
      );
      const script =
        `begin; lock table "${table}" in row exclusive mode; select 'LOCKED'; select pg_sleep(3600);`;
      lockChild = new Deno.Command("docker", {
        args: [
          "exec",
          harness.container,
          "sh",
          "-c",
          'exec psql -h /data/postgres/run -p "$(sed -n 4p /data/postgres/data/postmaster.pid)" -U operant -d postgres -At -c "$1"',
          "sh",
          script,
        ],
        stdout: "null",
        stderr: "null",
      }).spawn();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const active = await sqlScalar(
          harness,
          `select exists(select 1 from pg_stat_activity where query like '%pg_sleep(3600)%' and state='active')`,
        );
        if (active === "t") return;
        await delay(20);
      }
      throw new Error("container migration lock was not acquired");
    },
    async releaseMigrationTableLock() {
      if (!lockChild) return;
      await sqlExec(
        harness,
        `select pg_terminate_backend(pid) from pg_stat_activity where query like '%pg_sleep(3600)%' and pid<>pg_backend_pid()`,
      ).catch(() => undefined);
      try {
        lockChild.kill("SIGTERM");
      } catch { /* exited */ }
      await lockChild.status.catch(() => undefined);
      lockChild = undefined;
    },
    async observeMigration() {
      return await sqlJson(
        harness,
        `with active as (select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm') select json_build_object('activeRevisionId',(select id from active),'migrationApplications',(select count(*)::text from pack_migration_applications),'fields',(select coalesce(json_agg(field_name order by field_name),'[]'::json) from pack_source_files, lateral jsonb_object_keys(content::jsonb->'spec'->'fields') field_name where revision=(select id from active) and path='resources/lead.yaml'))`,
      );
    },
    async observeMigrationSideEffects(planId): Promise<MigrationSideEffects> {
      return await sqlJson(
        harness,
        `select json_build_object('validations',(select count(*)::text from pack_migration_validations where plan_id=${
          literal(planId)
        }),'tokens',(select count(*)::text from pack_migration_confirmation_tokens where plan_id=${
          literal(planId)
        }),'attempts',(select count(*)::text from pack_migration_attempts where plan_id=${
          literal(planId)
        }))`,
      );
    },
  };
  return backend;
}

async function copyAuthStore(
  harness: ContainerHarness,
  sourceRoot: string,
  destinationRoot: string,
): Promise<void> {
  await harness.docker([
    "exec",
    "--user",
    "0",
    harness.container,
    "sh",
    "-c",
    `rm -rf "$2/home/.local/share/operant/auth"; mkdir -p "$2/home/.local/share/operant"; if test -d "$1/home/.local/share/operant/auth"; then cp -a "$1/home/.local/share/operant/auth" "$2/home/.local/share/operant/auth"; chown -R 1993:1993 "$2/home"; fi`,
    "sh",
    sourceRoot,
    destinationRoot,
  ]);
}

async function sqlExec(harness: ContainerHarness, sql: string) {
  await harness.docker([
    "exec",
    harness.container,
    "sh",
    "-c",
    `exec psql -h /data/postgres/run -p "$(sed -n 4p /data/postgres/data/postmaster.pid)" -v ON_ERROR_STOP=1 -U operant -d postgres -c "$1"`,
    "sh",
    sql,
  ]);
}
async function sqlScalar(
  harness: ContainerHarness,
  sql: string,
): Promise<string> {
  return (await harness.docker([
    "exec",
    harness.container,
    "sh",
    "-c",
    `exec psql -h /data/postgres/run -p "$(sed -n 4p /data/postgres/data/postmaster.pid)" -v ON_ERROR_STOP=1 -U operant -d postgres -At -c "$1"`,
    "sh",
    sql,
  ])).stdout.trim();
}
async function sqlJson<T>(harness: ContainerHarness, sql: string): Promise<T> {
  return JSON.parse(await sqlScalar(harness, sql));
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
async function spawnContainerCli(
  harness: ContainerHarness,
  root: string,
  args: readonly string[],
  options?: Readonly<{
    stdin?: string;
    env?: Readonly<Record<string, string>>;
  }>,
): Promise<PublicFlowProcess> {
  const argv = [
    "exec",
    ...options?.stdin === undefined ? [] : ["--interactive"],
    ...Object.entries(options?.env ?? {}).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    "--env",
    `HOME=${root}/home`,
    "--env",
    `XDG_CONFIG_HOME=${root}/config`,
    "--env",
    `XDG_STATE_HOME=${root}/state`,
    "--env",
    "OPERANT_AUTH_TREE_STOP_PID=1",
    harness.container,
    "sh",
    "-c",
    `mkdir -p '${root}/home' '${root}/config' '${root}/state' && exec optctl "$@"`,
    "sh",
    "--server",
    "http://127.0.0.1:8789",
    ...args,
  ];
  const child = new Deno.Command("docker", {
    args: argv,
    stdin: options?.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (options?.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(options.stdin));
    await writer.close();
  }
  let result: Promise<PublicFlowCommandResult> | undefined;
  return {
    pid: child.pid,
    wait() {
      return result ??= child.output().then((output) => ({
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout).trimEnd(),
        stderr: new TextDecoder().decode(output.stderr).trimEnd(),
      }));
    },
    async terminate(signal = "SIGTERM") {
      try {
        child.kill(signal);
      } catch { /* exited */ }
      await child.status.catch(() => undefined);
    },
  };
}

async function command(name: string, args: string[]) {
  const output = await new Deno.Command(name, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) throw new Error(new TextDecoder().decode(output.stderr));
  return { stdout: new TextDecoder().decode(output.stdout) };
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
