import { PGlite } from "npm:@electric-sql/pglite";

type Field = { type: "text" | "integer"; required?: boolean };
type Resource = {
  fields: Record<string, Field>;
  lifecycle?: { field: string; states: string[] };
};
type Pack = { resources: Record<string, Resource> };
type FindingClass = "destructive" | "blocking" | "risky" | "safe";
type Finding = {
  id: string;
  class: FindingClass;
  target: string;
  change: string;
  reason: string;
  facts?: Record<string, unknown>;
  stageAction: string;
};

type Plan = {
  id: string;
  findings: Finding[];
  stageSteps: string[];
  cleanupHints: string[];
  destructiveSteps: string[];
  digest: string;
};

const currentPack: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "text", required: true },
        company_name: { type: "text" },
        score: { type: "integer" },
        state: { type: "text" },
      },
      lifecycle: { field: "state", states: ["new", "contacted", "done"] },
    },
    note: {
      fields: { title: { type: "text", required: true } },
    },
  },
};

const desiredPack: Pack = {
  resources: {
    lead: {
      fields: {
        name: { type: "text", required: true },
        score: { type: "text" },
        state: { type: "text" },
      },
      lifecycle: { field: "state", states: ["new", "done"] },
    },
  },
};

async function main() {
  const db = new PGlite();
  await initialize(db, currentPack);
  await seed(db);

  console.log("# 1. Preview destructive migration");
  const plan = await previewMigration(db, currentPack, desiredPack);
  print(plan);

  console.log("\n# 2. Apply non-destructive staging only");
  await applyStage(db, plan);
  print(await inspectPlatformState(db));

  console.log("\n# 3. Validate after staging: blockers remain");
  print(await validatePlan(db, plan));

  console.log("\n# 4. Generic cleanup/backfill actions chosen by user/agent");
  await cleanupForPrototype(db);
  print(await validatePlan(db, plan));

  console.log("\n# 5. Generate digest-bound confirmation token");
  const token = confirmationToken(plan);
  print({ token });

  console.log("\n# 6. Apply destructive cleanup with confirmation");
  await applyDestructive(db, plan, token);
  print(await finalIntrospection(db));
}

