import { query, type Queryable } from "./client.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import { getActivePack, storeOrReuseCandidate } from "./pack_repository.ts";
import {
  buildMigrationPlan,
  type LiveFacts,
  type MigrationPlan,
} from "../../../domain/migrations/pack_migration.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export async function createPackMigrationPlan(
  sql: Queryable,
  candidate: LoadedPack,
  authContextId: string,
): Promise<{ plan: MigrationPlan; candidate_reused: boolean }> {
  const stored = await storeOrReuseCandidate(sql, candidate);
  const active = await getActivePack(sql, candidate.publisher, candidate.name);
  const activeSnapshot = active && typeof active.id === "string" &&
      active.normalized && typeof active.normalized === "object" &&
      !Array.isArray(active.normalized)
    ? {
      revisionId: active.id,
      normalized: active.normalized as Record<string, unknown>,
    }
    : null;
  const facts = await collectLiveFacts(
    sql,
    activeSnapshot?.normalized ?? {},
    candidate,
  );
  const { plan, sql: sqlPreview } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: stored.id,
    authContextId,
    active: activeSnapshot,
    candidate,
    liveFacts: facts,
  });
  await query(
    sql,
    `insert into pack_migration_plans_v1(id,publisher,pack_name,from_pack_revision_id,to_pack_revision_id,candidate_source_digest,plan_digest,created_auth_context_id,class,status,live_facts_digest,plan_json,sql_preview) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)`,
    [
      plan.id,
      plan.publisher,
      plan.pack,
      plan.from_pack_revision_id,
      plan.to_pack_revision_id,
      plan.candidate_source_digest,
      plan.plan_digest,
      plan.created_auth_context_id,
      plan.class,
      plan.status,
      plan.live_facts_digest,
      JSON.stringify(plan),
      JSON.stringify(sqlPreview),
    ],
  );
  return { plan, candidate_reused: stored.reused };
}

export async function getMigrationPlan(
  sql: Queryable,
  id: string,
): Promise<MigrationPlan | null> {
  const result = await query<{
    plan_json: MigrationPlan | string;
    validation_id: string | null;
    validation_status: "ready" | "blocked" | null;
    validation_digest: string | null;
    validation_blockers: MigrationPlan["blockers"] | string | null;
    validation_created_at: Date | string | null;
  }>(
    sql,
    `select p.plan_json,
            v.id validation_id, v.status validation_status,
            v.live_facts_digest validation_digest,
            v.blockers validation_blockers, v.created_at validation_created_at
       from pack_migration_plans_v1 p
       left join lateral (
         select * from pack_migration_validations
          where plan_id=p.id order by created_at desc,id desc limit 1
       ) v on true
      where p.id=$1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const plan = typeof row.plan_json === "string"
    ? JSON.parse(row.plan_json) as MigrationPlan
    : row.plan_json;
  if (
    !row.validation_id || !row.validation_status ||
    !row.validation_digest || !row.validation_created_at
  ) return plan;
  const blockers = typeof row.validation_blockers === "string"
    ? JSON.parse(row.validation_blockers)
    : row.validation_blockers ?? [];
  return {
    ...plan,
    status: row.validation_status,
    last_validation: {
      id: row.validation_id,
      status: row.validation_status,
      live_facts_digest: row.validation_digest,
      blockers,
      created_at: row.validation_created_at instanceof Date
        ? row.validation_created_at.toISOString()
        : String(row.validation_created_at),
    },
  };
}
export async function getMigrationSql(
  sql: Queryable,
  id: string,
): Promise<string[] | null> {
  const result = await query<{ sql_preview: string[] | string }>(
    sql,
    "select sql_preview from pack_migration_plans_v1 where id=$1",
    [id],
  );
  const value = result.rows[0]?.sql_preview;
  return value ? (typeof value === "string" ? JSON.parse(value) : value) : null;
}

export async function validateMigrationPlan(
  sql: Queryable,
  id: string,
  authContextId: string,
): Promise<Record<string, unknown> | null> {
  const plan = await getMigrationPlan(sql, id);
  if (!plan) return null;
  const blockers: MigrationPlan["blockers"] = [];
  const facts: Record<string, number> = {};
  for (
    const change of plan.changes.filter((item) => item.status === "blocked")
  ) {
    const qualified = change.target.resource;
    const resource = qualified?.split(":").pop();
    if (!resource) continue;
    const table = await runtimeTable(sql, plan.publisher, plan.pack, resource);
    let count = 0;
    if (
      table && change.kind === "remove_field" && change.target.field &&
      await columnExists(sql, table, change.target.field)
    ) {
      const result = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${quote(table)} where ${
          quote(change.target.field)
        } is not null`,
      );
      count = Number(result.rows[0]?.count ?? 0);
    } else if (table && change.kind === "remove_resource") {
      const result = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${quote(table)}`,
      );
      count = Number(result.rows[0]?.count ?? 0);
    } else if (
      change.kind !== "remove_field" && change.kind !== "remove_resource"
    ) {
      count = 1;
    }
    facts[`${change.kind}:${qualified}:${change.target.field ?? ""}`] = count;
    if (count > 0) {
      const original = plan.blockers.find((item) =>
        item.change_id === change.id
      );
      blockers.push({
        change_id: change.id,
        code: original?.code ?? "INTERMEDIATE_REVISION_REQUIRED",
        count,
        message: original?.message ??
          `${change.kind} cannot be applied against current live facts`,
      });
    }
  }
  const validationId = uuidV7();
  const status = blockers.length ? "blocked" as const : "ready" as const;
  const liveFactsDigest = await sha256Json(facts);
  await query(
    sql,
    `insert into pack_migration_validations(id,plan_id,status,live_facts_digest,blockers,auth_context_id)
     values ($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      validationId,
      id,
      status,
      liveFactsDigest,
      JSON.stringify(blockers),
      authContextId,
    ],
  );
  let confirmationToken: string | null = null;
  let confirmationExpiresAt: string | null = null;
  if (plan.class === "destructive" && status === "ready") {
    confirmationToken = opaqueToken();
    confirmationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await query(
      sql,
      `insert into pack_migration_confirmation_tokens(id,plan_id,validation_id,token_digest,expires_at,auth_context_id)
       values ($1,$2,$3,$4,$5,$6)`,
      [
        uuidV7(),
        id,
        validationId,
        await digestToken(confirmationToken),
        confirmationExpiresAt,
        authContextId,
      ],
    );
  }
  return {
    migration_id: id,
    validation_id: validationId,
    status,
    live_facts_digest: liveFactsDigest,
    blockers,
    confirmation_token: confirmationToken,
    confirmation_expires_at: confirmationExpiresAt,
  };
}

