// deno-lint-ignore-file no-import-prefix no-unversioned-import require-await
import { assertStringIncludes } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import {
  assertHealth,
  type CliLauncher,
  type CliResult,
  type LiveHarness,
} from "../live_harness.ts";
import { type HttpProvider, startHttpProvider } from "../http_provider.ts";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
  PublicFlowProcess,
} from "../public_flow_contract.ts";
import { PublicFlowAssets } from "./assets.ts";
import type {
  CompletePublicFlowBackend,
  MigrationSideEffects,
  ProviderBehavior,
  PublicFlowAsset,
} from "./backend.ts";

export function createHostPublicFlowBackend(
  harness: LiveHarness,
): CompletePublicFlowBackend {
  const assets = new PublicFlowAssets(
    join(harness.rootDir, "public-flow-assets"),
  );
  const launchers = new Set<PublicFlowLauncher>();
  let provider: HttpProvider | undefined;
  let lockRelease: PromiseWithResolvers<void> | undefined;
  let lockTask: Promise<void> | undefined;
  let cleaned = false;

  const wrapResult = (result: CliResult): PublicFlowCommandResult => ({
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  const wrapLauncher = (inner: CliLauncher): PublicFlowLauncher => {
    const wrapped: PublicFlowLauncher = {
      kind: inner.kind,
      async runCli(args, options) {
        return wrapResult(
          await inner.runOptctl(
            [...args],
            options?.stdin,
            options?.env ? { ...options.env } : undefined,
          ),
        );
      },
      spawnCli(args, options) {
        return Promise.resolve(settledProcess(wrapped.runCli(args, options)));
      },
      async close() {
        launchers.delete(wrapped);
        await inner.close();
      },
    };
    launchers.add(wrapped);
    return wrapped;
  };

  const backend: CompletePublicFlowBackend = {
    backend: "host",
    serverOrigin: harness.baseUrl,
    async compileCurrentCli() {
      assertStringIncludes(harness.binaryPath, harness.binarySourceDigest);
      assertStringIncludes(harness.binaryPath, harness.rootDir);
      return harness.binaryPath;
    },
    async runCli(args, options) {
      return wrapResult(
        await harness.runOptctl(
          [...args],
          options?.stdin,
          options?.env ? { ...options.env } : undefined,
        ),
      );
    },
    async spawnCli(args, options) {
      const active = await harness.startOptctl(
        [...args],
        options?.stdin,
        options?.env ? { ...options.env } : undefined,
      );
      return {
        pid: active.pid,
        async wait() {
          return wrapResult(await active.result);
        },
        terminate: (signal) => active.terminate(signal),
      };
    },
    async createProcessTreeLauncher(kind) {
      return wrapLauncher(await harness.createProcessTreeLauncher(kind));
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
      return path;
    },
    async crashServer() {
      await harness.crash();
    },
    async restartServer(options) {
      await harness.restart(options);
      Object.defineProperty(backend, "serverOrigin", {
        value: harness.baseUrl,
        configurable: true,
      });
    },
    async waitUntilReady() {
      await assertHealth(harness.baseUrl);
    },
    async waitForProviderBarrier(name) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (provider?.activeHolds().includes(name)) return;
        await delay(20);
      }
      throw new Error(`provider barrier ${name} was not reached`);
    },
    async releaseProviderBarrier(name) {
      provider?.release(name);
    },
    async diagnostics() {
      const value = await harness.diagnostics();
      return {
        serverLogs: [value.server, value.postgres, value.hooks].join("\n"),
        processTree: value.processTree,
        runtimeResources: value.runtimeResources,
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
      await backend.releaseMigrationTableLock().catch(() => undefined);
      await provider?.close().catch(() => undefined);
      await harness.close();
    },
    assetPath(asset: PublicFlowAsset) {
      return assets.path(asset);
    },
    async materializeInput(name, value) {
      const directory = join(harness.rootDir, "public-flow-inputs");
      await Deno.mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${name}-${crypto.randomUUID()}.json`);
      await Deno.writeTextFile(path, JSON.stringify(value), {
        createNew: true,
        mode: 0o600,
      });
      return path;
    },
    async loginProcess(username, password) {
      const value = await harness.loginProcess({ username, password });
      return {
        launcher: wrapLauncher(value.launcher),
        result: wrapResult(value.result),
      };
    },
    async observeCrmApprovalPolicy() {
      return (await query<Record<string, string>>(
        harness.server.sql,
        `select pr.role_id,pr.capability,pr.resource from policy_rules pr join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id where pdv.policy_id=$1 and pr.rule_name='sales_manager_approval'`,
        ["operant/crm:sales_access"],
      )).rows;
    },
    async observeCrmRelationshipPolicy() {
      return (await query<Record<string, string>>(
        harness.server.sql,
        `select pr.capability,pr.resource from policy_rules pr join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id where pdv.policy_id=$1 and pr.rule_name='crm_admin_relationship_links' order by pr.resource,pr.capability`,
        ["operant/crm:sales_access"],
      )).rows;
    },
    async observePersistenceCounts() {
      return (await query<{ stages: string; versions: string }>(
        harness.server.sql,
        `select (select count(*)::text from staged_changesets) stages,(select count(*)::text from object_versions) versions`,
      )).rows[0];
    },
    async observeAuthContextPrincipal(id) {
      return (await query<{ principal_id: string }>(
        harness.server.sql,
        "select principal_id from auth_contexts where id=$1",
        [id],
      )).rows[0].principal_id;
    },
    async observeCrmLostReasonId(projectId) {
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lost_reason'",
      )).rows[0].table_name;
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid lost-reason table");
      }
      return (await query<{ id: string }>(
        harness.server.sql,
        `select id from ${table} where project_id=$1 and archived_at is null order by id limit 1`,
        [projectId],
      )).rows[0].id;
    },
    async observeProjectsTodoStageId(projectId) {
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='task_stage'",
      )).rows[0].table_name;
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid task-stage table");
      }
      return (await query<{ id: string }>(
        harness.server.sql,
        `select id from ${table} where project_id=$1 and name='todo' and archived_at is null limit 1`,
        [projectId],
      )).rows[0].id;
    },
    async observeProjectsTaskCount(projectId, state) {
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='task'",
      )).rows[0].table_name;
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error("invalid task table");
      return (await query<{ count: number }>(
        harness.server.sql,
        `select count(*)::int count from ${table} where project_id=$1 and state=$2 and archived_at is null`,
        [projectId, state],
      )).rows[0].count;
    },
    async observeProjectsTimesheets(projectId, principalId) {
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='projects' and definition_kind='resource' and definition_name='timesheet'",
      )).rows[0].table_name;
      if (!/^[a-z0-9_]+$/.test(table)) {
        throw new Error("invalid timesheet table");
      }
      return (await query<{ principal_id: string; hours: string }>(
        harness.server.sql,
        `select principal_id,hours::text hours from ${table} where project_id=$1 and principal_id=$2 and archived_at is null`,
        [projectId, principalId],
      )).rows.map((row) => ({
        principalId: row.principal_id,
        hours: Number(row.hours).toString(),
      }));
    },
    async observeCrmRelationshipAuthority(input) {
      return (await query<{ count: number }>(
        harness.server.sql,
        `select count(*)::int count from role_assignments ra join policy_rules pr on pr.role_id=ra.role_id join policy_definition_versions pdv on pdv.id=pr.policy_definition_version_id and pdv.active join policy_assignments pa on pa.policy_definition_version_id=pdv.id and pa.active where ra.principal_id=$1 and ra.active and ra.role_id='operant/crm:crm_admin' and ra.project_id=$2 and pr.capability='link' and pr.resource='operant/crm:opportunity_viewer' and pa.boundary_type='all_projects'`,
        [input.principalId, input.projectId],
      )).rows[0].count;
    },
    async observeRelationshipTuple(input) {
      const [publisher, name] = input.pack === "crm"
        ? ["operant", "crm"]
        : ["operant", "projects"];
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='relationship' and definition_name=$3`,
        [publisher, name, input.relationship],
      )).rows[0]?.table_name;
      if (!table || !/^[a-z0-9_]+$/.test(table)) return null;
      const row =
        (await query<{ from_object_id: string; to_object_id: string }>(
          harness.server.sql,
          `select from_object_id,to_object_id from ${table} where project_id=$1 and from_object_id=$2 and archived_at is null`,
          [input.projectId, input.fromObjectId],
        )).rows[0];
      return row
        ? { fromObjectId: row.from_object_id, toObjectId: row.to_object_id }
        : null;
    },
    async ciphertextContainsAny(values) {
      for (const value of values) {
        const found = (await query<{ found: boolean }>(
          harness.server.sql,
          "select exists(select 1 from platform_secrets where ciphertext::text like '%' || $1 || '%') found",
          [value],
        )).rows[0].found;
        if (found) return true;
      }
      return false;
    },
    async configureProvider(behaviors: readonly ProviderBehavior[]) {
      await provider?.close();
      provider = startHttpProvider([...behaviors]);
      assets.setProviderUrl(provider.url);
      await harness.restart({
        environment: {
          OPERANT_HOOK_NET_ALLOW: new URL(provider.url).host,
          OPERANT_OUTBOX_POLL_INTERVAL_MS: "20",
          OPERANT_OUTBOX_INITIAL_BACKOFF_MS: "20",
          OPERANT_OUTBOX_MAX_BACKOFF_MS: "100",
        },
      });
      Object.defineProperty(backend, "serverOrigin", {
        value: harness.baseUrl,
        configurable: true,
      });
      return provider.url;
    },
    async providerAttempts() {
      return (provider?.attempts ?? []).map((
        { id, idempotencyKey, duplicate, body },
      ) => ({ id, idempotencyKey, duplicate, body }));
    },
    async providerEffects() {
      return (provider?.effects ?? []).map((
        { id, idempotencyKey, duplicate, body },
      ) => ({ id, idempotencyKey, duplicate, body }));
    },
    async installMigrationFailureBarrier() {
      await query(
        harness.server.sql,
        `create function test_fail_migration_application() returns trigger language plpgsql as $$ begin raise exception 'acceptance injected failure'; end $$; create trigger test_fail_migration_application before insert on pack_migration_applications for each row execute function test_fail_migration_application()`,
      );
    },
    async removeMigrationFailureBarrier() {
      await query(
        harness.server.sql,
        "drop trigger if exists test_fail_migration_application on pack_migration_applications; drop function if exists test_fail_migration_application()",
      );
    },
    async holdMigrationTableLock() {
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
      )).rows[0].table_name;
      const locked = Promise.withResolvers<void>();
      lockRelease = Promise.withResolvers<void>();
      lockTask = harness.server.sql.begin(async (tx) => {
        await query(tx, `lock table "${table}" in row exclusive mode`);
        locked.resolve();
        await lockRelease!.promise;
      });
      await locked.promise;
    },
    async releaseMigrationTableLock() {
      lockRelease?.resolve();
      await lockTask;
      lockRelease = undefined;
      lockTask = undefined;
    },
    async observeMigration(projectId, leadId) {
      const activeRevisionId = (await query<{ id: string }>(
        harness.server.sql,
        "select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm'",
      )).rows[0].id;
      const table = (await query<{ table_name: string }>(
        harness.server.sql,
        "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
      )).rows[0].table_name;
      if (!/^[a-z0-9_]+$/.test(table)) throw new Error("invalid lead table");
      const snapshot = (await query<{
        activation: string;
        applications: string;
        catalog: string;
        source_fields: string;
        physical_columns: string;
        physical_rows: string;
      }>(
        harness.server.sql,
        `select
          (select to_jsonb(a)::text from pack_active_revisions a where publisher='operant' and pack_name='crm') activation,
          (select coalesce(jsonb_agg(to_jsonb(a) order by a.id),'[]'::jsonb)::text from pack_migration_applications a) applications,
          (select coalesce(jsonb_agg(to_jsonb(t) order by t.definition_kind,t.definition_name),'[]'::jsonb)::text from pack_runtime_tables t where publisher='operant' and pack_name='crm') catalog,
          (select coalesce(jsonb_agg(field_name order by field_name),'[]'::jsonb)::text from pack_source_files, lateral jsonb_object_keys(content::jsonb->'spec'->'fields') field_name where revision=$1 and path='resources/lead.yaml') source_fields,
          (select coalesce(jsonb_agg(to_jsonb(c) order by c.ordinal_position),'[]'::jsonb)::text from (select ordinal_position,column_name,data_type,udt_name,is_nullable,column_default from information_schema.columns where table_schema='public' and table_name=$2) c) physical_columns,
          (select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb)::text from ${table} r where r.project_id=$3 and r.id=$4) physical_rows`,
        [activeRevisionId, table, projectId, leadId],
      )).rows[0];
      return {
        activeRevisionId,
        activation: snapshot.activation,
        applications: snapshot.applications,
        catalog: snapshot.catalog,
        sourceFields: snapshot.source_fields,
        physicalColumns: snapshot.physical_columns,
        physicalRows: snapshot.physical_rows,
      };
    },
    async observeMigrationSideEffects(planId): Promise<MigrationSideEffects> {
      const row = (await query<{
        validations: string;
        tokens: string;
        attempts: string;
        audits: string;
        latest_outcome: string | null;
        latest_decision: string | null;
        latest_details: string | null;
      }>(
        harness.server.sql,
        `select
          (select count(*)::text from pack_migration_validations where plan_id=$1) validations,
          (select count(*)::text from pack_migration_confirmation_tokens where plan_id=$1) tokens,
          (select count(*)::text from pack_migration_attempts where plan_id=$1) attempts,
          (select count(*)::text from pack_migration_audit_events where plan_id=$1) audits,
          (select outcome from pack_migration_attempts where plan_id=$1 order by created_at desc,id desc limit 1) latest_outcome,
          (select decision from pack_migration_audit_events where plan_id=$1 order by created_at desc,id desc limit 1) latest_decision,
          (select details::text from pack_migration_audit_events where plan_id=$1 order by created_at desc,id desc limit 1) latest_details`,
        [planId],
      )).rows[0];
      return {
        validations: row.validations,
        tokens: row.tokens,
        attempts: row.attempts,
        audits: row.audits,
        latestOutcome: row.latest_outcome,
        latestDecision: row.latest_decision,
        latestDetails: row.latest_details,
      };
    },
  };
  return backend;
}

function settledProcess(
  result: Promise<PublicFlowCommandResult>,
): PublicFlowProcess {
  return { pid: 0, wait: () => result, async terminate() {} };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
