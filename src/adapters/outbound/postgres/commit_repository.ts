import type { CommitRepository } from "../../../application/ports/commit_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { policyActorFromAuthContext } from "../../../domain/auth/policy_actor.ts";
import type {
  CommitChangesetDto,
  CommitOptions,
} from "../../../domain/changesets/commit.ts";
import type { CanonicalOperation } from "../../../domain/changesets/operations.ts";
import { stageDigest } from "../../../domain/changesets/stage.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";
import {
  type FieldSpec,
  lowerCelToSql,
} from "../../../domain/queries/expression_lowerer.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { lowerAfterCommitCondition } from "../../../domain/outbox/condition.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { query, type Queryable, quoteIdentifier, type Sql } from "./client.ts";
import {
  type ExpectedAuthorizationLineage,
  lockActiveAuthorizationLineage,
  lockActiveAuthorizationLineages,
} from "./authorization_lineage.ts";
import {
  evaluateExactTargetedActionAuthority,
  lockExactTargetAuthorityDependencies,
} from "./query_policy_sql.ts";
import { canonicalTargetDigestInput } from "../../../application/ports/repair/targeted_action.ts";

type Runtime = {
  publisher: string;
  pack_name: string;
  definition_kind: "resource" | "relationship";
  definition_name: string;
  table_name: string;
};
type Stage = {
  operation_graph_digest: string;
  stage_digest: string;
  canonical_graph_json: unknown;
  created_principal_id: string;
  source_kind: string;
  source_identity_json: unknown;
  projects_json: unknown;
  pack_revisions_json: unknown;
  planned_events_json: unknown;
  planned_deliveries_json: unknown;
};
type OperationRow = {
  ordinal: number;
  pack_revision_id: string;
  component_revision_id: string;
  canonical_operation_json: unknown;
};
type DependencyRow = { dependency_kind: string; dependency_json: unknown };

class CommitFailure extends Error {
  constructor(
    readonly code: string,
    readonly severity:
      | "conflict"
      | "authorization"
      | "authentication"
      | "not_found"
      | "internal",
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export class PostgresCommitRepository implements CommitRepository {
  constructor(private readonly sql: Sql) {}

  async commit(
    stageId: string,
    auth: AuthContext,
    options: CommitOptions,
  ): Promise<Result<CommitChangesetDto>> {
    const retries = boundedInt(
      Deno.env.get("OPERANT_COMMIT_MAX_RETRIES"),
      3,
      0,
      10,
    );
    const jitterMin = boundedInt(
      Deno.env.get("OPERANT_COMMIT_RETRY_JITTER_MIN_MS"),
      1,
      0,
      1_000,
    );
    const jitterMax = boundedInt(
      Deno.env.get("OPERANT_COMMIT_RETRY_JITTER_MAX_MS"),
      25,
      jitterMin,
      5_000,
    );
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return ok(
          await this.sql.begin(async (tx) =>
            await attemptCommit(tx, stageId, auth, options)
          ) as CommitChangesetDto,
        );
      } catch (error) {
        const state = sqlState(error);
        if ((state === "40P01" || state === "40001") && attempt < retries) {
          await jitter(attempt, jitterMin, jitterMax);
          continue;
        }
        if (state === "40P01" || state === "40001") {
          return err(
            failure(
              "commit_retry_exhausted",
              "commit could not complete after bounded transaction retries",
              "conflict",
              { attempts: attempt + 1 },
            ),
          );
        }
        if (state === "55P03") {
          return err(
            failure("commit_busy", "changeset commit is busy", "locked"),
          );
        }
        if (["23505", "23503", "23514", "23P01"].includes(state ?? "")) {
          return err(
            failure(
              "constraint_conflict",
              "current data conflicts with the staged changeset",
              "conflict",
            ),
          );
        }
        if (error instanceof CommitFailure) {
          return err(
            failure(
              error.code,
              safeMessage(error.code),
              error.severity,
              error.details,
            ),
          );
        }
        console.error("commit transaction failed", {
          code: state ?? "unknown",
        });
        return err(
          failure("internal_error", "unexpected server error", "internal"),
        );
      }
    }
    return err(
      failure(
        "commit_retry_exhausted",
        "commit could not complete after bounded transaction retries",
        "conflict",
      ),
    );
  }
}

async function attemptCommit(
  tx: Queryable,
  stageId: string,
  auth: AuthContext,
  options: CommitOptions,
): Promise<CommitChangesetDto> {
  await query(tx, "set transaction isolation level read committed");
  await query(tx, "select set_config('lock_timeout',$1,true)", [
    `${options.lockTimeoutMs}ms`,
  ]);
  const lifecycle = (await query<{ status: string }>(
    tx,
    "select status from staged_changeset_lifecycle where stage_id=$1 for update",
    [stageId],
  )).rows[0];
  if (!lifecycle) throw new CommitFailure("not_found", "not_found");
  const prior = await loadCommit(tx, stageId);
  if (prior) {
    if (!await authorizeExistingCommit(tx, stageId, auth)) {
      throw new CommitFailure("not_found", "not_found");
    }
    return prior;
  }
  if (lifecycle.status === "cancelled") {
    throw new CommitFailure("stage_cancelled", "conflict");
  }
  if (lifecycle.status === "rejected") {
    throw new CommitFailure("approval_changed", "conflict");
  }
  if (lifecycle.status !== "ready") {
    throw new CommitFailure("approval_changed", "conflict");
  }

  const stage = (await query<Stage>(
    tx,
    `select operation_graph_digest,stage_digest,canonical_graph_json,created_principal_id,source_kind,source_identity_json,projects_json,pack_revisions_json,planned_events_json,planned_deliveries_json from staged_changesets where id=$1`,
    [stageId],
  )).rows[0];
  if (!stage) throw new CommitFailure("not_found", "not_found");
  const operationRows = (await query<OperationRow>(
    tx,
    `select ordinal,pack_revision_id,component_revision_id,canonical_operation_json from staged_changeset_operations where stage_id=$1 order by ordinal`,
    [stageId],
  )).rows;
  const operations = operationRows.map((row) =>
    record(row.canonical_operation_json) as CanonicalOperation
  );
  const graphDigest = `sha256:${await canonicalSha256({
    schema: "changeset.operations.v1",
    operations,
  })}`;
  if (
    graphDigest !== stage.operation_graph_digest ||
    graphDigest !==
      `sha256:${await canonicalSha256(stage.canonical_graph_json)}`
  ) throw new CommitFailure("internal_error", "internal");
  const dependencies = (await query<DependencyRow>(
    tx,
    `select dependency_kind,dependency_json from staged_changeset_dependencies where stage_id=$1 order by ordinal`,
    [stageId],
  )).rows.map((row) => record(row.dependency_json));
  await verifyStageDigest(tx, stageId, stage, operations, dependencies);

  const runtimes = await discoverRuntimes(tx, operations, dependencies);
  await query(tx, "savepoint commit_runtime_locks");
  try {
    for (const runtime of runtimes) {
      await query(
        tx,
        `lock table ${
          quoteIdentifier(runtime.table_name)
        } in row exclusive mode`,
      );
    }
    await query(tx, "release savepoint commit_runtime_locks");
  } catch (error) {
    if (sqlState(error) !== "42P01") throw error;
    await query(tx, "rollback to savepoint commit_runtime_locks");
    await rereadRuntimeMetadata(tx, array(stage.pack_revisions_json), runtimes);
    throw new CommitFailure("stage_stale", "conflict", {
      reason: "pack_revision_changed",
    });
  }
  await validateRevisions(tx, array(stage.pack_revisions_json));
  await validateRuntimeMetadata(tx, runtimes);
  await validateProjects(tx, array(stage.projects_json));
  await lockAndValidateDependencies(tx, dependencies, operations, runtimes);
  const targetedAction = await revalidateTargetedActionAuthority(
    tx,
    stage,
    auth,
    dependencies,
  );
  const cutoff = await authorizationCutoff(
    tx,
    stageId,
    stage,
    auth,
    operations,
    operationRows,
    runtimes,
    targetedAction,
  );

  const commitId = uuidV7();
  const committedAt = timestamp(
    (await query<{ at: string }>(tx, "select clock_timestamp()::text at"))
      .rows[0].at,
  );
  await query(
    tx,
    `insert into changeset_commits(id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest,committed_at) values($1,$2,$3,$4,$5,$6)`,
    [commitId, stageId, auth.id, cutoff, graphDigest, committedAt],
  );
  const plannedVersionIds = new Map(
    operations.filter((operation) => operation.op !== "comment").map((
      operation,
    ) => [
      String(operation.object_id ?? operation.relationship_id),
      uuidV7(),
    ]),
  );
  const createdVersions = new Map(
    operations.filter((operation) => operation.op === "create").map((
      operation,
    ) => [
      String(operation.object_id),
      plannedVersionIds.get(String(operation.object_id))!,
    ]),
  );
  const stagedTargetVersions = new Map(
    dependencies.filter((dependency) =>
      typeof dependency.project_id === "string" &&
      typeof dependency.object_id === "string" &&
      typeof dependency.expected_version_id === "string"
    ).map((dependency) => [
      `${dependency.project_id}:${dependency.object_id}`,
      String(dependency.expected_version_id),
    ]),
  );
  for (let index = 0; index < operations.length; index++) {
    await applyOperation(
      tx,
      operations[index],
      operationRows[index],
      runtimes,
      commitId,
      auth.id,
      createdVersions,
      stagedTargetVersions,
      plannedVersionIds,
      cutoff,
    );
  }
  await writeCommitFacts(tx, stageId, commitId, auth.id, operations, cutoff);
  await query(
    tx,
    `update staged_changeset_lifecycle set status='committed',version=version+1,committed_at=$2 where stage_id=$1`,
    [stageId, committedAt],
  );
  return {
    id: commitId,
    stage_id: stageId,
    committed_auth_context_id: auth.id,
    authorization_cutoff_at: cutoff,
    operation_graph_digest: graphDigest,
    committed_at: committedAt,
  };
}

