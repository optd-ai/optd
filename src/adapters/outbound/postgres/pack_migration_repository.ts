import { query, type Queryable } from "./client.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import { getActivePack, storeOrReuseCandidate } from "./pack_repository.ts";
import {
  buildMigrationPlan,
  type LiveFacts,
  migrationDigest,
  type MigrationPlan,
} from "../../../domain/migrations/pack_migration.ts";
import { compileMigrationPreview } from "./resource_ddl.ts";
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
  const { plan: draft } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: stored.id,
    authContextId,
    active: activeSnapshot,
    candidate,
    liveFacts: facts,
  });
  const compiled = await compileMigrationPreview(candidate, draft);
  const compiledDraft: MigrationPlan = {
    ...draft,
    steps: compiled.steps,
    dependency_graph: compiled.dependency_graph,
  };
  const { plan_digest: _draftDigest, ...digestablePlan } = compiledDraft;
  const plan: MigrationPlan = {
    ...compiledDraft,
    plan_digest: await migrationDigest({
      plan: digestablePlan,
      sql_preview: compiled.statements,
    }),
  };
  const sqlPreview = compiled.statements;
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
  const blockedIds = new Set(
    blockers.map((blocker: MigrationPlan["blockers"][number]) =>
      blocker.change_id
    ),
  );
  return {
    ...plan,
    status: row.validation_status,
    changes: plan.changes.map((change) => ({
      ...change,
      status: blockedIds.has(change.id) ? "blocked" as const : "ready" as const,
    })),
    blockers,
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
  const locked = await query<{ plan_json: MigrationPlan | string }>(
    sql,
    "select plan_json from pack_migration_plans_v1 where id=$1 for update",
    [id],
  );
  const stored = locked.rows[0]?.plan_json;
  if (!stored) return null;
  const plan = typeof stored === "string"
    ? JSON.parse(stored) as MigrationPlan
    : stored;
  const blockers: MigrationPlan["blockers"] = [];
  const facts: Record<string, number> = {};
  const candidateRow = await query<
    { normalized: Record<string, unknown> | string }
  >(
    sql,
    "select normalized from pack_candidate_revisions where id=$1",
    [plan.to_pack_revision_id],
  );
  const normalizedValue = candidateRow.rows[0]?.normalized;
  const normalized = typeof normalizedValue === "string"
    ? JSON.parse(normalizedValue) as Record<string, unknown>
    : normalizedValue ?? {};
  const tableByChange = new Map<string, string | null>();
  for (const change of plan.changes) {
    const qualified = change.target.resource ?? change.target.relationship;
    const definitionName = qualified?.split(":").pop();
    if (!definitionName) continue;
    tableByChange.set(
      change.id,
      await runtimeTable(
        sql,
        plan.publisher,
        plan.pack,
        change.target.relationship ? "relationship" : "resource",
        definitionName,
      ),
    );
  }
  const tables = [
    ...new Set(
      [...tableByChange.values()].filter((value): value is string => !!value),
    ),
  ].sort();
  for (const table of tables) {
    await query(sql, `lock table ${quote(table)} in share mode`);
  }
  for (const change of plan.changes) {
    const qualified = change.target.resource ?? change.target.relationship;
    const definitionName = qualified?.split(":").pop();
    const table = tableByChange.get(change.id) ?? null;
    let count = !definitionName && change.status === "blocked" ? 1 : 0;
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
    } else if (
      table && change.kind === "change_field" && change.target.field &&
      change.status !== "blocked"
    ) {
      const resource = definitionName
        ? asRecord(asRecord(normalized.resources)[definitionName])
        : {};
      const descriptor = asRecord(
        asRecord(asRecord(resource.spec).fields)[change.target.field],
      );
      const invalid = invalidValuePredicate(change.target.field, descriptor);
      if (invalid) {
        const result = await query<{ count: string }>(
          sql,
          `select count(*)::text as count from ${
            quote(table)
          } where ${invalid}`,
        );
        count = Number(result.rows[0]?.count ?? 0);
      }
    } else if (
      table && change.kind === "add_field" &&
      change.facts.row_count !== undefined
    ) {
      const result = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${quote(table)}`,
      );
      count = Number(result.rows[0]?.count ?? 0);
    } else if (
      table && [
        "remove_resource",
        "remove_relationship",
        "change_relationship",
      ].includes(change.kind)
    ) {
      const result = await query<{ count: string }>(
        sql,
        `select count(*)::text as count from ${quote(table)}`,
      );
      count = Number(result.rows[0]?.count ?? 0);
    } else if (
      ![
        "remove_field",
        "remove_resource",
        "remove_relationship",
        "change_relationship",
        "add_field",
      ].includes(change.kind) && change.status === "blocked"
    ) {
      count = 1;
    }
    facts[`${change.kind}:${qualified}:${change.target.field ?? ""}`] = count;
    const blocks = count > 0 && (
      change.kind !== "add_field" ||
      change.class === "risky" || change.status === "blocked"
    );
    if (blocks) {
      const original = plan.blockers.find((item) =>
        item.change_id === change.id
      );
      const liveCode: Record<string, string> = {
        remove_field: "PRESENT_VALUES",
        remove_resource: "ROWS_EXIST",
        remove_relationship: "RELATIONSHIP_ROWS_EXIST",
        change_relationship: "RELATIONSHIP_ROWS_EXIST",
        add_field: "EXISTING_ROWS",
        change_field: "INVALID_VALUES",
      };
      blockers.push({
        change_id: change.id,
        code: original?.code ?? liveCode[change.kind] ??
          "INTERMEDIATE_REVISION_REQUIRED",
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
  await query(
    sql,
    "update pack_migration_confirmation_tokens set consumed_at=now() where plan_id=$1 and consumed_at is null",
    [id],
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
    changes: plan.changes.map((change) => ({
      id: change.id,
      status: blockers.some((blocker) => blocker.change_id === change.id)
        ? "blocked"
        : "ready",
    })),
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
      "resource",
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
  definitionKind: "resource" | "relationship",
  definitionName: string,
): Promise<string | null> {
  const result = await query<{ table_name: string }>(
    sql,
    `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind=$3 and definition_name=$4`,
    [publisher, pack, definitionKind, definitionName],
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
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function sqlLiteral(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return `'${String(value).replaceAll("'", "''")}'`;
}
function invalidValuePredicate(
  field: string,
  descriptor: Record<string, unknown>,
): string | null {
  const column = quote(field);
  const invalid: string[] = [];
  if (descriptor.required === true) invalid.push(`${column} is null`);
  if (Array.isArray(descriptor.enum) && descriptor.enum.length) {
    invalid.push(
      `(${column} is not null and ${column} not in (${
        descriptor.enum.map(sqlLiteral).join(",")
      }))`,
    );
  }
  if (typeof descriptor.minLength === "number") {
    invalid.push(
      `(${column} is not null and char_length(${column}) < ${descriptor.minLength})`,
    );
  }
  if (typeof descriptor.maxLength === "number") {
    invalid.push(
      `(${column} is not null and char_length(${column}) > ${descriptor.maxLength})`,
    );
  }
  if (
    typeof descriptor.minimum === "number" ||
    typeof descriptor.minimum === "string"
  ) {
    invalid.push(
      `(${column} is not null and ${column} < ${
        sqlLiteral(descriptor.minimum)
      })`,
    );
  }
  if (
    typeof descriptor.maximum === "number" ||
    typeof descriptor.maximum === "string"
  ) {
    invalid.push(
      `(${column} is not null and ${column} > ${
        sqlLiteral(descriptor.maximum)
      })`,
    );
  }
  return invalid.length ? invalid.join(" or ") : null;
}
