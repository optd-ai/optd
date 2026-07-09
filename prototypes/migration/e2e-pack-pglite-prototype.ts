import { PGlite } from "npm:@electric-sql/pglite";
import {
  classifyScenario,
  loadPackDir,
  summarize,
} from "./migration-prototype.ts";

type Json = Record<string, unknown>;
type Field = { type: string; required?: boolean; ref?: string };
type Index = { name: string; type?: string; fields: string[]; where?: string };
type Resource = {
  fields?: Record<string, Field>;
  indexes?: Index[];
  lifecycle?: { field: string; states: string[] };
};
type Pack = {
  resources: Record<string, Resource>;
  actions?: Record<string, Json>;
  hooks?: Record<string, Json>;
};
type Issue = {
  id: string;
  target: string;
  change: string;
  class: "safe" | "risky" | "destructive" | "blocking";
  reason: string;
  facts?: Json;
  suggestion: string;
  hazards?: string[];
};
type LiveFacts = {
  rows: Record<string, number>;
  presentValues: Record<string, number>;
  violations: Record<string, number>;
  duplicates: Record<string, number>;
  references: Record<string, string[]>;
  tableSize: Record<string, "small" | "medium" | "large">;
};
type MigrationPlan = {
  id: string;
  fromRevision: string;
  toRevision: string;
  digest: string;
  summary: ReturnType<typeof summarize>;
  issues: Issue[];
  stages: string[];
};

const currentPackDir = new URL("./packs/crm-v1", import.meta.url).pathname;
const desiredPackDir = new URL("./packs/crm-v2", import.meta.url).pathname;

async function main() {
  const current = await loadPackDir(currentPackDir) as Pack;
  const desired = await loadPackDir(desiredPackDir) as Pack;
  const db = new PGlite();

  console.log("# 1. Apply active CRM v1 pack to a real PGlite database");
  await initializePlatform(db);
  await applyInitialPack(db, "crm@0.1.0", current);
  await seedCrmData(db);
  print(await inspectSchema(db));

  console.log(
    "\n# 2. Upload/preview CRM v2 and compute migration plan from pack diff + live DB facts",
  );
  const live = await collectLiveFacts(db, current, desired);
  const issues = classifyScenario({
    name: "e2e PGlite pack diff",
    current,
    desired,
    live,
  }) as Issue[];
  const plan = buildMigrationPlan(issues);
  print({
    live,
    summary: plan.summary,
    issues: plan.issues,
    stages: plan.stages,
  });

  console.log("\n# 3. Apply safe additive changes only");
  await applySafeChanges(db, current, desired, plan);
  print(await inspectSchema(db));

  console.log("\n# 4. Review risky changes and apply non-destructive staging");
  await applyRiskyReviewedChanges(db, desired, plan);
  await applyDestructiveStaging(db, current, desired, plan);
  print(await inspectPlatformState(db));

  console.log("\n# 5. Validate staged migration; blockers remain");
  print(await validateMigration(db, current, desired, plan));

  console.log(
    "\n# 6. Apply explicit cleanup/backfill changeset-like operations",
  );
  await applyCleanupChangeset(db);
  print(await validateMigration(db, current, desired, plan));

  console.log(
    "\n# 7. Preview destructive cleanup and generate digest-bound confirmation token",
  );
  const token = confirmationToken(plan);
  print({ destructiveSteps: destructiveSteps(plan), token });

  console.log("\n# 8. Apply destructive cleanup and activate CRM v2 revision");
  await applyDestructiveCleanup(db, current, desired, plan, token);
  await activateRevision(db, "crm@0.2.0");
  print(await finalState(db));
}

async function initializePlatform(db: PGlite) {
  await db.exec(`
    create table platform_revisions(revision text primary key, active boolean default false, pack jsonb not null);
    create table platform_resources(resource text primary key, deprecated boolean default false, create_blocked boolean default false);
    create table platform_fields(resource text, field text, deprecated boolean default false, write_blocked boolean default false, replacement_field text, primary key(resource, field));
    create table platform_actions(action text primary key, reviewed boolean default false, spec jsonb not null);
    create table platform_hooks(hook text primary key, reviewed boolean default false, spec jsonb not null);
    create table migration_audit(ts timestamptz default now(), event text, details jsonb);
    create table migration_exports(id text primary key, resource text, field text, row_count integer, payload jsonb);
  `);
}

