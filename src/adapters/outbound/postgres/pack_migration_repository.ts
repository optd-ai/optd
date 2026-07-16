import { query, type Queryable } from "./client.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import { getActivePack, storeOrReuseCandidate } from "./pack_repository.ts";
import {
  buildMigrationPlan,
  type LiveFacts,
  type MigrationApplication,
  type MigrationApplyRequest,
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
    `insert into pack_migration_plans_v1(id,publisher,pack_name,from_pack_revision_id,to_pack_revision_id,candidate_source_digest,plan_digest,created_auth_context_id,class,status,live_facts_digest,plan_json,sql_preview) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb,$13::text::jsonb)`,
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
    application_id: string | null;
    application_plan_digest: string | null;
    application_candidate_revision_id: string | null;
    application_auth_context_id: string | null;
    application_applied_at: Date | string | null;
  }>(
    sql,
    `select p.plan_json,
            v.id validation_id, v.status validation_status,
            v.live_facts_digest validation_digest,
            v.blockers validation_blockers, v.created_at validation_created_at,
            a.id application_id, a.plan_digest application_plan_digest,
            a.candidate_revision_id application_candidate_revision_id,
            a.auth_context_id application_auth_context_id,
            a.applied_at application_applied_at
       from pack_migration_plans_v1 p
       left join pack_migration_applications a on a.plan_id=p.id
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
  const application: MigrationApplication | null = row.application_id &&
      row.application_plan_digest && row.application_candidate_revision_id &&
      row.application_auth_context_id && row.application_applied_at
    ? {
      id: row.application_id,
      migration_id: plan.id,
      plan_digest: row.application_plan_digest,
      candidate_revision_id: row.application_candidate_revision_id,
      applied_by_auth_context_id: row.application_auth_context_id,
      applied_at: row.application_applied_at instanceof Date
        ? row.application_applied_at.toISOString()
        : String(row.application_applied_at),
    }
    : null;
  if (
    !row.validation_id || !row.validation_status ||
    !row.validation_digest || !row.validation_created_at
  ) return application ? { ...plan, status: "applied", application } : plan;
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
    status: application ? "applied" : row.validation_status,
    application,
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
     values ($1,$2,$3,$4,$5::text::jsonb,$6)`,
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
  if (status === "ready") {
    await structurallyValidatePersistedSql(sql, plan);
  }
  if (plan.class === "destructive" && status === "ready") {
    confirmationToken = opaqueToken();
    confirmationExpiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const identity = await authorizationIdentity(sql, authContextId);
    const destructiveChangeIds = plan.changes.filter((change) =>
      change.class === "destructive"
    ).map((change) => change.id).sort();
    await query(
      sql,
      `insert into pack_migration_confirmation_tokens(
         id,plan_id,validation_id,token_digest,expires_at,auth_context_id,
         principal_id,authorization_root_id,plan_digest,live_facts_digest,destructive_change_ids)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb)`,
      [
        uuidV7(),
        id,
        validationId,
        await digestToken(confirmationToken),
        confirmationExpiresAt,
        authContextId,
        identity.principalId,
        identity.authorizationRootId,
        plan.plan_digest,
        liveFactsDigest,
        JSON.stringify(destructiveChangeIds),
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

export class MigrationApplyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function applyMigrationPlan(
  sql: Queryable,
  id: string,
  request: MigrationApplyRequest,
  authContextId: string,
  testFault?: "after_sql" | "after_application",
  authorizeLocked?: (sql: Queryable) => Promise<void>,
): Promise<MigrationApplication | null> {
  const locked = await query<{
    plan_json: MigrationPlan | string;
    sql_preview: string[] | string;
  }>(
    sql,
    `select plan_json,sql_preview from pack_migration_plans_v1 where id=$1 for update`,
    [id],
  );
  const row = locked.rows[0];
  if (!row) return null;
  const plan = typeof row.plan_json === "string"
    ? JSON.parse(row.plan_json) as MigrationPlan
    : row.plan_json;
  const statements = typeof row.sql_preview === "string"
    ? JSON.parse(row.sql_preview) as string[]
    : row.sql_preview;
  const expectedAcknowledgement = plan.class === "safe"
    ? "safe"
    : plan.class === "risky"
    ? "reviewed"
    : "destructive";
  if (request.acknowledgement !== expectedAcknowledgement) {
    throw new MigrationApplyError(
      "migration_acknowledgement_invalid",
      `acknowledgement must be ${expectedAcknowledgement}`,
    );
  }
  if (plan.class !== "destructive" && request.confirmation_token != null) {
    throw new MigrationApplyError(
      "migration_confirmation_invalid",
      "confirmation_token is forbidden for safe and risky migrations",
    );
  }
  if (plan.class === "destructive" && !request.confirmation_token) {
    throw new MigrationApplyError(
      "migration_confirmation_invalid",
      "confirmation_token is required for destructive migrations",
    );
  }
  const existing = await existingApplication(sql, id);
  if (existing) return existing;
  const timeout = parseLockTimeout(request.lock_timeout ?? "10s");
  await query(sql, "select set_config('lock_timeout',$1,true)", [timeout]);
  await query(sql, "select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
    plan.publisher,
    plan.pack,
  ]);
  const tables = await query<{ table_name: string }>(
    sql,
    `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2
       order by publisher,pack_name,case definition_kind when 'resource' then 0 else 1 end,
                definition_name,table_name`,
    [plan.publisher, plan.pack],
  );
  for (const table of tables.rows) {
    await query(
      sql,
      `lock table ${quote(table.table_name)} in share row exclusive mode`,
    );
  }
  await authorizeLocked?.(sql);
  const active = await query<{ candidate_revision_id: string }>(
    sql,
    "select candidate_revision_id from pack_active_revisions where publisher=$1 and pack_name=$2",
    [plan.publisher, plan.pack],
  );
  if (
    (active.rows[0]?.candidate_revision_id ?? null) !==
      plan.from_pack_revision_id
  ) {
    throw new MigrationApplyError(
      "migration_stale",
      "active pack revision changed",
    );
  }
  verifyStepCoverage(plan, statements);
  const { plan_digest: _digest, ...digestablePlan } = plan;
  const digest = await migrationDigest({
    plan: digestablePlan,
    sql_preview: statements,
  });
  if (digest !== plan.plan_digest) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "persisted plan digest does not match persisted SQL",
    );
  }
  const candidate = await query<{ source_digest: string }>(
    sql,
    "select source_digest from pack_candidate_revisions where id=$1",
    [plan.to_pack_revision_id],
  );
  if (
    !candidate.rows[0] ||
    candidate.rows[0].source_digest !== plan.candidate_source_digest
  ) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "persisted candidate does not match plan",
    );
  }
  await query(sql, "savepoint operant_apply_revalidation");
  let revalidation: Record<string, unknown> | null;
  try {
    revalidation = await validateMigrationPlan(sql, id, authContextId);
  } finally {
    await query(sql, "rollback to savepoint operant_apply_revalidation");
    await query(sql, "release savepoint operant_apply_revalidation");
  }
  if (!revalidation || revalidation.status !== "ready") {
    throw new MigrationApplyError(
      "migration_blocked",
      "migration is blocked by current live facts",
    );
  }
  const currentFactsDigest = String(revalidation.live_facts_digest);
  const latest = await query<{ status: string; live_facts_digest: string }>(
    sql,
    `select status,live_facts_digest from pack_migration_validations where plan_id=$1 order by created_at desc,id desc limit 1`,
    [id],
  );
  if (
    !latest.rows[0] || latest.rows[0].status !== "ready" ||
    latest.rows[0].live_facts_digest !== currentFactsDigest
  ) {
    throw new MigrationApplyError(
      "migration_stale",
      "validated live facts changed",
    );
  }
  const identity = await authorizationIdentity(sql, authContextId);
  let tokenId: string | null = null;
  if (plan.class === "destructive") {
    const token = await query<{
      id: string;
      expires_at: Date | string;
      consumed_at: Date | string | null;
      principal_id: string;
      authorization_root_id: string;
      plan_digest: string;
      live_facts_digest: string;
      destructive_change_ids: string[] | string;
    }>(
      sql,
      `select id,expires_at,consumed_at,principal_id,authorization_root_id,plan_digest,
                    live_facts_digest,destructive_change_ids
               from pack_migration_confirmation_tokens
              where plan_id=$1 and token_digest=$2 for update`,
      [id, await digestToken(request.confirmation_token!)],
    );
    const found = token.rows[0];
    const expectedIds = plan.changes.filter((change) =>
      change.class === "destructive"
    ).map((change) => change.id).sort();
    const tokenIds = found &&
      (typeof found.destructive_change_ids === "string"
        ? JSON.parse(found.destructive_change_ids) as string[]
        : found.destructive_change_ids);
    if (
      !found || found.consumed_at ||
      new Date(found.expires_at).getTime() <= Date.now() ||
      found.principal_id !== identity.principalId ||
      found.authorization_root_id !== identity.authorizationRootId ||
      found.plan_digest !== plan.plan_digest ||
      found.live_facts_digest !== currentFactsDigest ||
      JSON.stringify(tokenIds) !== JSON.stringify(expectedIds)
    ) {
      throw new MigrationApplyError(
        "migration_confirmation_invalid",
        "confirmation token is invalid, expired, stale, used, or belongs to another authority",
      );
    }
    tokenId = found.id;
  }
  for (const index of statementOrder(plan)) await query(sql, statements[index]);
  if (testFault === "after_sql") {
    throw new Error("injected migration failure after SQL");
  }
  const applicationId = uuidV7();
  const inserted = await query<{ applied_at: Date | string }>(
    sql,
    `insert into pack_migration_applications(id,plan_id,plan_digest,candidate_revision_id,auth_context_id,principal_id,authorization_root_id)
     values($1,$2,$3,$4,$5,$6,$7) returning applied_at`,
    [
      applicationId,
      id,
      plan.plan_digest,
      plan.to_pack_revision_id,
      authContextId,
      identity.principalId,
      identity.authorizationRootId,
    ],
  );
  if (testFault === "after_application") {
    throw new Error("injected migration failure after application");
  }
  if (tokenId) {
    await query(
      sql,
      "update pack_migration_confirmation_tokens set consumed_at=now() where id=$1 and consumed_at is null",
      [tokenId],
    );
  }
  await query(
    sql,
    `insert into pack_migration_audit_events(id,plan_id,application_id,auth_context_id,principal_id,authorization_root_id,action,decision,details)
     values($1,$2,$3,$4,$5,$6,'migration.apply','allowed',$7::text::jsonb)`,
    [
      uuidV7(),
      id,
      applicationId,
      authContextId,
      identity.principalId,
      identity.authorizationRootId,
      JSON.stringify({
        plan_digest: plan.plan_digest,
        candidate_revision_id: plan.to_pack_revision_id,
      }),
    ],
  );
  const appliedAt = inserted.rows[0]!.applied_at;
  return {
    id: applicationId,
    migration_id: id,
    plan_digest: plan.plan_digest,
    candidate_revision_id: plan.to_pack_revision_id,
    applied_by_auth_context_id: authContextId,
    applied_at: appliedAt instanceof Date
      ? appliedAt.toISOString()
      : String(appliedAt),
  };
}

