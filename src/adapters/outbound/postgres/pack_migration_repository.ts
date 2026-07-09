import { query, type Queryable, quoteIdentifier } from "./client.ts";
import { applyLoadedPack, getPack } from "./pack_repository.ts";
import { compilePackDdl } from "./resource_ddl.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import {
  buildMigrationPlan,
  type LiveFacts,
  migrationDigest,
  type MigrationPlan,
} from "../../../domain/migrations/pack_migration.ts";

export async function getActivePackSnapshot(
  sql: Queryable,
  namespace: string,
  name: string,
) {
  const row = await getPack(sql, namespace, name) as {
    revision: string;
    namespace: string;
    name: string;
    normalized: Record<string, unknown> | string;
  } | null;
  if (!row) return null;
  return { ...row, normalized: parseJsonRecord(row.normalized) };
}

export async function createPackMigrationPlan(
  sql: Queryable,
  candidate: LoadedPack,
): Promise<MigrationPlan> {
  const active = await getActivePackSnapshot(
    sql,
    candidate.namespace,
    candidate.name,
  );
  if (!active) throw new Error("no active pack revision to migrate from");
  const facts = await collectLiveFacts(sql, active.normalized, candidate);
  const partial = await buildMigrationPlan({
    id: crypto.randomUUID(),
    active,
    candidate,
    liveFacts: facts,
  });
  const digest = await migrationDigest({
    from_revision: partial.from_revision,
    to_revision: partial.to_revision,
    changes: partial.changes,
    sql_preview: partial.sql_preview,
  });
  const plan: MigrationPlan = {
    ...partial,
    plan_digest: digest,
    confirmation_token: `confirm:${digest}`,
  };
  await query(
    sql,
    `insert into pack_migration_plans(id, namespace, name, from_revision, to_revision, status, plan_digest, candidate_normalized, candidate_manifest, candidate_source_files, plan_json, sql_preview)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)`,
    [
      plan.id,
      candidate.namespace,
      candidate.name,
      plan.from_revision,
      plan.to_revision,
      plan.status,
      plan.plan_digest,
      JSON.stringify(candidate.normalized),
      JSON.stringify(candidate.manifest),
      JSON.stringify(candidate.sourceFiles),
      JSON.stringify(plan),
      JSON.stringify(plan.sql_preview),
    ],
  );
  return plan;
}

export async function getMigrationPlan(
  sql: Queryable,
  id: string,
): Promise<MigrationPlan | null> {
  const result = await query<{ plan_json: MigrationPlan }>(
    sql,
    "select plan_json from pack_migration_plans where id=$1",
    [id],
  );
  return (parseJsonValue(result.rows[0]?.plan_json) as
    | MigrationPlan
    | undefined) ?? null;
}

export async function applyMigrationSafe(
  sql: Queryable,
  id: string,
): Promise<MigrationPlan> {
  const row = await migrationRow(sql, id);
  const plan = row.plan_json;
  const pack = reviveCandidate(row);
  const ddlObjects = compilePackDdl(pack);
  const readySafe = plan.changes.filter((c) =>
    (c.class === "safe" || c.class === "risky") && c.status === "ready"
  );
  for (const change of readySafe) {
    if (change.kind === "add_field") {
      const resource = change.target.resource!;
      const field = change.target.field!;
      const desired = pack.resources[resource];
      const fieldSpec =
        (desired.spec.fields as Record<string, Record<string, unknown>>)[field];
      await query(
        sql,
        `alter table ${qi(`res_${resource}`)} add column if not exists ${
          qi(field)
        } ${sqlType(String(fieldSpec.type))}${
          fieldSpec.required === true ? " not null" : ""
        }`,
      );
    } else if (change.kind === "change_field_type") {
      const resource = change.target.resource!;
      const field = change.target.field!;
      const desired = pack.resources[resource];
      const fieldSpec =
        (desired.spec.fields as Record<string, Record<string, unknown>>)[field];
      await query(
        sql,
        `alter table ${qi(`res_${resource}`)} alter column ${qi(field)} type ${
          sqlType(String(fieldSpec.type))
        }`,
      );
    } else if (change.kind === "add_resource") {
      const object = ddlObjects.find((o) =>
        o.kind === "resource_table" && o.name === change.target.resource
      );
      if (object) await query(sql, object.ddl);
    }
    change.status = "applied";
  }
  plan.status = plan.changes.some((c) => c.class === "destructive")
    ? "staged"
    : plan.changes.some((c) => c.status === "blocked")
    ? "blocked"
    : "ready";
  await updatePlan(sql, id, plan);
  await audit(sql, "pack_migration.safe_applied", plan, {
    applied: readySafe.map((c) => c.id),
  });
  return plan;
}