async function applyInitialPack(db: PGlite, revision: string, pack: Pack) {
  await db.query(
    "insert into platform_revisions(revision, active, pack) values ($1, true, $2)",
    [revision, pack as unknown as Json],
  );
  for (const [resource, spec] of Object.entries(pack.resources)) {
    await db.query("insert into platform_resources(resource) values ($1)", [
      resource,
    ]);
    const cols = ["id text primary key", "archived_at timestamptz"];
    for (const [field, def] of Object.entries(spec.fields ?? {})) {
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
  for (const [action, spec] of Object.entries(pack.actions ?? {})) {
    await db.query(
      "insert into platform_actions(action, spec) values ($1, $2)",
      [
        action,
        spec,
      ],
    );
  }
  for (const [hook, spec] of Object.entries(pack.hooks ?? {})) {
    await db.query("insert into platform_hooks(hook, spec) values ($1, $2)", [
      hook,
      spec,
    ]);
  }
}

async function seedCrmData(db: PGlite) {
  await db.exec(`
    insert into res_lead(id, name, email, company_name, score, status) values
      ('lead_1', 'Ada', null, 'Acme', 10, 'new'),
      ('lead_2', 'Grace', 'dup@example.com', 'Globex', 20, 'contacted'),
      ('lead_3', 'Linus', 'dup@example.com', null, 30, 'qualified'),
      ('lead_4', 'Margaret', 'margaret@example.com', 'Initech', null, 'converted');
    insert into res_note(id, body, lead_id) values
      ('note_1', 'call back', 'lead_1'),
      ('note_2', 'pricing requested', 'lead_2');
  `);
}

async function collectLiveFacts(
  db: PGlite,
  current: Pack,
  desired: Pack,
): Promise<LiveFacts> {
  const rows: Record<string, number> = {};
  const presentValues: Record<string, number> = {};
  const violations: Record<string, number> = {};
  const duplicates: Record<string, number> = {};
  const references: Record<string, string[]> = {
    "lead.company_name": ["hook:convert_lead"],
    "lead.score": ["axi:list"],
    "hook:convert_lead": ["action:convert_lead"],
  };
  const tableSize: Record<string, "small" | "medium" | "large"> = {};

  for (const [resource, spec] of Object.entries(current.resources)) {
    rows[resource] = await rowCount(db, resource);
    tableSize[resource] = rows[resource] > 100_000 ? "large" : "small";
    for (const field of Object.keys(spec.fields ?? {})) {
      presentValues[`${resource}.${field}`] = await presentCount(
        db,
        resource,
        field,
      );
    }
  }

  for (const [resource, desiredSpec] of Object.entries(desired.resources)) {
    const currentSpec = current.resources[resource];
    if (!currentSpec) continue;
    for (const [field, def] of Object.entries(desiredSpec.fields ?? {})) {
      if (
        def.required && currentSpec.fields?.[field] &&
        !currentSpec.fields[field].required
      ) {
        violations[`required:${resource}.${field}`] = await nullCount(
          db,
          resource,
          field,
        );
      }
    }
    const removedStates = (currentSpec.lifecycle?.states ?? []).filter((
      state,
    ) => !(desiredSpec.lifecycle?.states ?? []).includes(state));
    for (const state of removedStates) {
      const stateField = currentSpec.lifecycle!.field;
      violations[`state:${resource}.${state}`] = await stateCount(
        db,
        resource,
        stateField,
        state,
      );
    }
    for (const index of desiredSpec.indexes ?? []) {
      if (index.type === "unique" && index.fields.length === 1) {
        duplicates[`${resource}.${index.name}`] = await duplicateCount(
          db,
          resource,
          index.fields[0],
          index.where,
        );
      }
    }
  }

  return { rows, presentValues, violations, duplicates, references, tableSize };
}

function buildMigrationPlan(issues: Issue[]): MigrationPlan {
  const planCore = {
    issues: issues.map((issue) => ({
      id: issue.id,
      target: issue.target,
      change: issue.change,
      class: issue.class,
    })),
  };
  return {
    id: "mig_e2e_crm_v1_to_v2",
    fromRevision: "crm@0.1.0",
    toRevision: "crm@0.2.0",
    digest: digestText(JSON.stringify(planCore)),
    summary: summarize(issues),
    issues,
    stages: [
      "safe-additive",
      "review-risky",
      "stage-destructive",
      "cleanup-backfill",
      "destructive-confirmed-cleanup",
      "activate-desired-revision",
    ],
  };
}

async function applySafeChanges(
  db: PGlite,
  current: Pack,
  desired: Pack,
  plan: MigrationPlan,
) {
  for (
    const issue of plan.issues.filter((i) =>
      i.change === "add_field" && i.class === "safe"
    )
  ) {
    const [resource, field] = issue.target.split(".");
    const def = desired.resources[resource].fields![field];
    if (!current.resources[resource].fields?.[field]) {
      await db.exec(
        `alter table ${qi(tableName(resource))} add column ${qi(field)} ${
          sqlType(def.type)
        };`,
      );
      await db.query(
        "insert into platform_fields(resource, field) values ($1, $2)",
        [resource, field],
      );
    }
  }
  await audit(db, "safe_changes_applied", { plan: plan.id });
}

async function applyRiskyReviewedChanges(
  db: PGlite,
  desired: Pack,
  plan: MigrationPlan,
) {
  for (const issue of plan.issues.filter((i) => i.class === "risky")) {
    if (issue.change === "change_action") {
      await db.query(
        "update platform_actions set reviewed=true, spec=$2 where action=$1",
        [
          issue.target,
          desired.actions?.[issue.target] ?? {},
        ],
      );
    }
    if (issue.change === "change_hook") {
      await db.query(
        "update platform_hooks set reviewed=true, spec=$2 where hook=$1",
        [
          issue.target,
          desired.hooks?.[issue.target] ?? {},
        ],
      );
    }
  }
  await audit(db, "risky_changes_reviewed", { plan: plan.id });
}

async function applyDestructiveStaging(
  db: PGlite,
  current: Pack,
  desired: Pack,
  plan: MigrationPlan,
) {
  for (const issue of plan.issues) {
    if (issue.change === "remove_field") {
      const [resource, field] = issue.target.split(".");
      await db.query(
        "update platform_fields set deprecated=true, write_blocked=true where resource=$1 and field=$2",
        [resource, field],
      );
    }
    if (issue.change === "change_field_type") {
      const [resource, field] = issue.target.split(".");
      const replacement = `__new_${field}`;
      const currentType = current.resources[resource].fields![field].type;
      const nextType = desired.resources[resource].fields![field].type;
      const castExpression = generatedCastSqlExpression(
        field,
        currentType,
        nextType,
      );
      if (!castExpression) {
        throw new Error(
          `unsupported generated cast ${currentType} -> ${nextType} for ${issue.target}`,
        );
      }
      await db.exec(
        `alter table ${qi(tableName(resource))} add column ${qi(replacement)} ${
          sqlType(nextType)
        };`,
      );
      await db.exec(
        `update ${qi(tableName(resource))} set ${
          qi(replacement)
        } = ${castExpression};`,
      );
      await db.query(
        "insert into platform_fields(resource, field, replacement_field) values ($1, $2, null)",
        [resource, replacement],
      );
      await db.query(
        "update platform_fields set deprecated=true, write_blocked=true, replacement_field=$3 where resource=$1 and field=$2",
        [resource, field, replacement],
      );
    }
    if (issue.change === "remove_resource") {
      await db.query(
        "update platform_resources set deprecated=true, create_blocked=true where resource=$1",
        [issue.target],
      );
    }
    if (issue.change === "remove_lifecycle_state") {
      await audit(db, "lifecycle_state_deprecated", { target: issue.target });
    }
  }
  await audit(db, "destructive_changes_staged", {
    plan: plan.id,
    from: currentPackDir,
    to: desiredPackDir,
    currentResources: Object.keys(current.resources),
  });
}

async function validateMigration(
  db: PGlite,
  current: Pack,
  desired: Pack,
  plan: MigrationPlan,
) {
  const blockers: Json[] = [];
  for (const issue of plan.issues) {
    if (issue.change === "make_required") {
      const [resource, field] = issue.target.split(".");
      const count = await nullCount(db, resource, field);
      if (count > 0) {
        blockers.push({
          target: issue.target,
          reason: "required field has nulls",
          count,
        });
      }
    }
    if (issue.change === "add_unique_index") {
      const [resource, indexName] = issue.target.split(".");
      const index = desired.resources[resource].indexes!.find((i) =>
        i.name === indexName
      )!;
      const count = await duplicateCount(
        db,
        resource,
        index.fields[0],
        index.where,
      );
      if (count > 0) {
        blockers.push({
          target: issue.target,
          reason: "unique index has duplicate values",
          count,
        });
      }
    }
    if (issue.change === "remove_field") {
      const [resource, field] = issue.target.split(".");
      const count = await presentCount(db, resource, field);
      if (count > 0) {
        blockers.push({
          target: issue.target,
          reason: "removed field still has present values",
          count,
        });
      }
    }
    if (issue.change === "remove_lifecycle_state") {
      const [resource, state] = issue.target.split(".");
      const stateField = current.resources[resource].lifecycle!.field;
      const count = await stateCount(db, resource, stateField, state);
      if (count > 0) {
        blockers.push({
          target: issue.target,
          reason: "removed lifecycle state is still in use",
          count,
        });
      }
    }
    if (issue.change === "remove_resource") {
      const count = await activeRowCount(db, issue.target);
      if (count > 0) {
        blockers.push({
          target: issue.target,
          reason: "removed resource still has active rows",
          count,
        });
      }
    }
  }
  return { ready: blockers.length === 0, blockers };
}

async function applyCleanupChangeset(db: PGlite) {
  await db.exec(`
    insert into migration_exports(id, resource, field, row_count, payload)
    select 'export_lead_company_name', 'lead', 'company_name', count(*)::int,
      jsonb_agg(jsonb_build_object('id', id, 'company_name', company_name))
    from res_lead where company_name is not null;

    update res_lead set organization_name = company_name where company_name is not null;
    update res_lead set company_name = null where company_name is not null;
    update res_lead set email = id || '@example.invalid' where email is null;
    update res_lead set email = 'grace@example.com' where id = 'lead_2';
    update res_lead set email = 'linus@example.com' where id = 'lead_3';
    update res_lead set status = 'qualified' where status = 'contacted';
    update res_note set archived_at = now() where archived_at is null;
  `);
  await audit(db, "cleanup_changeset_committed", {
    changeset: "cs_e2e_cleanup",
  });
}

function destructiveSteps(plan: MigrationPlan) {
  return plan.issues.filter((issue) =>
    [
      "remove_field",
      "change_field_type",
      "remove_resource",
      "remove_lifecycle_state",
    ].includes(issue.change)
  ).map((issue) => `${issue.change}:${issue.target}`);
}

function confirmationToken(plan: MigrationPlan) {
  return `${plan.id}:${plan.digest}:destructive-cleanup`;
}

async function applyDestructiveCleanup(
  db: PGlite,
  current: Pack,
  desired: Pack,
  plan: MigrationPlan,
  token: string,
) {
  if (token !== confirmationToken(plan)) {
    throw new Error("confirmation token does not match plan digest");
  }
  const validation = await validateMigration(db, current, desired, plan);
  if (!validation.ready) {
    throw new Error(
      `migration still blocked: ${JSON.stringify(validation.blockers)}`,
    );
  }

  for (const issue of plan.issues) {
    if (issue.change === "remove_field") {
      const [resource, field] = issue.target.split(".");
      await db.exec(
        `alter table ${qi(tableName(resource))} drop column ${qi(field)};`,
      );
      await db.query(
        "delete from platform_fields where resource=$1 and field=$2",
        [resource, field],
      );
    }
    if (issue.change === "change_field_type") {
      const [resource, field] = issue.target.split(".");
      const replacement = `__new_${field}`;
      await db.exec(
        `alter table ${qi(tableName(resource))} drop column ${qi(field)};`,
      );
      await db.exec(
        `alter table ${qi(tableName(resource))} rename column ${
          qi(replacement)
        } to ${qi(field)};`,
      );
      await db.query(
        "delete from platform_fields where resource=$1 and field=$2",
        [resource, replacement],
      );
      await db.query(
        "update platform_fields set deprecated=false, write_blocked=false, replacement_field=null where resource=$1 and field=$2",
        [resource, field],
      );
    }
    if (issue.change === "add_unique_index") {
      const [resource, indexName] = issue.target.split(".");
      const index = desired.resources[resource].indexes!.find((i) =>
        i.name === indexName
      )!;
      await db.exec(
        `create unique index ${qi(index.name)} on ${qi(tableName(resource))} (${
          index.fields.map(qi).join(", ")
        }) where ${qi(index.fields[0])} is not null;`,
      );
    }
    if (issue.change === "make_required") {
      const [resource, field] = issue.target.split(".");
      await db.exec(
        `alter table ${qi(tableName(resource))} alter column ${
          qi(field)
        } set not null;`,
      );
    }
    if (issue.change === "remove_resource") {
      await db.exec(`drop table ${qi(tableName(issue.target))};`);
      await db.query("delete from platform_resources where resource=$1", [
        issue.target,
      ]);
      await db.query("delete from platform_fields where resource=$1", [
        issue.target,
      ]);
    }
  }
  await audit(db, "destructive_cleanup_applied", {
    plan: plan.id,
    digest: plan.digest,
  });
}

async function activateRevision(db: PGlite, revision: string) {
  const desired = await loadPackDir(desiredPackDir) as Pack;
  await db.query("update platform_revisions set active=false", []);
  await db.query(
    "insert into platform_revisions(revision, active, pack) values ($1, true, $2)",
    [revision, desired as unknown as Json],
  );
  await audit(db, "revision_activated", { revision });
}

async function inspectSchema(db: PGlite) {
  const tables = await db.query(
    "select tablename from pg_tables where schemaname='public' order by tablename",
  );
  const columns = await db.query(
    "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and table_name like 'res_%' order by table_name, ordinal_position",
  );
  return { tables: tables.rows, columns: columns.rows };
}

async function inspectPlatformState(db: PGlite) {
  const resources = await db.query(
    "select * from platform_resources order by resource",
  );
  const fields = await db.query(
    "select * from platform_fields order by resource, field",
  );
  const actions = await db.query(
    "select action, reviewed from platform_actions order by action",
  );
  const hooks = await db.query(
    "select hook, reviewed from platform_hooks order by hook",
  );
  return {
    resources: resources.rows,
    fields: fields.rows,
    actions: actions.rows,
    hooks: hooks.rows,
  };
}

async function finalState(db: PGlite) {
  const schema = await inspectSchema(db);
  const activeRevision = await db.query(
    "select revision from platform_revisions where active=true",
  );
  const indexes = await db.query(
    "select indexname from pg_indexes where schemaname='public' order by indexname",
  );
  const exports = await db.query(
    "select id, resource, field, row_count from migration_exports order by id",
  );
  const auditEvents = await db.query(
    "select event from migration_audit order by ts",
  );
  const leads = await db.query(
    "select id, email, organization_name, score, status from res_lead order by id",
  );
  return {
    activeRevision: activeRevision.rows,
    ...schema,
    indexes: indexes.rows,
    exports: exports.rows,
    auditEvents: auditEvents.rows,
    leads: leads.rows,
  };
}

async function audit(db: PGlite, event: string, details: Json) {
  await db.query(
    "insert into migration_audit(event, details) values ($1, $2)",
    [event, details],
  );
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
async function nullCount(db: PGlite, resource: string, field: string) {
  const result = await db.query<{ count: number }>(
    `select count(*)::int as count from ${qi(tableName(resource))} where ${
      qi(field)
    } is null`,
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
async function duplicateCount(
  db: PGlite,
  resource: string,
  field: string,
  where?: string,
) {
  const whereSql = where === "present(email)" || where === `present(${field})`
    ? `where ${qi(field)} is not null`
    : "";
  const result = await db.query<{ count: number }>(`
    select coalesce(sum(n - 1), 0)::int as count
    from (
      select ${qi(field)}, count(*)::int as n
      from ${qi(tableName(resource))}
      ${whereSql}
      group by ${qi(field)}
      having count(*) > 1
    ) duplicates
  `);
  return result.rows[0].count;
}

function tableName(resource: string) {
  return `res_${resource}`;
}
function sqlType(type: string) {
  if (type === "integer") return "integer";
  if (type === "decimal") return "numeric";
  return "text";
}
function generatedCastSqlExpression(field: string, from: string, to: string) {
  if (from === "integer" && to === "string") return `${qi(field)}::text`;
  if (from === "integer" && to === "decimal") return `${qi(field)}::numeric`;
  if (from === "decimal" && to === "string") return `${qi(field)}::text`;
  return null;
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