async function authorizeExistingCommit(
  tx: Queryable,
  stageId: string,
  auth: AuthContext,
): Promise<boolean> {
  if (!await lockCurrentAuthorizationLineage(tx, auth)) return false;
  const row = (await query<{ allowed: boolean }>(
    tx,
    `with actor as (
       select s.principal_id,s.human_user_id,s.authorization_id
       from auth_sessions s join principals p on p.id=s.principal_id and p.active
       join human_users h on h.id=s.human_user_id and h.status='active'
       where s.id=$1 and s.principal_id=$2 and s.human_user_id=$3
         and s.authorization_id is not distinct from $4::uuid
         and s.revoked_at is null
     ), affected_projects as (
       select distinct o.project_id from staged_changeset_operations o where o.stage_id=$5
     ), roles as (
       select ra.role_id,ra.boundary_type,ra.project_id from actor a join role_assignments ra
         on a.authorization_id is null and ra.principal_id=a.principal_id and ra.active
       union all
       select ar.role_id,ar.boundary_type,ar.project_id from actor a join agent_authorization_roles ar
         on ar.authorization_id=a.authorization_id
     ), superadmin as (
       select exists(select 1 from roles r join system_roles sr on sr.id=r.role_id and sr.active
         join role_definition_versions rv on rv.role_id=sr.id and rv.active
         where r.role_id='system:super_admin' and r.boundary_type='system') value
     ), visible as (
       select not exists(select 1 from affected_projects x left join projects p on p.id=x.project_id and p.status='active' where p.id is null) value
     ), other_allowed as (
       select $2::uuid=(select created_principal_id from staged_changesets where id=$5) or
         (select value from superadmin) or not exists(
           select 1 from affected_projects x where not exists(
             select 1 from roles r join system_roles sr on sr.id=r.role_id and sr.active
             join role_definition_versions rv on rv.role_id=sr.id and rv.active
             join policy_rules pr on pr.role_id=r.role_id and pr.capability='changeset.commit_others'
               and pr.condition_kind='unconditional' and pr.resource in ('*','changeset','system:changeset')
             join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active
             join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active
             where (r.boundary_type in ('system','all_projects') or r.project_id=x.project_id)
               and (pa.boundary_type in ('system','all_projects') or pa.project_id=x.project_id)
           )
         ) value
     )
     select exists(select 1 from actor)
       and (select value from visible) and (select value from other_allowed) allowed`,
    [
      auth.sessionId,
      auth.principalId,
      auth.humanUserId,
      auth.authorizationId ?? null,
      stageId,
    ],
  )).rows[0];
  return row?.allowed === true;
}

async function rereadRuntimeMetadata(
  tx: Queryable,
  revisions: unknown[],
  discovered: Runtime[],
) {
  await validateRevisions(tx, revisions);
  await validateRuntimeMetadata(tx, discovered);
}

async function validateRuntimeMetadata(
  tx: Queryable,
  discovered: Runtime[],
) {
  for (const runtime of discovered) {
    const current = (await query<{ table_name: string }>(
      tx,
      `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2
       and definition_kind=$3 and definition_name=$4`,
      [
        runtime.publisher,
        runtime.pack_name,
        runtime.definition_kind,
        runtime.definition_name,
      ],
    )).rows[0];
    if (!current || current.table_name !== runtime.table_name) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: "pack_revision_changed",
      });
    }
  }
}

async function verifyStageDigest(
  tx: Queryable,
  stageId: string,
  stage: Stage,
  operations: CanonicalOperation[],
  dependencies: Record<string, unknown>[],
) {
  const hooks = (await query<Record<string, unknown>>(
    tx,
    `select id,attachment_id,hook_revision_id,pack_revision_id,phase,input_digest,
      output_digest,output_json output,script_digest,security_digest,logs_truncated,
      secrets_redacted,authority_snapshot_json authority_snapshot,
      grant_snapshot_json grant_snapshot
     from staged_hook_executions where stage_id=$1 order by ordinal`,
    [stageId],
  )).rows;
  const decisions = (await query<{ decision_json: unknown }>(
    tx,
    "select decision_json from staged_policy_decisions where stage_id=$1 order by ordinal",
    [stageId],
  )).rows.map((row) => record(row.decision_json));
  const approvals = (await query<{ requirement_json: unknown }>(
    tx,
    "select requirement_json from staged_approval_requirements where stage_id=$1 order by ordinal",
    [stageId],
  )).rows.map((row) => record(row.requirement_json));
  const hookOutputs = hooks.map((hook) => record(hook.output));
  const requiredCapabilities = [
    ...decisions.map((decision) =>
      `${String(decision.project_id)}:${String(decision.action)}:${
        String(decision.resource_identity)
      }`
    ),
    ...hookOutputs.flatMap((output) =>
      array(output.required_capabilities).map(String)
    ),
  ].sort();
  const effects = [
    ...operations.map((operation) =>
      `${operation.project_id}:${operation.op}:${identity(operation)}`
    ),
    ...hookOutputs.flatMap((output) => array(output.effects).map(String)),
  ].sort();
  const actual = await stageDigest({
    operation_graph_digest: stage.operation_graph_digest,
    projects: array(stage.projects_json),
    pack_revisions: array(stage.pack_revisions_json),
    operations,
    dependencies,
    hook_executions: hooks,
    policy_decisions: decisions,
    approval_requirements: approvals,
    required_capabilities: requiredCapabilities,
    effects,
    planned_events: array(stage.planned_events_json),
    planned_deliveries: array(stage.planned_deliveries_json),
  });
  if (actual !== stage.stage_digest) {
    throw new CommitFailure("internal_error", "internal");
  }
}

async function discoverRuntimes(
  tx: Queryable,
  operations: CanonicalOperation[],
  dependencies: Record<string, unknown>[],
): Promise<Runtime[]> {
  const identities = new Set(operations.map(identity));
  const dependencyKinds = new Map<string, "resource" | "relationship">();
  const expected = dependencies.flatMap((dep) =>
    typeof dep.expected_version_id === "string" ? [dep.expected_version_id] : []
  );
  if (expected.length) {
    const rows = await query<{
      resource_identity: string;
      definition_kind: "resource" | "relationship";
    }>(
      tx,
      "select distinct resource_identity,definition_kind from object_versions where id=any($1::uuid[])",
      [expected],
    );
    rows.rows.forEach((row) => {
      identities.add(row.resource_identity);
      dependencyKinds.set(row.resource_identity, row.definition_kind);
    });
  }
  const referencedPacks = new Set(
    operations.map((operation) => {
      const parsed = parseIdentity(identity(operation));
      return `${parsed.publisher}/${parsed.pack}`;
    }),
  );
  const relationPolicies = (await query<{ relation_relationship: string }>(
    tx,
    `select distinct relation_relationship from policy_rules
     where relation_relationship is not null order by relation_relationship`,
  )).rows;
  for (const policy of relationPolicies) {
    const parsed = parseIdentity(policy.relation_relationship);
    if (referencedPacks.has(`${parsed.publisher}/${parsed.pack}`)) {
      identities.add(policy.relation_relationship);
      dependencyKinds.set(policy.relation_relationship, "relationship");
    }
  }
  for (const dep of dependencies) {
    for (const key of ["resource_identity", "definition"]) {
      if (
        typeof dep[key] === "string" &&
        /^[a-z][a-z0-9-]*\/[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/.test(
          String(dep[key]),
        )
      ) {
        identities.add(String(dep[key]));
      }
    }
  }
  const parsed = [...identities].map((value) => ({
    ...parseIdentity(value),
    kind:
      operations.some((operation) =>
          identity(operation) === value && operation.relationship !== undefined
        )
        ? "relationship"
        : dependencyKinds.get(value),
  }));
  const rows: Runtime[] = [];
  for (const item of parsed) {
    const row = (await query<Runtime>(
      tx,
      `select publisher,pack_name,definition_kind,definition_name,table_name
       from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_name=$3
         and ($4::text is null or definition_kind=$4)`,
      [item.publisher, item.pack, item.name, item.kind ?? null],
    )).rows[0];
    if (!row) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: "pack_revision_changed",
      });
    }
    rows.push(row);
  }
  return [...new Map(rows.map((row) => [row.table_name, row])).values()].sort(
    compareRuntime,
  );
}

