import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;

export async function createDb() {
  const db = new PGlite();
  await db.exec(`
    create table changesets(id text primary key, actor_id text not null, status text not null, created_at timestamptz default now(), committed_at timestamptz);
    create table object_versions(
      id text primary key,
      resource text not null,
      object_id text not null,
      version integer not null,
      previous_version_id text references object_versions(id),
      changeset_id text not null references changesets(id),
      operation text not null,
      resource_revision text not null,
      snapshot_json jsonb not null,
      changed_fields text[] not null,
      actor_id text not null,
      created_at timestamptz default now(),
      unique(resource, object_id, version)
    );
    create table res_lead(
      id text primary key,
      version integer not null default 0,
      current_object_version_id text references object_versions(id),
      archived_at timestamptz,
      name text not null,
      status text not null,
      email text
    );
    create table audit_events(
      id text primary key,
      changeset_id text references changesets(id),
      object_version_id text references object_versions(id),
      actor_id text not null,
      event_type text not null,
      resource text,
      object_id text,
      action text,
      decision text,
      policy_summary_json jsonb,
      validation_summary_json jsonb,
      hook_execution_ids text[] not null default '{}',
      request_metadata_json jsonb not null default '{}',
      created_at timestamptz default now()
    );
    create table events(
      id text primary key,
      changeset_id text not null references changesets(id),
      object_version_id text references object_versions(id),
      event_type text not null,
      resource text,
      object_id text,
      occurred_at timestamptz default now(),
      payload_json jsonb not null default '{}'
    );
    create table outbox(
      id text primary key,
      event_id text not null references events(id),
      hook_name text not null,
      hook_revision text not null,
      script_digest text not null,
      envelope_json jsonb not null,
      status text not null default 'pending',
      attempts integer not null default 0,
      available_at timestamptz default now(),
      locked_by text,
      locked_at timestamptz,
      last_error text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
    create table hook_executions(
      id text primary key,
      outbox_id text references outbox(id),
      hook_name text not null,
      script_digest text not null,
      status text not null,
      stdout_json jsonb,
      stderr_text text,
      duration_ms integer,
      created_at timestamptz default now()
    );
  `);
  return db;
}