export async function recordMigrationAttempt(
  sql: Queryable,
  planId: string,
  authContextId: string,
  outcome: string,
): Promise<void> {
  const identity = await authorizationIdentity(sql, authContextId);
  await query(
    sql,
    `insert into pack_migration_attempts(id,plan_id,auth_context_id,outcome,details)
     values($1,$2,$3,$4,$5::text::jsonb)`,
    [
      uuidV7(),
      planId,
      authContextId,
      outcome,
      JSON.stringify({ error_code: outcome }),
    ],
  );
  await query(
    sql,
    `insert into pack_migration_audit_events(
       id,plan_id,application_id,auth_context_id,principal_id,
       authorization_root_id,action,decision,details)
     values($1,$2,null,$3,$4,$5,'migration.apply','denied',$6::text::jsonb)`,
    [
      uuidV7(),
      planId,
      authContextId,
      identity.principalId,
      identity.authorizationRootId,
      JSON.stringify({ error_code: outcome }),
    ],
  );
}

async function existingApplication(
  sql: Queryable,
  planId: string,
): Promise<MigrationApplication | null> {
  const result = await query<{
    id: string;
    plan_digest: string;
    candidate_revision_id: string;
    auth_context_id: string;
    applied_at: Date | string;
  }>(
    sql,
    `select id,plan_digest,candidate_revision_id,auth_context_id,applied_at from pack_migration_applications where plan_id=$1`,
    [planId],
  );
  const row = result.rows[0];
  return row
    ? {
      id: row.id,
      migration_id: planId,
      plan_digest: row.plan_digest,
      candidate_revision_id: row.candidate_revision_id,
      applied_by_auth_context_id: row.auth_context_id,
      applied_at: row.applied_at instanceof Date
        ? row.applied_at.toISOString()
        : String(row.applied_at),
    }
    : null;
}