export async function stageMigrationDestructive(
  sql: Queryable,
  id: string,
): Promise<MigrationPlan> {
  const row = await migrationRow(sql, id);
  const plan = row.plan_json;
  for (const change of plan.changes) {
    if (change.class === "destructive" && change.status !== "applied") {
      change.status = "staged";
    }
  }
  plan.status = "staged";
  await updatePlan(sql, id, plan);
  await audit(sql, "pack_migration.staged", plan, {});
  return plan;
}

export async function confirmMigration(
  sql: Queryable,
  id: string,
  token: string,
): Promise<MigrationPlan> {
  const row = await migrationRow(sql, id);
  const plan = row.plan_json;
  if (token !== plan.confirmation_token) {
    throw new Error("confirmation token does not match migration digest");
  }
  const currentFacts = await collectPlanFacts(sql, plan);
  const blockers = plan.changes.filter((change) => {
    if (change.class !== "destructive") return false;
    if (change.kind === "remove_field") {
      return (currentFacts
        .fieldPresentValues[
          `${change.target.resource}.${change.target.field}`
        ] ?? 0) > 0;
    }
    if (change.kind === "remove_resource") {
      return (currentFacts.resourceRows[change.target.resource ?? ""] ?? 0) > 0;
    }
    return false;
  });
  if (blockers.length) {
    throw new Error(
      `migration still has destructive blockers: ${
        blockers.map((b) => b.id).join(",")
      }`,
    );
  }
  for (const change of plan.changes) {
    if (
      change.class === "destructive" &&
      (change.status === "staged" || change.status === "ready")
    ) {
      if (change.kind === "remove_field") {
        await query(
          sql,
          `alter table ${
            qi(`res_${change.target.resource}`)
          } drop column if exists ${qi(change.target.field!)}`,
        );
      } else if (change.kind === "remove_resource") {
        await query(
          sql,
          `drop table if exists ${qi(`res_${change.target.resource}`)}`,
        );
      }
      change.status = "applied";
    }
  }
  const pack = reviveCandidate(row);
  await applyLoadedPack(sql, pack);
  plan.status = "applied";
  await updatePlan(sql, id, plan);
  await audit(sql, "pack_migration.confirmed_applied", plan, {});
  return plan;
}