async function initialize(db: PGlite, pack: Pack) {
  await db.exec(`
    create table platform_resources(resource text primary key, deprecated boolean default false, create_blocked boolean default false);
    create table platform_fields(resource text, field text, deprecated boolean default false, write_blocked boolean default false, primary key(resource, field));
    create table migration_audit(ts timestamptz default now(), event text, details jsonb);
    create table migration_exports(id text primary key, resource text, field text, row_count integer, payload jsonb);
  `);
  for (const [resource, spec] of Object.entries(pack.resources)) {
    await db.query("insert into platform_resources(resource) values ($1)", [
      resource,
    ]);
    const cols = ["id text primary key", "archived_at timestamptz"];
    for (const [field, def] of Object.entries(spec.fields)) {
      cols.push(`${qi(field)} ${sqlType(def.type)}`);
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
    insert into res_lead(id, name, company_name, score, state) values
      ('a1', 'one', 'Acme', 1, 'new'),
      ('a2', 'two', 'Globex', 2, 'contacted'),
      ('a3', 'three', null, 3, 'done');
    insert into res_note(id, title) values ('b1', 'first note'), ('b2', 'second note');
  `);
}

async function previewMigration(
  db: PGlite,
  current: Pack,
  desired: Pack,
): Promise<Plan> {
  const findings: Finding[] = [];
  const stageSteps: string[] = [];
  const cleanupHints: string[] = [];
  const destructiveSteps: string[] = [];

  for (const [resource, cur] of Object.entries(current.resources)) {
    const next = desired.resources[resource];
    if (!next) {
      const rows = await rowCount(db, resource);
      findings.push({
        id: `remove-resource:${resource}`,
        class: rows > 0 ? "blocking" : "destructive",
        target: resource,
        change: "remove_resource",
        reason: "resource removed from desired pack",
        facts: { rows },
        stageAction: "deprecate resource and block creates",
      });
      stageSteps.push(`deprecate resource ${resource}; block creates`);
      cleanupHints.push(
        `archive/export/delete ${rows} rows from ${resource} before drop`,
      );
      destructiveSteps.push(
        `drop table ${tableName(resource)}; remove platform resource metadata`,
      );
      continue;
    }

    for (const [field, curField] of Object.entries(cur.fields)) {
      const nextField = next.fields[field];
      if (!nextField) {
        const present = await presentCount(db, resource, field);
        findings.push({
          id: `remove-field:${resource}.${field}`,
          class: present > 0 ? "blocking" : "destructive",
          target: `${resource}.${field}`,
          change: "remove_field",
          reason: "field removed from desired resource",
          facts: { present },
          stageAction: "deprecate field and block writes",
        });
        stageSteps.push(`deprecate field ${resource}.${field}; block writes`);
        cleanupHints.push(
          `export and clear ${present} present values for ${resource}.${field}`,
        );
        destructiveSteps.push(
          `alter table ${tableName(resource)} drop column ${field}`,
        );
      } else if (curField.type !== nextField.type) {
        const replacement = `__new_${field}`;
        findings.push({
          id: `change-type:${resource}.${field}`,
          class: "destructive",
          target: `${resource}.${field}`,
          change: "change_field_type",
          reason: `field type changes ${curField.type} -> ${nextField.type}`,
          stageAction: "add replacement column, backfill, deprecate old field",
        });
        stageSteps.push(
          `add replacement field ${resource}.${replacement} (${nextField.type}); backfill from ${field}; deprecate old field`,
        );
        cleanupHints.push(
          `verify replacement values for ${resource}.${replacement}`,
        );
        destructiveSteps.push(
          `drop old column ${field}; rename ${replacement} to ${field}`,
        );
      }
    }

    const removedStates = (cur.lifecycle?.states ?? []).filter((state) =>
      !(next.lifecycle?.states ?? []).includes(state)
    );
    for (const state of removedStates) {
      const count = await stateCount(db, resource, cur.lifecycle!.field, state);
      findings.push({
        id: `remove-state:${resource}.${state}`,
        class: count > 0 ? "blocking" : "destructive",
        target: `${resource}.${state}`,
        change: "remove_lifecycle_state",
        reason: "lifecycle state removed",
        facts: { rows: count },
        stageAction: "block new transitions into removed state",
      });
      stageSteps.push(
        `mark lifecycle state ${resource}.${state} deprecated; block new transitions into it`,
      );
      cleanupHints.push(
        `map ${count} rows in state ${state} to an allowed state`,
      );
      destructiveSteps.push(
        `remove lifecycle state ${resource}.${state} from active config`,
      );
    }
  }

  const id = "mig_pglite_destructive_demo";
  const planDigest = digest(
    JSON.stringify({ findings, stageSteps, destructiveSteps }),
  );
  return {
    id,
    findings,
    stageSteps,
    cleanupHints,
    destructiveSteps,
    digest: planDigest,
  };
}

async function applyStage(db: PGlite, plan: Plan) {
  await db.query(
    "insert into migration_audit(event, details) values ('stage_start', $1)",
    [plan as unknown as Record<string, unknown>],
  );
  for (const finding of plan.findings) {
    if (finding.change === "remove_resource") {
      await db.query(
        "update platform_resources set deprecated=true, create_blocked=true where resource=$1",
        [finding.target],
      );
    }
    if (finding.change === "remove_field") {
      const [resource, field] = finding.target.split(".");
      await db.query(
        "update platform_fields set deprecated=true, write_blocked=true where resource=$1 and field=$2",
        [resource, field],
      );
    }
    if (finding.change === "change_field_type") {
      const [resource, field] = finding.target.split(".");
      const replacement = `__new_${field}`;
      await db.exec(
        `alter table ${qi(tableName(resource))} add column if not exists ${
          qi(replacement)
        } text;`,
      );
      await db.exec(
        `update ${qi(tableName(resource))} set ${qi(replacement)} = ${
          qi(field)
        }::text;`,
      );
      await db.query(
        "insert into platform_fields(resource, field, deprecated, write_blocked) values ($1, $2, false, false) on conflict do nothing",
        [resource, replacement],
      );
      await db.query(
        "update platform_fields set deprecated=true, write_blocked=true where resource=$1 and field=$2",
        [resource, field],
      );
    }
  }
  await db.query(
    "insert into migration_audit(event, details) values ('stage_done', $1)",
    [{ plan: plan.id }],
  );
}

async function validatePlan(db: PGlite, plan: Plan) {
  const blockers = [];
  for (const finding of plan.findings) {
    if (finding.change === "remove_field") {
      const [resource, field] = finding.target.split(".");
      const present = await presentCount(db, resource, field);
      if (present > 0) {
        blockers.push({
          target: finding.target,
          reason: "field still has present values",
          score: present,
        });
      }
    }
    if (finding.change === "remove_resource") {
      const rows = await activeRowCount(db, finding.target);
      if (rows > 0) {
        blockers.push({
          target: finding.target,
          reason: "resource still has active rows",
          count: rows,
        });
      }
    }
    if (finding.change === "remove_lifecycle_state") {
      const [resource, state] = finding.target.split(".");
      const field = currentPack.resources[resource].lifecycle!.field;
      const count = await stateCount(db, resource, field, state);
      if (count > 0) {
        blockers.push({
          target: finding.target,
          reason: "rows still use removed state",
          count,
        });
      }
    }
  }
  return { ready: blockers.length === 0, blockers };
}

async function cleanupForPrototype(db: PGlite) {
  // Generic cleanup choices an agent/user could make after inspecting preview.
  await db.exec(`
    insert into migration_exports(id, resource, field, row_count, payload)
    select 'export_lead_company_name', 'lead', 'company_name', count(*), jsonb_agg(jsonb_build_object('id', id, 'company_name', company_name))
    from res_lead where company_name is not null;
    update res_lead set company_name = null where company_name is not null;
    update res_lead set state = 'done' where state = 'contacted';
    update res_note set archived_at = now() where archived_at is null;
  `);
}

function confirmationToken(plan: Plan) {
  return `${plan.id}:${plan.digest}:destructive-cleanup`;
}

async function applyDestructive(db: PGlite, plan: Plan, token: string) {
  if (token !== confirmationToken(plan)) {
    throw new Error("confirmation token does not match plan digest");
  }
  const validation = await validatePlan(db, plan);
  if (!validation.ready) {
    throw new Error(
      `plan still has blockers: ${JSON.stringify(validation.blockers)}`,
    );
  }

  await db.query(
    "insert into migration_audit(event, details) values ('destructive_start', $1)",
    [{ plan: plan.id, digest: plan.digest }],
  );
  await db.exec(`alter table res_lead drop column company_name;`);
  await db.exec(`alter table res_lead drop column score;`);
  await db.exec(`alter table res_lead rename column __new_score to score;`);
  await db.exec(`drop table res_note;`);
  await db.query(
    "delete from platform_fields where resource='lead' and field in ('company_name')",
  );
  await db.query("delete from platform_resources where resource='note'");
  await db.query(
    "insert into migration_audit(event, details) values ('destructive_done', $1)",
    [{ plan: plan.id }],
  );
}

async function inspectPlatformState(db: PGlite) {
  const resources = await db.query(
    "select * from platform_resources order by resource",
  );
  const fields = await db.query(
    "select * from platform_fields order by resource, field",
  );
  return { resources: resources.rows, fields: fields.rows };
}

async function finalIntrospection(db: PGlite) {
  const tables = await db.query(
    "select tablename from pg_tables where schemaname='public' order by tablename",
  );
  const cols = await db.query(
    "select table_name, column_name, data_type from information_schema.columns where table_schema='public' and table_name like 'res_%' order by table_name, ordinal_position",
  );
  const audit = await db.query("select event from migration_audit order by ts");
  const exports = await db.query(
    "select id, resource, field, row_count from migration_exports order by id",
  );
  return {
    tables: tables.rows,
    columns: cols.rows,
    audit: audit.rows,
    exports: exports.rows,
  };
}

async function rowCount(db: PGlite, resource: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${qi(tableName(resource))}`,
  );
  return result.rows[0].count;
}
async function activeRowCount(db: PGlite, resource: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${
      qi(tableName(resource))
    } where archived_at is null`,
  );
  return result.rows[0].count;
}
async function presentCount(db: PGlite, resource: string, field: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${qi(tableName(resource))} where ${
      qi(field)
    } is not null`,
  );
  return result.rows[0].count;
}
async function stateCount(
  db: PGlite,
  resource: string,
  field: string,
  state: string,
) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${qi(tableName(resource))} where ${
      qi(field)
    } = $1`,
    [state],
  );
  return result.rows[0].count;
}

function tableName(resource: string) {
  return `res_${resource}`;
}
function sqlType(type: Field["type"]) {
  return type === "integer" ? "integer" : "text";
}
function qi(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier ${identifier}`);
  }
  return `"${identifier}"`;
}
function digest(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function print(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

if (import.meta.main) await main();
