import { query, type Queryable } from "./client.ts";

export type PlatformMigration = {
  id: string;
  sql: string;
};

export type MigrationApplyResult = {
  applied: string[];
};

export type MigrationStatus = {
  ok: boolean;
  appliedCount: number;
  latestId: string | null;
};

export const platformMigrations: PlatformMigration[] = [
  {
    id: "0001_platform_core",
    sql: `
      create table if not exists platform_kv (
        key text primary key,
        value jsonb not null,
        updated_at timestamptz not null default now()
      )
    `,
  },
  {
    id: "0002_pack_registry",
    sql: `
      create table if not exists pack_revisions (
        revision text primary key,
        namespace text not null,
        name text not null,
        version text not null,
        active boolean not null,
        manifest jsonb not null,
        normalized jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists pack_revisions_active_idx on pack_revisions(namespace, name, active);
      create table if not exists pack_source_files (
        revision text not null references pack_revisions(revision) on delete cascade,
        path text not null,
        digest text not null,
        kind text not null,
        content text not null,
        primary key(revision, path)
      );
      create table if not exists resource_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists relationship_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists lifecycle_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists action_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists hook_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        script_path text not null,
        script_digest text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists policy_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      );
      create table if not exists seed_definitions (
        revision text not null references pack_revisions(revision) on delete cascade,
        namespace text not null,
        name text not null,
        resource text not null,
        key_field text not null,
        spec jsonb not null,
        document jsonb not null,
        primary key(revision, namespace, name)
      )
    `,
  },
  {
    id: "0003_generated_sql_objects",
    sql: `
      create table if not exists generated_sql_objects (
        revision text not null references pack_revisions(revision) on delete cascade,
        kind text not null check (kind in ('resource_table', 'relationship_table')),
        namespace text not null,
        name text not null,
        table_name text not null,
        ddl text not null,
        created_at timestamptz not null default now(),
        primary key(revision, kind, namespace, name)
      );
      create index if not exists generated_sql_objects_table_name_idx on generated_sql_objects(table_name)
    `,
  },
  {
    id: "0004_changesets_history_events_comments",
    sql: `
      create table if not exists changesets (
        id text primary key,
        actor_id text not null,
        status text not null check (status in ('previewed', 'committed')),
        request_json jsonb not null,
        preview_json jsonb not null default '{}'::jsonb,
        idempotency_key text,
        source text,
        committed_at timestamptz,
        created_at timestamptz not null default now(),
        unique(actor_id, idempotency_key)
      );
      create table if not exists object_versions (
        id text primary key,
        resource text not null,
        object_id text not null,
        version integer not null,
        previous_version_id text null references object_versions(id),
        changeset_id text not null references changesets(id),
        operation text not null,
        resource_revision text not null,
        snapshot_json jsonb not null,
        changed_fields text[] not null default '{}',
        actor_id text not null,
        created_at timestamptz not null default now(),
        unique(resource, object_id, version)
      );
      create table if not exists audit_events (
        id text primary key,
        changeset_id text null references changesets(id),
        object_version_id text null references object_versions(id),
        actor_id text not null,
        event_type text not null,
        resource text null,
        object_id text null,
        action text null,
        decision text null,
        policy_summary_json jsonb null,
        validation_summary_json jsonb null,
        hook_execution_ids text[] not null default '{}',
        request_metadata_json jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );
      create table if not exists events (
        id text primary key,
        changeset_id text not null references changesets(id),
        object_version_id text null references object_versions(id),
        event_type text not null,
        resource text null,
        object_id text null,
        occurred_at timestamptz not null default now(),
        payload_json jsonb not null default '{}'::jsonb
      );
      create table if not exists comments (
        id text primary key,
        resource text not null,
        object_id text not null,
        changeset_id text not null references changesets(id),
        object_version_id text null references object_versions(id),
        actor_id text not null,
        body text not null,
        created_at timestamptz not null default now()
      );
      create index if not exists object_versions_object_idx on object_versions(resource, object_id, version desc);
      create index if not exists audit_events_object_idx on audit_events(resource, object_id, created_at desc);
      create index if not exists events_object_idx on events(resource, object_id, occurred_at desc);
      create index if not exists comments_object_idx on comments(resource, object_id, created_at desc)
    `,
  },
  {
    id: "0005_hooks_outbox",
    sql: `
      create table if not exists hook_executions (
        id text primary key,
        hook text not null,
        phase text not null,
        revision text not null,
        script_digest text not null,
        actor_id text not null,
        status text not null check (status in ('succeeded','failed')),
        duration_ms integer not null,
        exit_code integer null,
        logs text not null default '',
        result_json jsonb null,
        error_json jsonb null,
        created_at timestamptz not null default now()
      );
      create table if not exists outbox (
        id text primary key,
        hook text not null,
        phase text not null,
        status text not null default 'pending' check (status in ('pending','running','succeeded','failed','dead_letter')),
        attempts integer not null default 0,
        available_at timestamptz not null default now(),
        locked_by text null,
        locked_at timestamptz null,
        last_error text null,
        payload_json jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists outbox_status_available_idx on outbox(status, available_at);
      create index if not exists hook_executions_hook_idx on hook_executions(hook, created_at desc)
    `,
  },
  {
    id: "0006_pack_migration_plans",
    sql: `
      create table if not exists pack_migration_plans (
        id text primary key,
        namespace text not null,
        name text not null,
        from_revision text not null references pack_revisions(revision),
        to_revision text not null,
        status text not null,
        plan_digest text not null,
        candidate_normalized jsonb not null,
        candidate_manifest jsonb not null,
        candidate_source_files jsonb not null,
        plan_json jsonb not null,
        sql_preview jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists pack_migration_plans_pack_idx on pack_migration_plans(namespace, name, created_at desc);
      create index if not exists pack_migration_plans_digest_idx on pack_migration_plans(plan_digest)
    `,
  },
  {
    id: "0007_durable_outbox_lifecycle",
    sql: `
      alter table outbox add column if not exists event_id text null references events(id);
      alter table outbox add column if not exists hook_revision text null;
      alter table outbox add column if not exists script_digest text null;
      alter table outbox add column if not exists envelope_json jsonb not null default '{}'::jsonb;
      alter table outbox add column if not exists updated_at timestamptz not null default now();
      create index if not exists outbox_claim_idx on outbox(status, available_at, created_at, id);
      create index if not exists outbox_event_idx on outbox(event_id);
      create index if not exists hook_executions_hook_phase_idx on hook_executions(hook, phase, created_at desc)
    `,
  },
];