export async function commitCreateLead(db: PGlite) {
  await db.exec("begin");
  try {
    const changesetId = "cs_create_lead";
    await db.query(
      "insert into changesets(id, actor_id, status) values ($1, 'agent_1', 'committing')",
      [changesetId],
    );
    await db.query(
      "insert into res_lead(id, version, name, status, email) values ('lead_1', 1, 'Ada', 'new', 'ada@example.com')",
    );
    const snapshot = await currentLead(db, "lead_1");
    await insertObjectVersionAndSideEffects(db, {
      changesetId,
      actor: "agent_1",
      resource: "lead",
      objectId: "lead_1",
      operation: "create",
      previousVersionId: null,
      version: 1,
      snapshot,
      changedFields: ["id", "name", "status", "email"],
      eventType: "object.created",
    });
    await db.query(
      "update changesets set status='committed', committed_at=now() where id=$1",
      [changesetId],
    );
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

export async function commitUpdateLead(db: PGlite) {
  await db.exec("begin");
  try {
    const changesetId = "cs_update_lead";
    const before = await currentLead(db, "lead_1");
    await db.query(
      "insert into changesets(id, actor_id, status) values ($1, 'agent_2', 'committing')",
      [changesetId],
    );
    await db.query(
      "update res_lead set status='qualified', version=version+1 where id='lead_1' and version=1",
    );
    const snapshot = await currentLead(db, "lead_1");
    await insertObjectVersionAndSideEffects(db, {
      changesetId,
      actor: "agent_2",
      resource: "lead",
      objectId: "lead_1",
      operation: "transition",
      previousVersionId: String(before.current_object_version_id),
      version: Number(snapshot.version),
      snapshot,
      changedFields: ["status"],
      eventType: "object.transitioned",
    });
    await db.query(
      "update changesets set status='committed', committed_at=now() where id=$1",
      [changesetId],
    );
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function insertObjectVersionAndSideEffects(
  db: PGlite,
  input: {
    changesetId: string;
    actor: string;
    resource: string;
    objectId: string;
    operation: string;
    previousVersionId: string | null;
    version: number;
    snapshot: Json;
    changedFields: string[];
    eventType: string;
  },
) {
  const ovId = `ov_${digest(`${input.objectId}:${input.version}`)}`;
  await db.query(
    "insert into object_versions(id, resource, object_id, version, previous_version_id, changeset_id, operation, resource_revision, snapshot_json, changed_fields, actor_id) values ($1,$2,$3,$4,$5,$6,$7,'crm@v1',$8,$9,$10)",
    [
      ovId,
      input.resource,
      input.objectId,
      input.version,
      input.previousVersionId,
      input.changesetId,
      input.operation,
      input.snapshot,
      input.changedFields,
      input.actor,
    ],
  );
  await db.query(
    "update res_lead set current_object_version_id=$1 where id=$2",
    [ovId, input.objectId],
  );
  const auditId = `audit_${digest(`audit:${ovId}`)}`;
  await db.query(
    "insert into audit_events(id, changeset_id, object_version_id, actor_id, event_type, resource, object_id, action, decision, policy_summary_json, validation_summary_json) values ($1,$2,$3,$4,$5,$6,$7,$8,'committed',$9,$10)",
    [
      auditId,
      input.changesetId,
      ovId,
      input.actor,
      input.eventType,
      input.resource,
      input.objectId,
      input.operation,
      { allow: true },
      { errors: [] },
    ],
  );
  const eventId = `event_${digest(`event:${ovId}`)}`;
  await db.query(
    "insert into events(id, changeset_id, object_version_id, event_type, resource, object_id, payload_json) values ($1,$2,$3,$4,$5,$6,$7)",
    [
      eventId,
      input.changesetId,
      ovId,
      input.eventType,
      input.resource,
      input.objectId,
      { changed_fields: input.changedFields },
    ],
  );
  await db.query(
    "insert into outbox(id, event_id, hook_name, hook_revision, script_digest, envelope_json) values ($1,$2,'notify_lead_change','crm@v1','fnv1a32:hook',$3)",
    [`outbox_${digest(`outbox:${eventId}`)}`, eventId, {
      event_id: eventId,
      object_version_id: ovId,
    }],
  );
}

export async function processOutbox(db: PGlite) {
  await db.exec("begin");
  const row = (await db.query<Json>(
    "select * from outbox where status='pending' order by created_at limit 1 for update",
  )).rows[0];
  if (!row) {
    await db.exec("commit");
    return null;
  }
  await db.query(
    "update outbox set status='running', locked_by='worker_1', locked_at=now(), attempts=attempts+1 where id=$1",
    [row.id],
  );
  const event = (await db.query<Json>(
    "select e.*, ov.snapshot_json from events e join object_versions ov on ov.id=e.object_version_id where e.id=$1",
    [row.event_id],
  )).rows[0];
  const executionId = `hexec_${digest(String(row.id))}`;
  await db.query(
    "insert into hook_executions(id, outbox_id, hook_name, script_digest, status, stdout_json, stderr_text, duration_ms) values ($1,$2,$3,$4,'succeeded',$5,'',1)",
    [executionId, row.id, row.hook_name, row.script_digest, {
      delivered: true,
      object: event.snapshot_json,
    }],
  );
  await db.query(
    "update outbox set status='succeeded', updated_at=now() where id=$1",
    [row.id],
  );
  await db.exec("commit");
  return executionId;
}

async function currentLead(db: PGlite, id: string): Promise<Json> {
  return (await db.query<Json>("select * from res_lead where id=$1", [id]))
    .rows[0];
}

export async function inspect(db: PGlite) {
  return {
    current: (await db.query(
      "select id, version, current_object_version_id, status from res_lead order by id",
    )).rows,
    versions: (await db.query(
      "select id, object_id, version, previous_version_id, changed_fields from object_versions order by version",
    )).rows,
    audit: (await db.query(
      "select event_type, object_version_id, decision from audit_events order by created_at",
    )).rows,
    events: (await db.query(
      "select event_type, object_version_id, payload_json from events order by occurred_at",
    )).rows,
    outbox: (await db.query(
      "select status, event_id, hook_name from outbox order by created_at",
    )).rows,
    executions: (await db.query(
      "select status, hook_name, outbox_id from hook_executions order by created_at",
    )).rows,
  };
}

function digest(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

if (import.meta.main) {
  const db = await createDb();
  await commitCreateLead(db);
  await commitUpdateLead(db);
  await processOutbox(db);
  await processOutbox(db);
  console.log(JSON.stringify(await inspect(db), null, 2));
}
