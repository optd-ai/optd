import { PGlite } from "npm:@electric-sql/pglite";

type Actor = { id: string; roles: string[] };
const secretActions = [
  "secret.create",
  "secret.read",
  "secret.update",
  "secret.delete",
  "permission.grant",
];

export async function createDb() {
  const db = new PGlite();
  await db.exec(`
    create table roles(name text primary key, description text not null);
    create table role_permissions(role_name text not null references roles(name), action text not null, resource text not null, primary key(role_name, action, resource));
    create table users(id text primary key, roles text[] not null);
    create table secrets(name text primary key, value_ciphertext text not null, created_by text not null, created_at timestamptz default now());
    create table audit_events(id text primary key, actor_id text not null, event_type text not null, details jsonb not null, created_at timestamptz default now());
  `);
  return db;
}

export async function bootstrapSuperAdmin(db: PGlite, userId: string) {
  await db.query(
    "insert into roles(name, description) values ('super_admin', 'Bypasses permission checks'), ('admin', 'Granted all initial platform permissions')",
  );
  for (const action of secretActions) {
    await db.query(
      "insert into role_permissions(role_name, action, resource) values ('admin', $1, 'secret')",
      [action],
    );
  }
  await db.query("insert into users(id, roles) values ($1, '{super_admin}')", [
    userId,
  ]);
  await audit(db, userId, "bootstrap.super_admin", { userId });
}

export async function grantRole(
  db: PGlite,
  actor: Actor,
  userId: string,
  role: string,
) {
  await requirePermission(db, actor, "permission.grant", "secret");
  const existing = (await db.query<{ roles: string[] }>(
    "select roles from users where id=$1",
    [userId],
  )).rows[0];
  if (existing) {
    const roles = Array.from(new Set([...existing.roles, role]));
    await db.query("update users set roles=$1 where id=$2", [roles, userId]);
  } else {
    await db.query("insert into users(id, roles) values ($1, $2)", [userId, [
      role,
    ]]);
  }
  await audit(db, actor.id, "role.granted", { userId, role });
}

export async function createSecret(
  db: PGlite,
  actor: Actor,
  name: string,
  plaintext: string,
) {
  await requirePermission(db, actor, "secret.create", "secret");
  await db.query(
    "insert into secrets(name, value_ciphertext, created_by) values ($1, $2, $3)",
    [name, encryptForSpike(plaintext), actor.id],
  );
  await audit(db, actor.id, "secret.created", { name });
}

export async function readSecret(db: PGlite, actor: Actor, name: string) {
  await requirePermission(db, actor, "secret.read", "secret");
  const row = (await db.query<{ value_ciphertext: string }>(
    "select value_ciphertext from secrets where name=$1",
    [name],
  )).rows[0];
  if (!row) throw new Error(`secret ${name} not found`);
  await audit(db, actor.id, "secret.read", { name });
  return decryptForSpike(row.value_ciphertext);
}

export async function actorFor(db: PGlite, id: string): Promise<Actor> {
  const row = (await db.query<{ roles: string[] }>(
    "select roles from users where id=$1",
    [id],
  )).rows[0];
  return { id, roles: row?.roles ?? [] };
}

export async function inspect(db: PGlite) {
  return {
    users: (await db.query("select id, roles from users order by id")).rows,
    permissions: (await db.query(
      "select role_name, action, resource from role_permissions order by role_name, action",
    )).rows,
    audit: (await db.query(
      "select actor_id, event_type, details from audit_events order by created_at",
    )).rows,
  };
}

async function requirePermission(
  db: PGlite,
  actor: Actor,
  action: string,
  resource: string,
) {
  if (actor.roles.includes("super_admin")) return;
  const allowed = (await db.query(
    "select 1 from role_permissions where role_name = any($1) and (action=$2 or action='*') and (resource=$3 or resource='*') limit 1",
    [actor.roles, action, resource],
  )).rows.length > 0;
  if (!allowed) throw new Error(`permission denied: ${action} ${resource}`);
}

async function audit(
  db: PGlite,
  actorId: string,
  eventType: string,
  details: Record<string, unknown>,
) {
  await db.query(
    "insert into audit_events(id, actor_id, event_type, details) values ($1, $2, $3, $4)",
    [`audit_${crypto.randomUUID()}`, actorId, eventType, details],
  );
}

function encryptForSpike(value: string) {
  return `ciphertext:${btoa(value)}`;
}
function decryptForSpike(value: string) {
  return atob(value.replace(/^ciphertext:/, ""));
}
