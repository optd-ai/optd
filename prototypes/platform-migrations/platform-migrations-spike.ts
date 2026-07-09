import { PGlite } from "npm:@electric-sql/pglite";

type Migration = { id: string; sql: string };

export const platformMigrations: Migration[] = [
  {
    id: "0001_platform_core",
    sql:
      "create table if not exists platform_kv(key text primary key, value jsonb not null)",
  },
  {
    id: "0002_pack_registry",
    sql:
      "create table if not exists pack_revisions(revision text primary key, manifest jsonb not null, created_at timestamptz default now())",
  },
];

export async function createDb() {
  return new PGlite();
}

export async function applyPlatformMigrations(
  db: PGlite,
  migrations = platformMigrations,
) {
  await db.exec(
    "create table if not exists platform_schema_migrations(id text primary key, checksum text not null, applied_at timestamptz default now())",
  );
  const applied: string[] = [];
  for (const migration of migrations) {
    const checksum = digest(migration.sql);
    const existing = (await db.query<{ checksum: string }>(
      "select checksum from platform_schema_migrations where id=$1",
      [migration.id],
    )).rows[0];
    if (existing) {
      if (existing.checksum !== checksum) {
        throw new Error(`migration checksum changed: ${migration.id}`);
      }
      continue;
    }
    await db.exec("begin");
    try {
      await db.exec(migration.sql);
      await db.query(
        "insert into platform_schema_migrations(id, checksum) values ($1, $2)",
        [migration.id, checksum],
      );
      await db.exec("commit");
      applied.push(migration.id);
    } catch (error) {
      await db.exec("rollback");
      throw error;
    }
  }
  return { applied };
}

export async function inspectMigrations(db: PGlite) {
  return (await db.query(
    "select id, checksum from platform_schema_migrations order by id",
  )).rows;
}

function digest(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