async function validateRevisions(tx: Queryable, revisions: unknown[]) {
  for (const raw of revisions) {
    const revision = record(raw);
    const current = (await query<{ candidate_revision_id: string }>(
      tx,
      "select candidate_revision_id from pack_active_revisions where publisher=$1 and pack_name=$2",
      [revision.publisher, revision.pack],
    )).rows[0];
    if (!current || current.candidate_revision_id !== revision.revision_id) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: "pack_revision_changed",
      });
    }
  }
}
async function validateProjects(tx: Queryable, projects: unknown[]) {
  for (
    const raw of [...projects].sort((a, b) =>
      String(record(a).project_id).localeCompare(String(record(b).project_id))
    )
  ) {
    const project = record(raw);
    const current = (await query<{ status: string; version: string }>(
      tx,
      "select status,version from projects where id=$1 for share",
      [project.project_id],
    )).rows[0];
    if (
      !current || current.status !== project.status ||
      Number(current.version) !== Number(project.version)
    ) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: "project_changed",
      });
    }
  }
}

async function lockAndValidateDependencies(
  tx: Queryable,
  dependencies: Record<string, unknown>[],
  operations: CanonicalOperation[],
  runtimes: Runtime[],
) {
  const mutations = new Set(
    operations.filter((op) => !["create", "link", "comment"].includes(op.op))
      .map((op) => String(op.object_id ?? op.relationship_id)),
  );
  const byVersion = new Map<
    string,
    { dep: Record<string, unknown>; mode: "share" | "update" }
  >();
  for (const dep of dependencies) {
    if (typeof dep.expected_version_id === "string") {
      const existing = byVersion.get(dep.expected_version_id);
      const mode = mutations.has(String(dep.object_id)) ? "update" : "share";
      if (!existing || mode === "update") {
        byVersion.set(dep.expected_version_id, { dep, mode });
      }
    }
  }
  const versionRows = byVersion.size
    ? (await query<
      {
        id: string;
        resource_identity: string;
        definition_kind: string;
        object_id: string;
      }
    >(
      tx,
      "select id,resource_identity,definition_kind,object_id from object_versions where id=any($1::uuid[])",
      [[...byVersion.keys()]],
    )).rows
    : [];
  if (versionRows.length !== byVersion.size) {
    throw new CommitFailure("internal_error", "internal");
  }
  const order = new Map(
    runtimes.map((
      runtime,
      index,
    ) => [
      `${runtime.definition_kind}:${runtime.publisher}/${runtime.pack_name}:${runtime.definition_name}`,
      index,
    ]),
  );
  versionRows.sort((a, b) =>
    (order.get(`${a.definition_kind}:${a.resource_identity}`) ?? 9999) -
      (order.get(`${b.definition_kind}:${b.resource_identity}`) ?? 9999) ||
    a.object_id.localeCompare(b.object_id)
  );
  for (const version of versionRows) {
    const runtime = runtimes.find((item) =>
      `${item.publisher}/${item.pack_name}:${item.definition_name}` ===
        version.resource_identity &&
      item.definition_kind === version.definition_kind
    )!;
    const item = byVersion.get(version.id)!;
    const current = (await query<{ current_object_version_id: string }>(
      tx,
      `select current_object_version_id from ${
        quoteIdentifier(runtime.table_name)
      } where project_id=$1 and id=$2 for ${item.mode}`,
      [item.dep.project_id, version.object_id],
    )).rows[0];
    if (!current || current.current_object_version_id !== version.id) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: version.definition_kind === "relationship"
          ? "relationship_version_changed"
          : "object_version_changed",
      });
    }
  }
  for (
    const dep of dependencies.filter((item) =>
      item.kind === "uniqueness" && item.present !== undefined
    )
  ) {
    const runtime = runtimes.find((item) =>
      `${item.publisher}/${item.pack_name}:${item.definition_name}` ===
        dep.definition
    );
    if (!runtime) continue;
    const rows = await query<{ id: string; current_object_version_id: string }>(
      tx,
      `select id,current_object_version_id from ${
        quoteIdentifier(runtime.table_name)
      } where project_id=$1 and ${
        quoteIdentifier(String(dep.key))
      }=$2 and archived_at is null for share`,
      [dep.project_id, dep.value],
    );
    const current = rows.rows[0];
    if (
      Boolean(current) !== Boolean(dep.present) ||
      (current && dep.object_id &&
        (current.id !== dep.object_id ||
          current.current_object_version_id !== dep.expected_version_id))
    ) {
      throw new CommitFailure("constraint_conflict", "conflict");
    }
  }
}

