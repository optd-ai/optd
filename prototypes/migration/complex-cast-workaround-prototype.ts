import { PGlite } from "npm:@electric-sql/pglite";

type Field = { type: "string" | "integer"; required?: boolean };
type Pack = { resources: Record<string, { fields: Record<string, Field> }> };
type Issue = {
  id: string;
  change: string;
  class: "safe" | "blocking" | "destructive";
  target: string;
  reason: string;
  suggestion: string;
  facts?: Record<string, unknown>;
};

const v1: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "string", required: true },
        score_text: { type: "string" },
      },
    },
  },
};
const directV2: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "string", required: true },
        score_text: { type: "integer" },
      },
    },
  },
};
const workaroundV2: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "string", required: true },
        score_text: { type: "string" },
        score: { type: "integer" },
      },
    },
  },
};
const finalV3: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "string", required: true },
        score: { type: "integer" },
      },
    },
  },
};

async function main() {
  const db = new PGlite();
  await initialize(db, v1);
  await seed(db);

  console.log("# 1. Direct unsupported type change is blocked");
  const directIssues = await preview(db, v1, directV2);
  print(directIssues);

  console.log("\n# 2. Agent workaround pack adds a new integer field instead");
  const workaroundIssues = await preview(db, v1, workaroundV2);
  print(workaroundIssues);
  await applySafeAdditive(db, v1, workaroundV2, workaroundIssues);
  print(await inspectLead(db));

  console.log(
    "\n# 3. Agent-generated changeset backfill attempts parse to integer",
  );
  await applyScoreBackfillChangeset(db);
  print(await inspectBackfillState(db));

  console.log("\n# 4. Revalidation still blocked by invalid source values");
  print(await validateScoreBackfill(db));

  console.log("\n# 5. Agent fixes invalid rows with ordinary changesets");
  await fixInvalidScoreRows(db);
  print(await validateScoreBackfill(db));

  console.log(
    "\n# 6. Final pack removes old string field after readers/writers moved",
  );
  const finalIssues = await preview(db, workaroundV2, finalV3);
  print(finalIssues);
  await stageRemoveField(db, "lead", "score_text");
  print(await inspectPlatformFields(db));

  console.log(
    "\n# 7. Old field cleanup is blocked until source values are cleared",
  );
  print(await validateRemovedField(db, "lead", "score_text"));

  console.log(
    "\n# 8. Agent clears old field through ordinary changeset, then destructive cleanup proceeds",
  );
  await clearOldScoreText(db);
  const cleanupValidation = await validateRemovedField(
    db,
    "lead",
    "score_text",
  );
  print(cleanupValidation);
  const token = confirmationToken(finalIssues);
  print({ token });
  await applyDestructiveDrop(db, finalIssues, token);
  print(await finalState(db));
}

async function initialize(db: PGlite, pack: Pack) {
  await db.exec(`
    create table platform_fields(resource text, field text, deprecated boolean default false, write_blocked boolean default false, primary key(resource, field));
    create table changesets(id text primary key, description text, committed_at timestamptz default now());
    create table audit_events(id text primary key, event text, details jsonb, created_at timestamptz default now());
  `);
  for (const [resource, spec] of Object.entries(pack.resources)) {
    const cols = [
      "id text primary key",
      "version integer not null default 1",
      "archived_at timestamptz",
    ];
    for (const [field, def] of Object.entries(spec.fields)) {
      cols.push(
        `${qi(field)} ${sqlType(def.type)}${def.required ? " not null" : ""}`,
      );
      await db.query(
        "insert into platform_fields(resource, field) values ($1, $2)",
        [resource, field],
      );
    }
    await db.exec(
      `create table ${qi(tableName(resource))} (${cols.join(", ")});`,
    );
  }
}