export async function applyPlatformMigrations(
  sql: Queryable,
  migrations: readonly PlatformMigration[] = platformMigrations,
): Promise<MigrationApplyResult> {
  await query(
    sql,
    `
    create table if not exists platform_schema_migrations (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `,
  );

  await query(
    sql,
    "select pg_advisory_xact_lock(hashtext('operant.platform_schema_migrations'))",
  );

  const applied: string[] = [];
  for (const migration of migrations) {
    const checksum = await digest(migration.sql);
    const existing = await query<{ checksum: string }>(
      sql,
      "select checksum from platform_schema_migrations where id = $1",
      [migration.id],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].checksum !== checksum) {
        throw new Error(`platform migration checksum changed: ${migration.id}`);
      }
      continue;
    }

    await query(sql, migration.sql);
    await query(
      sql,
      "insert into platform_schema_migrations(id, checksum) values ($1, $2)",
      [migration.id, checksum],
    );
    applied.push(migration.id);
  }
  return { applied };
}

export async function inspectMigrationStatus(
  sql: Queryable,
): Promise<MigrationStatus> {
  const table = await query<{ exists: boolean }>(
    sql,
    "select to_regclass('public.platform_schema_migrations') is not null as exists",
  );
  if (!table.rows[0]?.exists) {
    return { ok: false, appliedCount: 0, latestId: null };
  }
  const status = await query<
    { applied_count: string; latest_id: string | null }
  >(
    sql,
    "select count(*)::text as applied_count, max(id) as latest_id from platform_schema_migrations",
  );
  const row = status.rows[0];
  const appliedCount = Number(row?.applied_count ?? 0);
  return {
    ok: appliedCount >= platformMigrations.length,
    appliedCount,
    latestId: row?.latest_id ?? null,
  };
}

async function digest(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