async function revalidateTargetedActionAuthority(
  tx: Queryable,
  stage: Stage,
  auth: AuthContext,
  dependencies: Record<string, unknown>[],
): Promise<boolean> {
  if (stage.source_kind !== "action") return false;
  const authority = dependencies.find((dependency) =>
    dependency.target_dependency === "targeted_action_authority"
  );
  if (!authority) throw new CommitFailure("internal_error", "internal");
  const cutoff = record(authority.cutoff);
  const cutoffActor = record(cutoff.actor);
  const actor = policyActorFromAuthContext(auth);
  if (
    cutoffActor.id !== actor.id ||
    cutoffActor.principal_type !== actor.principal_type ||
    cutoffActor.human_user_id !== actor.human_user_id ||
    cutoff.session_id !== auth.sessionId ||
    cutoff.authorization_id !== (auth.authorizationId ?? null)
  ) throw new CommitFailure("authorization_changed", "authorization");
  const expectedLineage = array(cutoff.authorization_lineage_ids).map(String);
  if (auth.authorizationId) {
    const lineage = await lockActiveAuthorizationLineage(tx, {
      authorizationId: auth.authorizationId,
      principalId: actor.id,
      humanUserId: actor.human_user_id,
    });
    if (!lineage.ok) {
      throw new CommitFailure(
        "authorization_ancestor_invalid",
        "authorization",
      );
    }
    const actualLineage = lineage.value.ancestry.map((fact) =>
      fact.authorizationId
    );
    if (
      lineage.value.rootAuthorizationId !== cutoff.authorization_root_id ||
      JSON.stringify(actualLineage) !== JSON.stringify(expectedLineage)
    ) {
      throw new CommitFailure(
        "authorization_ancestor_invalid",
        "authorization",
      );
    }
  } else if (
    expectedLineage.length || cutoff.authorization_root_id !== actor.id
  ) {
    throw new CommitFailure("authorization_changed", "authorization");
  }

  const exact = dependencies.filter((dependency) =>
    ["relationship", "role_assignment", "policy_rule"].includes(
      String(dependency.target_dependency),
    )
  ).sort((left, right) =>
    canonicalRecord(left).localeCompare(canonicalRecord(right))
  );
  await lockExactTargetAuthorityDependencies(tx, exact);
  for (const dependency of exact) {
    if (dependency.target_dependency === "relationship") {
      const parsed = parseIdentity(String(dependency.resource_identity));
      const runtime = (await query<{ table_name: string }>(
        tx,
        `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2
          and definition_kind='relationship' and definition_name=$3 for share`,
        [parsed.publisher, parsed.pack, parsed.name],
      )).rows[0];
      const relationship = runtime
        ? (await query<{
          id: string;
          project_id: string;
          from_object_id: string;
          to_object_id: string;
          current_object_version_id: string | null;
          archived_at: string | null;
        }>(
          tx,
          `select id,project_id,from_object_id,to_object_id,
                  current_object_version_id,archived_at::text archived_at
             from ${quoteIdentifier(runtime.table_name)}
            where project_id=$1 and id=$2`,
          [dependency.project_id, dependency.object_id],
        )).rows[0]
        : undefined;
      if (
        !relationship ||
        relationship.project_id !== dependency.relationship_project_id ||
        relationship.from_object_id !== dependency.from_object_id ||
        relationship.to_object_id !== dependency.to_object_id ||
        relationship.archived_at !== dependency.archived_at ||
        relationship.current_object_version_id !==
          (dependency.expected_version_id ?? null)
      ) throw new CommitFailure("authorization_changed", "authorization");
    } else if (dependency.target_dependency === "role_assignment") {
      const table = dependency.assignment_table === "agent_authorization_roles"
        ? "agent_authorization_roles"
        : "role_assignments";
      const assignment = (await query<{
        id: string;
        assignment_owner_id: string;
        role_id: string;
        boundary_type: string;
        project_id: string | null;
        active: boolean;
        version: number | null;
      }>(
        tx,
        table === "role_assignments"
          ? `select id,principal_id assignment_owner_id,role_id,boundary_type,
                project_id,active,version from role_assignments where id=$1`
          : `select id,authorization_id assignment_owner_id,role_id,boundary_type,
                project_id,true active,null::bigint version
               from agent_authorization_roles where id=$1`,
        [dependency.assignment_id],
      )).rows[0];
      const systemRole = (await query<{ id: string; active: boolean }>(
        tx,
        "select id,active from system_roles where id=$1",
        [dependency.system_role_id],
      )).rows[0];
      const roleVersion = (await query<{
        id: string;
        role_id: string;
        version: number;
        active: boolean;
        candidate_revision_id: string | null;
        definition_name: string | null;
      }>(
        tx,
        `select id,role_id,version,active,candidate_revision_id,definition_name
           from role_definition_versions where id=$1`,
        [dependency.role_version_id],
      )).rows[0];
      if (
        !assignment ||
        assignment.assignment_owner_id !== dependency.assignment_owner_id ||
        assignment.role_id !== dependency.assignment_role_id ||
        assignment.boundary_type !== dependency.assignment_boundary_type ||
        assignment.project_id !== dependency.assignment_project_id ||
        assignment.active !== dependency.assignment_active ||
        (assignment.version === null ? null : Number(assignment.version)) !==
          dependency.assignment_version ||
        !systemRole || systemRole.id !== dependency.system_role_id ||
        systemRole.active !== dependency.system_role_active ||
        !roleVersion ||
        roleVersion.role_id !== dependency.role_version_role_id ||
        Number(roleVersion.version) !== Number(dependency.role_version) ||
        roleVersion.active !== dependency.role_version_active ||
        roleVersion.candidate_revision_id !==
          dependency.role_candidate_revision_id ||
        roleVersion.definition_name !== dependency.role_definition_name
      ) throw new CommitFailure("authorization_changed", "authorization");
    } else {
      const row = (await query<{
        assignment_id: string;
        assignment_policy_version_id: string;
        assignment_boundary_type: string;
        assignment_project_id: string | null;
        assignment_active: boolean;
        assignment_version: number;
        policy_id: string;
        policy_version_id: string;
        policy_version: number;
        policy_version_active: boolean;
        policy_candidate_revision_id: string | null;
        policy_definition_name: string | null;
        policy_candidate_active: boolean;
        rule_id: string;
        rule_policy_version_id: string;
        rule_name: string | null;
        rule_role_id: string;
        rule_action: string;
        rule_resource: string;
        rule_condition_kind: string;
        rule_predicate: string | null;
        rule_relation_relationship: string | null;
        rule_relation_object_side: string | null;
        rule_relation_subject_side: string | null;
        rule_relation_subject: string | null;
      }>(
        tx,
        `select pa.id assignment_id,
                pa.policy_definition_version_id assignment_policy_version_id,
                pa.boundary_type assignment_boundary_type,
                pa.project_id assignment_project_id,pa.active assignment_active,
                pa.version assignment_version,pd.policy_id,
                pd.id policy_version_id,pd.version policy_version,
                pd.active policy_version_active,
                pd.candidate_revision_id policy_candidate_revision_id,
                pd.definition_name policy_definition_name,
                (pd.candidate_revision_id is null or ar.candidate_revision_id is not null)
                  policy_candidate_active,
                pr.id rule_id,
                pr.policy_definition_version_id rule_policy_version_id,
                pr.rule_name,pr.role_id rule_role_id,
                pr.capability rule_action,pr.resource rule_resource,
                pr.condition_kind rule_condition_kind,
                pr.predicate rule_predicate,
                pr.relation_relationship rule_relation_relationship,
                pr.relation_object_side rule_relation_object_side,
                pr.relation_subject_side rule_relation_subject_side,
                pr.relation_subject rule_relation_subject
           from policy_assignments pa
           join policy_definition_versions pd on pd.id=pa.policy_definition_version_id
           join policy_rules pr on pr.policy_definition_version_id=pd.id
           left join pack_active_revisions ar
             on ar.candidate_revision_id=pd.candidate_revision_id
          where pa.id=$1 and pd.id=$2 and pr.id=$3`,
        [
          dependency.policy_assignment_id,
          dependency.policy_version_id,
          dependency.rule_id,
        ],
      )).rows[0];
      if (!row) {
        throw new CommitFailure("authorization_changed", "authorization");
      }
      if (
        row.assignment_policy_version_id !==
          dependency.policy_assignment_policy_version_id ||
        row.assignment_boundary_type !==
          dependency.policy_assignment_boundary_type ||
        row.assignment_project_id !== dependency.policy_assignment_project_id ||
        row.assignment_active !== dependency.policy_assignment_active ||
        Number(row.assignment_version) !==
          Number(dependency.policy_assignment_version) ||
        row.policy_id !== dependency.policy ||
        row.policy_version_id !== dependency.policy_version_id ||
        Number(row.policy_version) !== Number(dependency.policy_version) ||
        row.policy_version_active !== dependency.policy_version_active ||
        row.policy_candidate_revision_id !==
          dependency.policy_candidate_revision_id ||
        row.policy_definition_name !== dependency.policy_definition_name ||
        row.policy_candidate_active !== dependency.policy_candidate_active ||
        row.rule_policy_version_id !== dependency.rule_policy_version_id ||
        row.rule_name !== dependency.rule_name ||
        row.rule_role_id !== dependency.rule_role_id ||
        row.rule_action !== dependency.rule_action ||
        row.rule_resource !== dependency.rule_resource ||
        row.rule_condition_kind !== dependency.rule_condition_kind ||
        dependency.rule_effect !== "allow" ||
        row.rule_predicate !== dependency.rule_predicate ||
        row.rule_relation_relationship !==
          dependency.rule_relation_relationship ||
        row.rule_relation_object_side !==
          dependency.rule_relation_object_side ||
        row.rule_relation_subject_side !==
          dependency.rule_relation_subject_side ||
        row.rule_relation_subject !== dependency.rule_relation_subject
      ) throw new CommitFailure("policy_changed", "authorization");
    }
  }

  const targets = array(authority.targets).map((raw) => {
    const target = record(raw);
    return {
      projectId: String(target.project_id),
      resource: String(target.resource),
      ...(target.object_id && target.object_version_id
        ? {
          object: {
            id: String(target.object_id),
            versionId: String(target.object_version_id),
          },
        }
        : {}),
    };
  });
  const current = await evaluateExactTargetedActionAuthority(tx, {
    projectId: String(authority.project_id),
    action: String(authority.action),
    targets,
  }, auth);
  if (!current.allowed) {
    throw new CommitFailure("authorization_changed", "authorization");
  }
  const authorization = {
    actor,
    authorizationRootId: String(cutoff.authorization_root_id),
    authorizationLineageIds: array(cutoff.authorization_lineage_ids).map(
      String,
    ),
    targets: current.targets,
  };
  const targetDigest = `sha256:${await canonicalSha256(
    canonicalTargetDigestInput(authorization),
  )}`;
  const factsDigest = `sha256:${await canonicalSha256(current.dependencies)}`;
  if (
    targetDigest !== authority.canonical_target_digest ||
    factsDigest !== authority.authority_facts_digest
  ) throw new CommitFailure("policy_changed", "authorization");
  return true;
}

function canonicalRecord(value: Record<string, unknown>): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

type ApprovalAgentSession = {
  session_id: string;
  principal_id: string;
  human_user_id: string;
  authorization_id: string;
};

async function lockCurrentAuthorizationLineage(
  tx: Queryable,
  auth: AuthContext,
): Promise<boolean> {
  const expected = expectedCurrentAuthorizationLineage(auth);
  if (expected === false) return false;
  if (expected === null) return true;
  return (await lockActiveAuthorizationLineage(tx, expected)).ok;
}

async function lockCommitAuthorizationLineages(
  tx: Queryable,
  stageId: string,
  auth: AuthContext,
): Promise<string[]> {
  const caller = expectedCurrentAuthorizationLineage(auth);
  if (caller === false) {
    throw new CommitFailure("authorization_changed", "authorization");
  }
  const approvalSessions = (await query<ApprovalAgentSession>(
    tx,
    `select distinct ds.id session_id,dc.principal_id,ds.human_user_id,
            ds.authorization_id
       from staged_approval_decisions d
       join auth_contexts dc on dc.id=d.decided_auth_context_id
       join auth_sessions ds on ds.id=dc.session_id
      where d.stage_id=$1 and ds.authorization_id is not null
      order by ds.id,dc.principal_id,ds.human_user_id,ds.authorization_id`,
    [stageId],
  )).rows;
  const expected: ExpectedAuthorizationLineage[] = [
    ...(caller ? [caller] : []),
    ...approvalSessions.map((session) => ({
      authorizationId: session.authorization_id,
      principalId: session.principal_id,
      humanUserId: session.human_user_id,
    })),
  ];
  const validations = await lockActiveAuthorizationLineages(tx, expected);
  const approvalOffset = caller ? 1 : 0;
  if (caller && !validations[0].ok) {
    throw new CommitFailure(
      "authorization_ancestor_invalid",
      "authorization",
    );
  }
  return approvalSessions.flatMap((session, index) =>
    validations[approvalOffset + index]?.ok ? [session.session_id] : []
  );
}

function expectedCurrentAuthorizationLineage(
  auth: AuthContext,
): ExpectedAuthorizationLineage | null | false {
  if (auth.credentialKind === "agent_authorization") {
    if (!auth.authorizationId || auth.principalType !== "agent_user") {
      return false;
    }
    return {
      authorizationId: auth.authorizationId,
      principalId: auth.principalId,
      humanUserId: auth.humanUserId,
    };
  }
  return auth.authorizationId || auth.principalType !== "human_user"
    ? false
    : null;
}

type CutoffRule = {
  id: string;
  capability: string;
  resource: string;
  predicate: string | null;
  relation_relationship: string | null;
  relation_object_side: "from" | "to" | null;
  relation_subject_side: "from" | "to" | null;
  relation_subject: "actor.id" | "actor.human_user_id" | null;
};