async function collectLiveFacts(
  sql: Queryable,
  activeNormalized: Record<string, unknown>,
  candidate: LoadedPack,
): Promise<LiveFacts> {
  const activeResources = definitions(activeNormalized, "resources");
  const resources = new Set([
    ...Object.keys(activeResources),
    ...Object.keys(candidate.resources),
  ]);
  const facts: LiveFacts = { resourceRows: {}, fieldPresentValues: {} };
  for (const resource of [...resources].sort()) {
    const table = await runtimeTable(
      sql,
      candidate.publisher,
      candidate.name,
      resource,
    );
    if (!table) {
      facts.resourceRows[resource] = 0;
      continue;
    }
    const count = await query<{ count: string }>(
      sql,
      `select count(*)::text as count from ${
        quote(table)
      } where archived_at is null`,
    );
    facts.resourceRows[resource] = Number(count.rows[0]?.count ?? 0);
    const before = fields(activeResources[resource]);
    const after = candidate.resources[resource]
      ? fields(
        candidate.resources[resource].document as Record<string, unknown>,
      )
      : {};
    for (
      const field of new Set([...Object.keys(before), ...Object.keys(after)])
    ) {
      if (await columnExists(sql, table, field)) {
        const present = await query<{ count: string }>(
          sql,
          `select count(*)::text as count from ${quote(table)} where ${
            quote(field)
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
async function runtimeTable(
  sql: Queryable,
  publisher: string,
  pack: string,
  resource: string,
): Promise<string | null> {
  const result = await query<{ table_name: string }>(
    sql,
    `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
    [publisher, pack, resource],
  );
  return result.rows[0]?.table_name ?? null;
}
async function columnExists(sql: Queryable, table: string, column: string) {
  const result = await query<{ exists: boolean }>(
    sql,
    "select exists(select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2) as exists",
    [table, column],
  );
  return result.rows[0]?.exists === true;
}
function definitions(
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
  const spec = document?.spec;
  return spec && typeof spec === "object" && !Array.isArray(spec) &&
      (spec as Record<string, unknown>).fields &&
      typeof (spec as Record<string, unknown>).fields === "object"
    ? (spec as Record<string, any>).fields
    : {};
}
function opaqueToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replaceAll("=", "");
}
async function digestToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
async function sha256Json(value: unknown) {
  return `sha256:${await digestToken(JSON.stringify(value))}`;
}
function quote(identifier: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error("unsafe runtime table identifier");
  }
  return `"${identifier}"`;
}