async function authorizationIdentity(sql: Queryable, authContextId: string) {
  const result = await query<
    {
      principal_id: string;
      authorization_id: string | null;
      root_authorization_id: string | null;
    }
  >(
    sql,
    `select c.principal_id,c.authorization_id,a.root_authorization_id
       from auth_contexts c left join agent_authorizations a on a.id=c.authorization_id where c.id=$1`,
    [authContextId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new MigrationApplyError(
      "authorization_changed",
      "authorization context no longer exists",
    );
  }
  return {
    principalId: row.principal_id,
    authorizationRootId: row.authorization_id
      ? (row.root_authorization_id ?? row.authorization_id)
      : row.principal_id,
  };
}

function parseLockTimeout(value: string): string {
  if (!/^(?:[1-9][0-9]*)(?:ms|s|m)$/.test(value)) {
    throw new MigrationApplyError(
      "migration_lock_timeout_invalid",
      "lock_timeout must be a positive integer duration using ms, s, or m",
    );
  }
  return value;
}

function verifyStepCoverage(plan: MigrationPlan, statements: string[]) {
  if (
    !statements.length ||
    plan.dependency_graph.topological_order.length !== plan.steps.length ||
    new Set(plan.dependency_graph.topological_order).size !== plan.steps.length
  ) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "migration step graph is incomplete",
    );
  }
  const stepIds = new Set(plan.steps.map((step) => step.id));
  if (plan.dependency_graph.topological_order.some((id) => !stepIds.has(id))) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "migration step graph references an unknown step",
    );
  }
  const positions = new Map(
    plan.dependency_graph.topological_order.map((id, index) => [id, index]),
  );
  if (
    plan.dependency_graph.edges.some((edge) =>
      !stepIds.has(edge.from_step_id) || !stepIds.has(edge.to_step_id) ||
      positions.get(edge.from_step_id)! >= positions.get(edge.to_step_id)!
    )
  ) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "migration dependency order is invalid",
    );
  }
  const indexes = plan.steps.flatMap((step) => step.statement_indexes);
  if (
    indexes.length !== statements.length ||
    new Set(indexes).size !== statements.length ||
    indexes.some((index) =>
      !Number.isInteger(index) || index < 0 || index >= statements.length
    ) ||
    !indexes.sort((a, b) => a - b).every((index, position) =>
      index === position
    )
  ) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "migration statements do not have exact step coverage",
    );
  }
}

function statementOrder(plan: MigrationPlan): number[] {
  const byId = new Map(plan.steps.map((step) => [step.id, step]));
  return plan.dependency_graph.topological_order.flatMap((id) =>
    byId.get(id)!.statement_indexes
  );
}

async function structurallyValidatePersistedSql(
  sql: Queryable,
  plan: MigrationPlan,
) {
  const statements = await getMigrationSql(sql, plan.id);
  if (!statements) {
    throw new MigrationApplyError(
      "migration_plan_invalid",
      "persisted SQL is missing",
    );
  }
  verifyStepCoverage(plan, statements);
  await query(sql, "savepoint operant_structural_validation");
  try {
    for (const index of statementOrder(plan)) {
      await query(sql, statements[index]);
    }
  } finally {
    await query(sql, "rollback to savepoint operant_structural_validation");
    await query(sql, "release savepoint operant_structural_validation");
  }
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