async function buildCutoffStatement(
  tx: Queryable,
  stageId: string,
  stage: Stage,
  auth: AuthContext,
  operations: CanonicalOperation[],
  operationRows: OperationRow[],
  runtimes: Runtime[],
  validAgentApprovalSessionIds: readonly string[],
  targetedAction: boolean,
): Promise<{ sql: string; params: unknown[] }> {
  const actor = policyActorFromAuthContext(auth);
  const decisions = (await query<{
    operation_key: string;
    action: string;
    resource_identity: string;
  }>(
    tx,
    `select decision_json->>'operation_key' operation_key,action,resource_identity
     from staged_policy_decisions where stage_id=$1 order by ordinal`,
    [stageId],
  )).rows;
  const decisionByKey = new Map(decisions.map((decision) => [
    decision.operation_key,
    decision,
  ]));
  const rules = (await query<CutoffRule>(
    tx,
    `select id,capability,resource,predicate,relation_relationship,
            relation_object_side,relation_subject_side,relation_subject
       from policy_rules order by id`,
  )).rows;
  const params: unknown[] = [
    auth.sessionId,
    actor.id,
    actor.human_user_id,
    auth.authorizationId ?? null,
    stageId,
    stage.created_principal_id,
    validAgentApprovalSessionIds,
  ];
  const requestedRows: string[] = [];
  const proposed: Array<{
    operation: CanonicalOperation;
    fields: Record<string, FieldSpec>;
  }> = [];
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    const decision = decisionByKey.get(String(operation.key)) ??
      (targetedAction
        ? {
          operation_key: String(operation.key),
          action: "effect.constraint",
          resource_identity: identity(operation),
        }
        : undefined);
    if (!decision) throw new CommitFailure("internal_error", "internal");
    const prepared = await policyProposedState(
      tx,
      operation,
      operationRows[index],
      runtimes,
    );
    proposed.push({ operation, fields: prepared.fields });
    const values = [
      index,
      operation.project_id,
      decision.action,
      decision.resource_identity,
      prepared.value,
    ];
    const placeholders = values.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    requestedRows.push(
      `(${placeholders[0]}::integer,${placeholders[1]}::uuid,${
        placeholders[2]
      }::text,${placeholders[3]}::text,${placeholders[4]}::jsonb)`,
    );
  }
  const conditionCases: string[] = [];
  for (let index = 0; index < proposed.length; index++) {
    const request = proposed[index];
    if (targetedAction) continue;
    for (const rule of rules) {
      const decision = decisionByKey.get(String(request.operation.key))!;
      if (
        rule.capability !== decision.action ||
        (rule.resource !== "*" && rule.resource !== decision.resource_identity)
      ) continue;
      params.push(rule.id);
      const identityPredicate =
        `req.ordinal=${index} and pr.id=$${params.length}::uuid`;
      let predicate = "true";
      if (rule.predicate) {
        const names = Object.keys(request.fields).sort();
        const columns = names.map((name) =>
          `(req.proposed->>${sqlLiteral(name)})::${
            fieldSqlType(request.fields[name].type)
          } as ${quoteIdentifier(name)}`
        );
        const lowered = lowerCelToSql(rule.predicate, {
          fields: request.fields,
          actor: {
            id: { type: "string", value: actor.id },
            human_user_id: {
              type: "string",
              value: actor.human_user_id,
            },
          },
          alias: "proposed",
          parameterOffset: params.length,
          maxNodes: 80,
          maxLength: 1000,
        });
        params.push(...lowered.params);
        predicate = `coalesce((select (${lowered.sql}) from (select ${
          columns.join(",")
        }) proposed),false)`;
      }
      if (
        rule.relation_relationship && rule.relation_object_side &&
        rule.relation_subject_side && rule.relation_subject &&
        rule.relation_object_side !== rule.relation_subject_side
      ) {
        const runtime = runtimes.find((candidate) =>
          candidate.definition_kind === "relationship" &&
          `${candidate.publisher}/${candidate.pack_name}:${candidate.definition_name}` ===
            rule.relation_relationship
        );
        if (!runtime) {
          predicate = "false";
        } else {
          const objectColumn = rule.relation_object_side === "from"
            ? "from_object_id"
            : "to_object_id";
          const subjectColumn = rule.relation_subject_side === "from"
            ? "from_object_id"
            : "to_object_id";
          const subject = rule.relation_subject === "actor.id"
            ? "$2::uuid"
            : "$3::uuid";
          const relation = `exists(select 1 from ${
            quoteIdentifier(runtime.table_name)
          } relation
            where relation.project_id=req.project_id and relation.archived_at is null
              and relation.${
            quoteIdentifier(objectColumn)
          }=(req.proposed->>'id')::uuid
              and relation.${quoteIdentifier(subjectColumn)}=${subject})`;
          predicate = `(${predicate}) and (${relation})`;
        }
      }
      conditionCases.push(`when ${identityPredicate} then (${predicate})`);
    }
  }
  const conditionSql = conditionCases.length
    ? `case ${conditionCases.join(" ")} else false end`
    : "false";
  const sql = `
with actor as (
  select s.principal_id,s.human_user_id,s.authorization_id
    from auth_sessions s join principals p on p.id=s.principal_id and p.active
    join human_users h on h.id=s.human_user_id and h.status='active'
   where s.id=$1 and s.principal_id=$2 and s.human_user_id=$3
     and s.authorization_id is not distinct from $4::uuid and s.revoked_at is null
), requested(ordinal,project_id,action,resource,proposed) as (
  values ${requestedRows.join(",")}
), roles as (
  select ra.role_id,ra.boundary_type,ra.project_id from actor a
    join role_assignments ra on a.authorization_id is null and ra.principal_id=a.principal_id and ra.active
    join system_roles sr on sr.id=ra.role_id and sr.active
    join role_definition_versions rv on rv.role_id=sr.id and rv.active
  union all
  select ar.role_id,ar.boundary_type,ar.project_id from actor a
    join agent_authorization_roles ar on ar.authorization_id=a.authorization_id
    join system_roles sr on sr.id=ar.role_id and sr.active
    join role_definition_versions rv on rv.role_id=sr.id and rv.active
), superadmin as (
  select exists(select 1 from roles where role_id='system:super_admin' and boundary_type='system') value
), applicable as (
  select req.ordinal,pr.id,(${conditionSql}) condition_allowed
    from requested req join roles role
      on role.boundary_type in ('system','all_projects') or role.project_id=req.project_id
    join policy_rules pr on pr.role_id=role.role_id and pr.capability=req.action
      and (pr.resource='*' or pr.resource=req.resource)
    join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active
    join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active
      and (pa.boundary_type in ('system','all_projects') or pa.project_id=req.project_id)
), operation_authority as (
  select req.ordinal,${
    targetedAction
      ? "true"
      : "(select value from superadmin) or exists(\n    select 1 from applicable a where a.ordinal=req.ordinal and a.condition_allowed\n  )"
  } allowed from requested req
), valid_approvals as (
  select d.requirement_id,d.principal_id,d.decision
    from staged_approval_decisions d
    join staged_approval_requirements req on req.id=d.requirement_id and req.stage_id=$5
    join principals principal on principal.id=d.principal_id and principal.active
    join auth_contexts dc on dc.id=d.decided_auth_context_id and dc.principal_id=d.principal_id
    join auth_sessions ds on ds.id=dc.session_id and ds.principal_id=d.principal_id
    join human_users human on human.id=ds.human_user_id and human.status='active'
   where (req.requirement_json->'principal_types') ? principal.type
     and ((req.requirement_json->>'allow_initiator')::boolean or d.principal_id<>$6::uuid)
     and (ds.authorization_id is null or ds.id=any($7::uuid[]))
     and (exists(select 1 from role_assignments ra join system_roles sr on sr.id=ra.role_id and sr.active
           join role_definition_versions rv on rv.role_id=sr.id and rv.active
           where ds.authorization_id is null and ra.principal_id=d.principal_id and ra.active
             and ra.role_id=req.requirement_json->>'role'
             and case req.requirement_json->'boundary'->>'type'
               when 'system' then ra.boundary_type='system'
               when 'all_projects' then ra.boundary_type in ('system','all_projects')
               else ra.boundary_type in ('system','all_projects') or
                 (ra.boundary_type='project' and ra.project_id=(req.requirement_json->'boundary'->>'project_id')::uuid)
             end)
       or exists(select 1 from agent_authorization_roles ar join system_roles sr on sr.id=ar.role_id and sr.active
           join role_definition_versions rv on rv.role_id=sr.id and rv.active
           where ar.authorization_id=ds.authorization_id and ar.role_id=req.requirement_json->>'role'
             and case req.requirement_json->'boundary'->>'type'
               when 'system' then ar.boundary_type='system'
               when 'all_projects' then ar.boundary_type in ('system','all_projects')
               else ar.boundary_type in ('system','all_projects') or
                 (ar.boundary_type='project' and ar.project_id=(req.requirement_json->'boundary'->>'project_id')::uuid)
             end))
), approvals_valid as (
  select not exists(select 1 from staged_approval_requirements req where req.stage_id=$5 and (
    (req.requirement_json->>'expires_at') is not null and (req.requirement_json->>'expires_at')::timestamptz<=statement_timestamp()
    or exists(select 1 from staged_approval_decisions rejected where rejected.requirement_id=req.id and rejected.decision='reject')
    or (select count(distinct approved.principal_id) from valid_approvals approved where approved.requirement_id=req.id and approved.decision='approve') < (req.requirement_json->>'minimum')::integer
  )) value
), commit_other as (
  select $2::uuid=$6::uuid or (select value from superadmin) or not exists(
    select 1 from (select distinct project_id from requested) project where not exists(
      select 1 from roles role join policy_rules pr on pr.role_id=role.role_id
      join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active
      join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active
      where pr.capability='changeset.commit_others' and pr.resource in ('*','changeset','system:changeset')
        and pr.condition_kind='unconditional'
        and (role.boundary_type in ('system','all_projects') or role.project_id=project.project_id)
        and (pa.boundary_type in ('system','all_projects') or pa.project_id=project.project_id)
    )
  ) value
)
select statement_timestamp()::text cutoff,exists(select 1 from actor) actor_valid,
  (select value from commit_other) commit_other,
  coalesce((select bool_and(allowed) from operation_authority),false) operations_allowed,
  (select value from approvals_valid) approvals_valid`;
  return { sql, params };
}