async function seed(db: PGlite) {
  await db.exec(`
    insert into res_lead(id, name, score_text) values
      ('lead_1', 'Ada', '42'),
      ('lead_2', 'Grace', 'not-a-number'),
      ('lead_3', 'Linus', '7'),
      ('lead_4', 'Margaret', null);
  `);
}

async function preview(
  db: PGlite,
  current: Pack,
  desired: Pack,
): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const [resource, cur] of Object.entries(current.resources)) {
    const next = desired.resources[resource];
    if (!next) continue;
    const all = new Set([
      ...Object.keys(cur.fields),
      ...Object.keys(next.fields),
    ]);
    for (const field of [...all].sort()) {
      const a = cur.fields[field];
      const b = next.fields[field];
      const target = `${resource}.${field}`;
      if (!a && b) {
        issues.push({
          id: `field:add:${target}`,
          change: "add_field",
          class: "safe",
          target,
          reason: "new field is additive",
          suggestion: "add column",
        });
      } else if (a && !b) {
        const present = await presentCount(db, resource, field);
        issues.push({
          id: `field:remove:${target}`,
          change: "remove_field",
          class: "destructive",
          target,
          reason: "field removed from desired pack",
          facts: { presentValues: present },
          suggestion:
            "deprecate field, block writes, clear values with ordinary changesets, then confirm destructive drop",
        });
      } else if (a && b && a.type !== b.type) {
        const cast = generatedCast(a.type, b.type);
        issues.push({
          id: `field:type:${target}`,
          change: "change_field_type",
          class: cast ? "destructive" : "blocking",
          target,
          reason: cast
            ? `platform can stage generated cast ${cast}`
            : "type change has no supported generated cast",
          facts: { from: a.type, to: b.type, generatedCast: cast },
          suggestion: cast
            ? "stage generated cast"
            : "add a new field, backfill with ordinary changesets/action hooks, move readers/writers, then remove old field later",
        });
      }
    }
  }
  return issues;
}

async function applySafeAdditive(
  db: PGlite,
  current: Pack,
  desired: Pack,
  issues: Issue[],
) {
  for (
    const issue of issues.filter((i) =>
      i.change === "add_field" && i.class === "safe"
    )
  ) {
    const [resource, field] = issue.target.split(".");
    if (!current.resources[resource].fields[field]) {
      const def = desired.resources[resource].fields[field];
      await db.exec(
        `alter table ${qi(tableName(resource))} add column ${qi(field)} ${
          sqlType(def.type)
        };`,
      );
      await db.query(
        "insert into platform_fields(resource, field) values ($1, $2)",
        [resource, field],
      );
      await audit(db, "safe_field_added", { target: issue.target });
    }
  }
}

async function applyScoreBackfillChangeset(db: PGlite) {
  await db.exec(`
    insert into changesets(id, description) values ('cs_backfill_score', 'parse score_text into score where valid');
    update res_lead
    set score = score_text::integer, version = version + 1
    where score_text ~ '^[0-9]+$';
  `);
  await audit(db, "changeset_committed", { id: "cs_backfill_score" });
}

async function validateScoreBackfill(db: PGlite) {
  const missing = await db.query<{ count: number }>(
    `select count(*)::int as count from res_lead where score_text is not null and score is null`,
  );
  const invalid = await db.query<{ id: string; score_text: string }>(
    `select id, score_text from res_lead where score_text is not null and score_text !~ '^[0-9]+$' order by id`,
  );
  return {
    ready: missing.rows[0].count === 0,
    blockers: invalid.rows.map((row) => ({
      target: `lead.${row.id}.score_text`,
      reason: "score_text cannot parse as integer",
      value: row.score_text,
    })),
  };
}

async function fixInvalidScoreRows(db: PGlite) {
  await db.exec(`
    insert into changesets(id, description) values ('cs_fix_invalid_score', 'manual agent fix for invalid score values');
    update res_lead set score = 0, score_text = '0', version = version + 1 where id = 'lead_2';
  `);
  await audit(db, "changeset_committed", { id: "cs_fix_invalid_score" });
}

