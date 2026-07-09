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