async function collectLiveFacts(
  sql: Queryable,
  activeNormalized: Record<string, unknown>,
  candidate: LoadedPack,
): Promise<LiveFacts> {
  const resources = new Set<string>([
    ...Object.keys(readDefs(activeNormalized, "resources")),
    ...Object.keys(candidate.resources),
  ]);
  const facts: LiveFacts = { resourceRows: {}, fieldPresentValues: {} };
  for (const resource of resources) {
    const table = `res_${resource}`;
    if (!await tableExists(sql, table)) {
      facts.resourceRows[resource] = 0;
      continue;
    }
    const count = await query<{ count: string }>(
      sql,
      `select count(*)::text as count from ${
        qi(table)
      } where archived_at is null`,
    );
    facts.resourceRows[resource] = Number(count.rows[0]?.count ?? 0);
    const activeFields = fields(
      readDefs(activeNormalized, "resources")[resource],
    );
    const candidateFields = fields(
      candidate.resources[resource]?.document as
        | Record<string, unknown>
        | undefined,
    );
    for (
      const field of new Set([
        ...Object.keys(activeFields),
        ...Object.keys(candidateFields),
      ])
    ) {
      if (await columnExists(sql, table, field)) {
        const present = await query<{ count: string }>(
          sql,
          `select count(*)::text as count from ${qi(table)} where ${
            qi(field)
          } is not null`,
        );
        facts.fieldPresentValues[`${resource}.${field}`] = Number(
          present.rows[0]?.count ?? 0,
        );
      }
    }
  }
  return facts;
}
async function collectPlanFacts(
  sql: Queryable,
  plan: MigrationPlan,
): Promise<LiveFacts> {
  const facts: LiveFacts = { resourceRows: {}, fieldPresentValues: {} };
  for (const change of plan.changes) {
    const resource = change.target.resource;
    if (!resource) continue;
    const table = `res_${resource}`;
    if (!(resource in facts.resourceRows) && await tableExists(sql, table)) {
      const count = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${
          qi(table)
        } where archived_at is null`,
      );
      facts.resourceRows[resource] = Number(count.rows[0]?.count ?? 0);
    }
    const field = change.target.field;
    if (field && await columnExists(sql, table, field)) {
      const present = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${qi(table)} where ${
          qi(field)
        } is not null`,
      );
      facts.fieldPresentValues[`${resource}.${field}`] = Number(
        present.rows[0]?.count ?? 0,
      );
    }
  }
  return facts;
}
async function tableExists(sql: Queryable, table: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    sql,
    "select to_regclass($1) is not null as exists",
    [`public.${table}`],
  );
  return result.rows[0]?.exists === true;
}
async function columnExists(
  sql: Queryable,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    sql,
    "select exists(select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2) as exists",
    [table, column],
  );
  return result.rows[0]?.exists === true;
}
async function migrationRow(
  sql: Queryable,
  id: string,
): Promise<Record<string, unknown> & { plan_json: MigrationPlan }> {
  const result = await query(
    sql,
    "select * from pack_migration_plans where id=$1",
    [id],
  );
  const row = result.rows[0] as
    | Record<string, unknown> & { plan_json: MigrationPlan | string }
    | undefined;
  if (!row) throw new Error(`migration ${id} not found`);
  return { ...row, plan_json: parseJsonValue(row.plan_json) as MigrationPlan };
}
function reviveCandidate(row: Record<string, unknown>): LoadedPack {
  const normalized = parseJsonRecord(
    row.candidate_normalized,
  ) as LoadedPack["normalized"];
  const sourceFiles = parseJsonValue(
    row.candidate_source_files,
  ) as LoadedPack["sourceFiles"];
  const manifest = parseJsonRecord(
    row.candidate_manifest,
  ) as LoadedPack["manifest"];
  const metadata = manifest.metadata as Record<string, string>;
  const pack: LoadedPack = {
    namespace: metadata.namespace,
    name: metadata.name,
    version: metadata.version,
    revision: row.to_revision as string,
    manifest,
    normalized,
    sourceFiles,
    resources: reviveDefs(
      normalized,
      "resources",
      metadata.namespace,
      "Resource",
    ),
    relationships: reviveDefs(
      normalized,
      "relationships",
      metadata.namespace,
      "Relationship",
    ),
    lifecycles: reviveDefs(
      normalized,
      "lifecycles",
      metadata.namespace,
      "Lifecycle",
    ),
    actions: reviveDefs(normalized, "actions", metadata.namespace, "Action"),
    hooks: {},
    policies: reviveDefs(normalized, "policies", metadata.namespace, "Policy"),
    seeds: reviveDefs(normalized, "seeds", metadata.namespace, "Seed"),
    scripts: {},
  } as LoadedPack;
  const hooks = reviveDefs(normalized, "hooks", metadata.namespace, "Hook");
  for (const [name, def] of Object.entries(hooks)) {
    const script = String(def.spec.script ?? `${name}.ts`);
    const scriptPath = `hooks/${script}`;
    const scriptFile = sourceFiles.find((f) => f.path === scriptPath);
    pack.hooks[name] = {
      ...def,
      script,
      scriptDigest: scriptFile?.digest ?? "",
    };
  }
  for (const file of sourceFiles.filter((f) => f.kind === "script")) {
    pack.scripts[file.path] = file;
  }
  return pack;
}
function reviveDefs(
  normalized: Record<string, unknown>,
  key: string,
  namespace: string,
  kind: string,
) {
  const out: Record<string, any> = {};
  for (const [name, document] of Object.entries(readDefs(normalized, key))) {
    out[name] = {
      kind,
      path: `${key}/${name}.yaml`,
      name,
      namespace,
      document,
      spec: document.spec ?? {},
    };
  }
  return out;
}
function parseJsonValue(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}
function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}
function readDefs(
  normalized: Record<string, unknown>,
  key: string,
): Record<string, Record<string, unknown>> {
  const value = normalized[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Record<string, unknown>>
    : {};
}
function fields(
  document: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const spec = document?.spec as Record<string, unknown> | undefined;
  return spec?.fields && typeof spec.fields === "object" &&
      !Array.isArray(spec.fields)
    ? spec.fields as Record<string, unknown>
    : {};
}
async function updatePlan(sql: Queryable, id: string, plan: MigrationPlan) {
  await query(
    sql,
    "update pack_migration_plans set status=$2, plan_json=$3::jsonb, sql_preview=$4::jsonb, updated_at=now() where id=$1",
    [id, plan.status, JSON.stringify(plan), JSON.stringify(plan.sql_preview)],
  );
}
async function audit(
  sql: Queryable,
  eventType: string,
  plan: MigrationPlan,
  details: Record<string, unknown>,
) {
  await query(
    sql,
    `insert into audit_events(id, actor_id, event_type, action, decision, request_metadata_json) values ($1,'system:migration',$2,'pack.migration',$3,$4::jsonb)`,
    [
      crypto.randomUUID(),
      eventType,
      plan.status,
      JSON.stringify({
        migration_id: plan.id,
        plan_digest: plan.plan_digest,
        ...details,
      }),
    ],
  );
}
function qi(identifier: string): string {
  return quoteIdentifier(identifier);
}
function sqlType(type: string): string {
  switch (type) {
    case "integer":
      return "integer";
    case "decimal":
      return "numeric";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamptz";
    case "date":
      return "date";
    default:
      return "text";
  }
}