async function stageRemoveField(db: PGlite, resource: string, field: string) {
  await db.query(
    "update platform_fields set deprecated=true, write_blocked=true where resource=$1 and field=$2",
    [resource, field],
  );
  await audit(db, "field_deprecated", { resource, field });
}

async function validateRemovedField(
  db: PGlite,
  resource: string,
  field: string,
) {
  const present = await presentCount(db, resource, field);
  return {
    ready: present === 0,
    blockers: present === 0 ? [] : [{
      target: `${resource}.${field}`,
      reason: "removed field still has present values",
      count: present,
    }],
  };
}

async function clearOldScoreText(db: PGlite) {
  await db.exec(`
    insert into changesets(id, description) values ('cs_clear_old_score_text', 'clear deprecated score_text after backfill');
    update res_lead set score_text = null, version = version + 1 where score_text is not null;
  `);
  await audit(db, "changeset_committed", { id: "cs_clear_old_score_text" });
}

function confirmationToken(issues: Issue[]) {
  return `complex_cast:${digestText(JSON.stringify(issues))}:drop-old-field`;
}

async function applyDestructiveDrop(
  db: PGlite,
  issues: Issue[],
  token: string,
) {
  if (token !== confirmationToken(issues)) {
    throw new Error("bad confirmation token");
  }
  const remove = issues.find((i) => i.change === "remove_field")!;
  const [resource, field] = remove.target.split(".");
  const validation = await validateRemovedField(db, resource, field);
  if (!validation.ready) {
    throw new Error(`still blocked: ${JSON.stringify(validation.blockers)}`);
  }
  await db.exec(
    `alter table ${qi(tableName(resource))} drop column ${qi(field)};`,
  );
  await db.query("delete from platform_fields where resource=$1 and field=$2", [
    resource,
    field,
  ]);
  await audit(db, "destructive_field_dropped", { resource, field });
}

async function inspectLead(db: PGlite) {
  const columns = await db.query(
    "select column_name, data_type from information_schema.columns where table_name='res_lead' order by ordinal_position",
  );
  return { columns: columns.rows };
}
async function inspectBackfillState(db: PGlite) {
  const rows = await db.query(
    "select id, score_text, score from res_lead order by id",
  );
  return { rows: rows.rows };
}
async function inspectPlatformFields(db: PGlite) {
  const fields = await db.query(
    "select * from platform_fields order by resource, field",
  );
  return { fields: fields.rows };
}
async function finalState(db: PGlite) {
  const columns = await db.query(
    "select column_name, data_type from information_schema.columns where table_name='res_lead' order by ordinal_position",
  );
  const rows = await db.query(
    "select id, name, score from res_lead order by id",
  );
  const audit = await db.query(
    "select event from audit_events order by created_at",
  );
  return { columns: columns.rows, rows: rows.rows, audit: audit.rows };
}

async function presentCount(db: PGlite, resource: string, field: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${qi(tableName(resource))} where ${
      qi(field)
    } is not null`,
  );
  return result.rows[0].count;
}
async function audit(
  db: PGlite,
  event: string,
  details: Record<string, unknown>,
) {
  await db.query(
    "insert into audit_events(id, event, details) values ($1, $2, $3)",
    [
      `audit_${digestText(`${event}:${JSON.stringify(details)}`).slice(-10)}`,
      event,
      details,
    ],
  );
}
function generatedCast(from: Field["type"], to: Field["type"]) {
  if (from === "integer" && to === "string") return "integer_to_string";
  return null;
}
function sqlType(type: Field["type"]) {
  return type === "integer" ? "integer" : "text";
}
function tableName(resource: string) {
  return `res_${resource}`;
}
function qi(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier ${identifier}`);
  }
  return `"${identifier}"`;
}
function digestText(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

if (import.meta.main) await main();