async function policyProposedState(
  tx: Queryable,
  operation: CanonicalOperation,
  evidence: OperationRow,
  runtimes: Runtime[],
): Promise<
  { value: Record<string, unknown>; fields: Record<string, FieldSpec> }
> {
  const parsed = parseIdentity(identity(operation));
  const revision = (await query<{ normalized: unknown }>(
    tx,
    "select normalized from pack_candidate_revisions where id=$1",
    [evidence.pack_revision_id],
  )).rows[0];
  const section = operation.relationship ? "relationships" : "resources";
  const definition = record(
    record(record(revision?.normalized)[section])[parsed.name],
  );
  const fields = Object.fromEntries(
    Object.entries(record(record(definition.spec).fields)).map(
      ([name, value]) => {
        const spec = record(value);
        return [name, {
          type: String(spec.type) as FieldSpec["type"],
          ...(spec.required !== true ? { nullable: true } : {}),
          ...(spec.format === "uuid" || spec.ref
            ? { format: "uuid" as const }
            : {}),
        }];
      },
    ),
  );
  if (operation.op === "create") {
    return {
      value: {
        ...record(operation.fields),
        id: operation.object_id,
        project_id: operation.project_id,
      },
      fields,
    };
  }
  if (operation.op === "link") {
    return {
      value: {
        ...record(operation.fields),
        id: operation.relationship_id,
        project_id: operation.project_id,
        from: operation.from,
        to: operation.to,
      },
      fields,
    };
  }
  const kind = operation.op === "unlink" ? "relationship" : "resource";
  const runtime = runtimes.find((candidate) =>
    candidate.definition_kind === kind &&
    `${candidate.publisher}/${candidate.pack_name}:${candidate.definition_name}` ===
      identity(operation)
  );
  if (!runtime) throw new CommitFailure("internal_error", "internal");
  const objectId = operation.op === "unlink"
    ? operation.relationship_id
    : operation.object_id;
  const current = (await query<Record<string, unknown>>(
    tx,
    `select * from ${
      quoteIdentifier(runtime.table_name)
    } where project_id=$1 and id=$2`,
    [operation.project_id, objectId],
  )).rows[0];
  const value = { ...current, ...record(operation.set) };
  for (const field of array(operation.unset).map(String)) delete value[field];
  if (operation.op === "transition") {
    const effects = await transitionEffects(
      tx,
      evidence.pack_revision_id,
      identity(operation),
      current,
      String(operation.to),
    );
    Object.assign(value, effects.set, { [effects.field]: operation.to });
    for (const field of effects.unset) delete value[field];
  }
  return { value, fields };
}

function fieldSqlType(type: FieldSpec["type"]): string {
  return type === "integer"
    ? "bigint"
    : type === "decimal"
    ? "numeric"
    : type === "boolean"
    ? "boolean"
    : type === "date"
    ? "date"
    : type === "timestamp"
    ? "timestamptz"
    : "text";
}
function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function authorizationCutoff(
  tx: Queryable,
  stageId: string,
  stage: Stage,
  auth: AuthContext,
  operations: CanonicalOperation[],
  operationRows: OperationRow[],
  runtimes: Runtime[],
  targetedAction: boolean,
): Promise<string> {
  const validAgentApprovalSessionIds = await lockCommitAuthorizationLineages(
    tx,
    stageId,
    auth,
  );
  const generated = await buildCutoffStatement(
    tx,
    stageId,
    stage,
    auth,
    operations,
    operationRows,
    runtimes,
    validAgentApprovalSessionIds,
    targetedAction,
  );
  const row = (await query<{
    cutoff: string;
    actor_valid: boolean;
    commit_other: boolean;
    operations_allowed: boolean;
    approvals_valid: boolean;
  }>(tx, generated.sql, generated.params)).rows[0];
  if (!row?.actor_valid) {
    throw new CommitFailure("authorization_changed", "authorization");
  }
  if (!row.commit_other || !row.operations_allowed) {
    throw new CommitFailure("authorization_changed", "authorization");
  }
  if (!row.approvals_valid) {
    throw new CommitFailure("approval_changed", "conflict");
  }
  return timestamp(row.cutoff);
}

async function applyOperation(
  tx: Queryable,
  operation: CanonicalOperation,
  evidence: OperationRow,
  runtimes: Runtime[],
  commitId: string,
  authId: string,
  createdVersions: Map<string, string>,
  stagedTargetVersions: Map<string, string>,
  plannedVersionIds: Map<string, string>,
  cutoff: string,
) {
  const kind = operation.relationship ? "relationship" : "resource";
  const runtime = runtimes.find((item) =>
    item.definition_kind === kind &&
    `${item.publisher}/${item.pack_name}:${item.definition_name}` ===
      identity(operation)
  );
  if (!runtime) {
    throw new CommitFailure("stage_stale", "conflict", {
      reason: "pack_revision_changed",
    });
  }
  const table = quoteIdentifier(runtime.table_name),
    project = operation.project_id;
  if (operation.op === "comment") {
    const targetVersion = createdVersions.get(String(operation.object_id)) ??
      stagedTargetVersions.get(`${project}:${String(operation.object_id)}`);
    if (!targetVersion) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: "object_version_changed",
      });
    }
    await query(
      tx,
      `insert into comments(id,project_id,definition_kind,resource_identity,object_id,target_object_version_id,changeset_commit_id,auth_context_id,body) values($1,$2,'resource',$3,$4,$5,$6,$7,$8)`,
      [
        operation.comment_id,
        project,
        identity(operation),
        operation.object_id,
        targetVersion,
        commitId,
        authId,
        operation.body,
      ],
    );
    await event(
      tx,
      commitId,
      project,
      targetVersion,
      "comment.added",
      identity(operation),
      String(operation.object_id),
      {},
    );
    await query(
      tx,
      `insert into audit_events(id,changeset_commit_id,object_version_id,auth_context_id,event_type,project_id,resource_identity,object_id,action,decision,policy_summary_json)
       values($1,$2,$3,$4,'comment.added',$5,$6,$7,'comment','committed',$8::jsonb)`,
      [
        uuidV7(),
        commitId,
        targetVersion,
        authId,
        project,
        identity(operation),
        operation.object_id,
        { authorization_cutoff_at: cutoff },
      ],
    );
    return;
  }
  const objectId = String(operation.object_id ?? operation.relationship_id);
  let version = 1,
    previous: string | null = null,
    snapshot: Record<string, unknown>,
    changed: string[],
    transitionFrom: unknown = null;
  if (operation.op === "create" || operation.op === "link") {
    const values = operation.op === "create"
      ? record(operation.fields)
      : record(operation.fields);
    const columns = Object.keys(values).sort();
    const baseColumns = operation.op === "link"
      ? [
        "id",
        "project_id",
        "from_object_id",
        "to_object_id",
        "version",
        "created_by",
        "updated_by",
      ]
      : ["id", "project_id", "version", "created_by", "updated_by"];
    const params: unknown[] = [
      objectId,
      project,
      ...(operation.op === "link" ? [operation.from, operation.to] : []),
      1,
      authId,
      authId,
      ...columns.map((key) => values[key]),
    ];
    const inserted = (await query<Record<string, unknown>>(
      tx,
      `insert into ${table}(${
        [...baseColumns, ...columns].map(quoteIdentifier).join(",")
      }) values(${params.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
      params,
    )).rows[0];
    const persistedFields = projectionData(inserted);
    snapshot = operation.op === "link"
      ? {
        from: inserted.from_object_id,
        to: inserted.to_object_id,
        fields: persistedFields,
        archived_at: null,
      }
      : { data: persistedFields, archived_at: null };
    changed = columns;
  } else {
    const current = (await query<Record<string, unknown>>(
      tx,
      `select * from ${table} where project_id=$1 and id=$2 for update`,
      [project, objectId],
    )).rows[0];
    if (!current) {
      throw new CommitFailure("stage_stale", "conflict", {
        reason: kind === "relationship"
          ? "relationship_version_changed"
          : "object_version_changed",
      });
    }
    if (current.archived_at !== null && current.archived_at !== undefined) {
      throw new CommitFailure("constraint_conflict", "conflict");
    }
    version = Number(current.version) + 1;
    previous = String(current.current_object_version_id);
    let set = record(operation.set);
    let unset = array(operation.unset).map(String);
    let transitionField: string | null = null;
    if (operation.op === "transition") {
      const transition = await transitionEffects(
        tx,
        evidence.pack_revision_id,
        identity(operation),
        current,
        String(operation.to),
      );
      transitionField = transition.field;
      set = { ...set, ...transition.set };
      unset = [...new Set([...unset, ...transition.unset])].filter((field) =>
        !Object.hasOwn(set, field)
      );
    }
    const assignments: string[] = [
      "version=$3",
      "updated_at=now()",
      "updated_by=$4",
    ];
    const params: unknown[] = [project, objectId, version, authId];
    for (const key of Object.keys(set).sort()) {
      params.push(set[key]);
      assignments.push(`${quoteIdentifier(key)}=$${params.length}`);
    }
    for (const key of unset.sort()) {
      assignments.push(`${quoteIdentifier(key)}=null`);
    }
    if (transitionField) {
      transitionFrom = current[transitionField];
      params.push(operation.to);
      assignments.push(
        `${quoteIdentifier(transitionField)}=$${params.length}`,
      );
    }
    if (operation.op === "archive" || operation.op === "unlink") {
      assignments.push("archived_at=now()", `archived_by=$4`);
    }
    const updated = (await query<Record<string, unknown>>(
      tx,
      `update ${table} set ${
        assignments.join(",")
      } where project_id=$1 and id=$2 returning *`,
      params,
    )).rows[0];
    const fields = projectionData(updated);
    snapshot = kind === "relationship"
      ? {
        from: updated.from_object_id,
        to: updated.to_object_id,
        fields,
        archived_at: updated.archived_at,
      }
      : { data: fields, archived_at: updated.archived_at };
    changed = [
      ...new Set([
        ...Object.keys(set),
        ...unset,
        ...(transitionField ? [transitionField] : []),
        ...(operation.op === "archive" || operation.op === "unlink"
          ? ["archived_at"]
          : []),
      ]),
    ].sort();
  }
  const versionId = plannedVersionIds.get(objectId);
  if (!versionId) throw new CommitFailure("internal_error", "internal");
  await query(
    tx,
    `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,previous_version_id,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)`,
    [
      versionId,
      project,
      kind,
      identity(operation),
      objectId,
      version,
      previous,
      commitId,
      operation.op,
      evidence.pack_revision_id,
      snapshot,
      changed,
      authId,
    ],
  );
  await query(
    tx,
    `update ${table} set current_object_version_id=$3 where project_id=$1 and id=$2`,
    [project, objectId, versionId],
  );
  const eventType = operation.op === "link"
    ? "relationship.created"
    : operation.op === "unlink"
    ? "relationship.unlinked"
    : operation.op === "transition"
    ? "object.transitioned"
    : `object.${operation.op}${operation.op.endsWith("e") ? "d" : "ed"}`;
  await event(
    tx,
    commitId,
    project,
    versionId,
    eventType,
    identity(operation),
    objectId,
    operation.op === "transition"
      ? {
        changed_fields: changed,
        from_state: transitionFrom,
        to_state: operation.to,
      }
      : { changed_fields: changed },
  );
  await audit(
    tx,
    commitId,
    authId,
    project,
    versionId,
    eventType,
    identity(operation),
    objectId,
    operation.op,
    cutoff,
  );
}

async function writeCommitFacts(
  tx: Queryable,
  stageId: string,
  commitId: string,
  authId: string,
  operations: CanonicalOperation[],
  cutoff: string,
) {
  const hookExecutionIds = (await query<{ ids: string[] }>(
    tx,
    `select coalesce(array_agg(id order by ordinal),'{}'::uuid[]) ids
     from staged_hook_executions where stage_id=$1`,
    [stageId],
  )).rows[0].ids;
  await query(
    tx,
    `insert into audit_events(id,stage_id,changeset_commit_id,auth_context_id,event_type,action,decision,policy_summary_json,validation_summary_json,hook_execution_ids)
     values($1,$2,$3,$4,'changeset.committed','changeset.commit','committed',$5::jsonb,$6::jsonb,$7)`,
    [
      uuidV7(),
      stageId,
      commitId,
      authId,
      { authorization_cutoff_at: cutoff },
      { operation_count: operations.length },
      hookExecutionIds,
    ],
  );
  await event(tx, commitId, null, null, "changeset.committed", null, null, {
    operation_count: operations.length,
  });
}
async function event(
  tx: Queryable,
  commitId: string,
  project: string | null,
  version: string | null,
  type: string,
  resource: string | null,
  objectId: string | null,
  payload: unknown,
): Promise<string> {
  const eventId = uuidV7();
  await query(
    tx,
    `insert into events(id,changeset_commit_id,project_id,object_version_id,schema_version,event_type,resource_identity,object_id,payload_json) values($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb)`,
    [eventId, commitId, project, version, type, resource, objectId, payload],
  );
  await enqueueAfterCommitDeliveries(tx, {
    id: eventId,
    commitId,
    project,
    version,
    type,
    resource,
    objectId,
    payload,
  });
  return eventId;
}

type AfterCommitAttachment = {
  attachment_id: string;
  candidate_revision_id: string;
  hook_revision_id: string;
  hook_identity: string;
  declaration_digest: string;
  declaration_spec: unknown;
  hook_script_digest: string;
  hook_security_digest: string;
  hook_normalized_config: unknown;
};

async function enqueueAfterCommitDeliveries(
  tx: Queryable,
  event: {
    id: string;
    commitId: string;
    project: string | null;
    version: string | null;
    type: string;
    resource: string | null;
    objectId: string | null;
    payload: unknown;
  },
): Promise<void> {
  const attachments = (await query<AfterCommitAttachment>(
    tx,
    `select attachment.id attachment_id,attachment.candidate_revision_id,
       attachment.hook_revision_id,attachment.hook_identity,
       attachment.declaration_digest,attachment.declaration_spec,
       hook.hook_script_digest,hook.hook_security_digest,hook.hook_normalized_config
     from pack_hook_attachment_revisions attachment
     join pack_active_revisions active
       on active.candidate_revision_id=attachment.candidate_revision_id
     join pack_component_revisions hook on hook.id=attachment.hook_revision_id
     where attachment.phase='event.after_commit'
       and (attachment.declaration_spec->'event'='null'::jsonb or
            attachment.declaration_spec->>'event'=$1)
       and (attachment.declaration_spec->'resource'='null'::jsonb or
            attachment.declaration_spec->>'resource'=$2)
       and (attachment.declaration_spec->'action'='null'::jsonb or
            attachment.declaration_spec->>'action'=$3)
     order by attachment.ordinal,attachment.id`,
    [
      event.type,
      event.resource,
      typeof record(event.payload).action === "string"
        ? record(event.payload).action
        : null,
    ],
  )).rows;
  if (attachments.length === 0) return;
  const committedIdentity = (await query<{
    committed_auth_context_id: string;
    principal_id: string;
    human_user_id: string;
  }>(
    tx,
    `select commit.committed_auth_context_id,context.principal_id,context.human_user_id
     from changeset_commits commit
     join auth_contexts context on context.id=commit.committed_auth_context_id
     where commit.id=$1`,
    [event.commitId],
  )).rows[0];
  if (!committedIdentity) throw new Error("commit auth context is unavailable");
  const authContextId = committedIdentity.committed_auth_context_id;

  const objectVersion = event.version
    ? (await query<{
      snapshot_json: unknown;
      version: number;
      operation: string;
    }>(
      tx,
      "select snapshot_json,version,operation from object_versions where id=$1",
      [event.version],
    )).rows[0] ?? null
    : null;
  const eventValue = {
    id: event.id,
    type: event.type,
    project_id: event.project,
    object_version_id: event.version,
    resource: event.resource,
    object_id: event.objectId,
    payload: event.payload,
  };
  for (const attachment of attachments) {
    const declaration = record(attachment.declaration_spec);
    const condition = declaration.condition;
    if (typeof condition === "string") {
      const lowered = lowerAfterCommitCondition(condition, {
        alias: "condition_context",
        parameterOffset: 9,
        actor: {
          id: committedIdentity.principal_id,
          human_user_id: committedIdentity.human_user_id,
          auth_context_id: authContextId,
        },
      });
      const matches = (await query<{ matches: boolean }>(
        tx,
        `select ${lowered.sql} matches from (select
           $1::uuid event_id,$2::text event_type,$3::uuid project_id,
           $4::text resource,$5::uuid object_id,$6::uuid object_version_id,
           $7::integer version,$8::text operation,$9::timestamptz archived_at
         ) condition_context`,
        [
          event.id,
          event.type,
          event.project,
          event.resource,
          event.objectId,
          event.version,
          objectVersion?.version ?? null,
          objectVersion?.operation ?? null,
          typeof record(objectVersion?.snapshot_json).archived_at === "string"
            ? record(objectVersion?.snapshot_json).archived_at
            : null,
          ...lowered.params,
        ],
      )).rows[0]?.matches === true;
      if (!matches) continue;
    }
    const config = record(attachment.hook_normalized_config);
    const nestedSpec = record(config.spec);
    const spec = Object.keys(nestedSpec).length > 0 ? nestedSpec : config;
    const output = record(spec.output);
    if (output.schema !== "delivery.v1") {
      throw new Error("event.after_commit hook must use delivery.v1");
    }
    const timeoutMs = durationMilliseconds(spec.timeout_ms ?? spec.timeout);
    const permissions = record(spec.permissions);
    const secrets = Array.isArray(spec.secrets) ? spec.secrets.map(record) : [];
    const grants: Array<Record<string, unknown>> = [];
    for (const secret of secrets) {
      const slot = typeof secret.slot === "string"
        ? secret.slot
        : typeof secret.name === "string"
        ? secret.name
        : null;
      const env = typeof secret.env === "string" ? secret.env : null;
      if (!slot || !env) throw new Error("hook secret declaration is invalid");
      const grant = (await query<{ grant_id: string; secret_id: string }>(
        tx,
        `select head.grant_id,g.secret_id
         from hook_secret_grant_heads head
         join hook_secret_grants g on g.id=head.grant_id
         where head.hook_revision_id=$1 and head.slot=$2`,
        [attachment.hook_revision_id, slot],
      )).rows[0];
      grants.push({
        slot,
        env,
        grant_id: grant?.grant_id ?? null,
        secret_id: grant?.secret_id ?? null,
      });
    }
    const deliveryId = uuidV7();
    const envelope = {
      hook: attachment.hook_identity,
      phase: "event.after_commit",
      input: materializeAfterCommitInput(
        record(attachment.declaration_spec).input,
        {
          event: eventValue,
          objectVersion: objectVersion?.snapshot_json ?? null,
          actor: {
            id: committedIdentity.principal_id,
            human_user_id: committedIdentity.human_user_id,
            auth_context_id: authContextId,
          },
        },
      ),
      metadata: {
        delivery: { delivery_id: deliveryId, idempotency_key: deliveryId },
      },
    };
    await query(
      tx,
      `insert into outbox_deliveries(
        id,event_id,attachment_id,candidate_revision_id,hook_revision_id,hook_identity,
        script_digest,security_digest,attachment_digest,config_digest,
        envelope_schema,output_schema,envelope_json,attachment_spec_json,hook_config_json,
        capabilities_json,effects_json,pinned_grants_json,auth_context_id,changeset_commit_id,
        status,max_attempts,timeout_ms,available_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'delivery.v1','delivery.v1',$11::jsonb,
        $12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18,
        'pending',$19,$20,now())`,
      [
        deliveryId,
        event.id,
        attachment.attachment_id,
        attachment.candidate_revision_id,
        attachment.hook_revision_id,
        attachment.hook_identity,
        attachment.hook_script_digest,
        attachment.hook_security_digest,
        attachment.declaration_digest,
        `sha256:${await canonicalSha256(config)}`,
        envelope,
        attachment.declaration_spec,
        config,
        permissions,
        spec.effects ?? {},
        grants,
        authContextId,
        event.commitId,
        boundedInt(Deno.env.get("OPERANT_OUTBOX_MAX_ATTEMPTS"), 10, 1, 1000),
        timeoutMs,
      ],
    );
  }
}

function materializeAfterCommitInput(
  value: unknown,
  context: {
    event: Record<string, unknown>;
    objectVersion: unknown;
    actor: Record<string, unknown>;
  },
): unknown {
  if (value === "$event") return context.event;
  if (value === "$object_version") return context.objectVersion;
  if (value === "$actor") return context.actor;
  if (typeof value === "string" && value.startsWith("$")) {
    throw new Error(
      "after-commit input mapping references unavailable context",
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => materializeAfterCommitInput(item, context));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        materializeAfterCommitInput(item, context),
      ]),
    );
  }
  return value;
}

function durationMilliseconds(value: unknown): number {
  if (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 1 &&
    value <= 600_000
  ) return value;
  if (typeof value !== "string") throw new Error("hook timeout is invalid");
  const match = /^(\d+)(ms|s|m)$/.exec(value);
  if (!match) throw new Error("hook timeout is invalid");
  const milliseconds = Number(match[1]) *
    (match[2] === "ms" ? 1 : match[2] === "s" ? 1_000 : 60_000);
  if (
    !Number.isSafeInteger(milliseconds) || milliseconds < 1 ||
    milliseconds > 600_000
  ) {
    throw new Error("hook timeout is invalid");
  }
  return milliseconds;
}
async function audit(
  tx: Queryable,
  commitId: string,
  authId: string,
  project: string,
  version: string,
  type: string,
  resource: string,
  objectId: string,
  action: string,
  cutoff: string,
) {
  await query(
    tx,
    `insert into audit_events(id,changeset_commit_id,object_version_id,auth_context_id,event_type,project_id,resource_identity,object_id,action,decision,policy_summary_json) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed',$10::jsonb)`,
    [
      uuidV7(),
      commitId,
      version,
      authId,
      type,
      project,
      resource,
      objectId,
      action,
      { authorization_cutoff_at: cutoff },
    ],
  );
}
async function transitionEffects(
  tx: Queryable,
  revision: string,
  resource: string,
  current: Record<string, unknown>,
  to: string,
): Promise<{ field: string; set: Record<string, unknown>; unset: string[] }> {
  const row = (await query<{ normalized: unknown }>(
    tx,
    "select normalized from pack_candidate_revisions where id=$1",
    [revision],
  )).rows[0];
  const found = Object.values(record(record(row?.normalized).lifecycles))
    .map(record).find((item) => record(item.spec).resource === resource);
  if (!found) {
    throw new CommitFailure("stage_stale", "conflict", {
      reason: "pack_revision_changed",
    });
  }
  const spec = record(found.spec);
  const field = String(spec.field);
  const edge = array(spec.transitions).map(record).find((candidate) =>
    candidate.to === to && array(candidate.from).includes(current[field])
  );
  if (!edge) {
    throw new CommitFailure("stage_stale", "conflict", {
      reason: "object_version_changed",
    });
  }
  return {
    field,
    set: record(edge.set),
    unset: array(edge.unset).map(String),
  };
}
async function loadCommit(
  tx: Queryable,
  stageId: string,
): Promise<CommitChangesetDto | null> {
  const row = (await query<Record<string, unknown>>(
    tx,
    "select id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest,committed_at from changeset_commits where stage_id=$1",
    [stageId],
  )).rows[0];
  return row
    ? {
      id: String(row.id),
      stage_id: String(row.stage_id),
      committed_auth_context_id: String(row.committed_auth_context_id),
      authorization_cutoff_at: timestamp(row.authorization_cutoff_at),
      operation_graph_digest: String(row.operation_graph_digest),
      committed_at: timestamp(row.committed_at),
    }
    : null;
}
function projectionData(row: Record<string, unknown>) {
  const platform = new Set([
    "id",
    "project_id",
    "version",
    "current_object_version_id",
    "created_at",
    "updated_at",
    "created_by",
    "updated_by",
    "archived_at",
    "archived_by",
    "from_object_id",
    "to_object_id",
  ]);
  return Object.fromEntries(
    Object.entries(row).filter(([key]) => !platform.has(key)),
  );
}
function identity(op: CanonicalOperation): string {
  return String(op.resource ?? op.relationship);
}
function parseIdentity(value: string) {
  const match = /^([^/]+)\/([^:]+):(.+)$/.exec(value);
  if (!match) throw new CommitFailure("internal_error", "internal");
  return { publisher: match[1], pack: match[2], name: match[3] };
}
function compareRuntime(a: Runtime, b: Runtime) {
  return a.publisher.localeCompare(b.publisher) ||
    a.pack_name.localeCompare(b.pack_name) ||
    (a.definition_kind === "resource" ? 0 : 1) -
      (b.definition_kind === "resource" ? 0 : 1) ||
    a.definition_name.localeCompare(b.definition_name) ||
    a.table_name.localeCompare(b.table_name);
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") value = JSON.parse(value);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function array(value: unknown): unknown[] {
  if (typeof value === "string") value = JSON.parse(value);
  return Array.isArray(value) ? value : [];
}
function timestamp(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}
function sqlState(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
function boundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const n = Number(value ?? fallback);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
async function jitter(attempt: number, minimum: number, maximum: number) {
  const ceiling = Math.min(maximum, Math.max(minimum, minimum * (attempt + 1)));
  const span = ceiling - minimum + 1;
  const delay = minimum +
    (span > 1 ? crypto.getRandomValues(new Uint32Array(1))[0] % span : 0);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
function safeMessage(code: string) {
  return ({
    stage_stale: "the staged changeset is no longer current",
    stage_cancelled: "changeset was cancelled",
    approval_changed: "current approvals no longer satisfy the stage",
    authorization_changed: "current authority no longer permits commit",
    authorization_ancestor_invalid:
      "agent authorization ancestry is no longer valid",
    not_found: "changeset was not found",
    internal_error: "unexpected server error",
  } as Record<string, string>)[code] ?? "changeset commit failed";
}
function failure(
  code: string,
  message: string,
  severity:
    | "validation"
    | "authentication"
    | "authorization"
    | "not_found"
    | "conflict"
    | "locked"
    | "internal",
  details: Record<string, unknown> = {},
) {
  return { code, message, severity, details };
}
