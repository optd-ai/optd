import type { CommitRepository } from "../../../application/ports/commit_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type {
  CommitChangesetDto,
  CommitOptions,
} from "../../../domain/changesets/commit.ts";
import type { CanonicalOperation } from "../../../domain/changesets/operations.ts";
import { stageDigest } from "../../../domain/changesets/stage.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { query, type Queryable, quoteIdentifier, type Sql } from "./client.ts";

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
          await jitter(attempt);
          continue;
        }
        if (state === "40P01" || state === "40001") {
          return err(
            failure(
              "commit_retry_exhausted",
              "commit could not complete after bounded transaction retries",
              "conflict",
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
  if (prior) return prior;
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
  for (const runtime of runtimes) {
    try {
      await query(
        tx,
        `lock table ${
          quoteIdentifier(runtime.table_name)
        } in row exclusive mode`,
      );
    } catch (error) {
      if (sqlState(error) === "42P01") {
        throw new CommitFailure("stage_stale", "conflict", {
          reason: "pack_revision_changed",
        });
      }
      throw error;
    }
  }
  await validateRevisions(tx, array(stage.pack_revisions_json));
  await validateProjects(tx, array(stage.projects_json));
  await lockAndValidateDependencies(tx, dependencies, operations, runtimes);
  const cutoff = await authorizationCutoff(tx, stageId, stage, auth);

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
  const produced = new Map<string, string>();
  for (let index = 0; index < operations.length; index++) {
    await applyOperation(
      tx,
      operations[index],
      operationRows[index],
      runtimes,
      commitId,
      auth.id,
      produced,
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
  const expected = dependencies.flatMap((dep) =>
    typeof dep.expected_version_id === "string" ? [dep.expected_version_id] : []
  );
  if (expected.length) {
    const rows = await query<{ resource_identity: string }>(
      tx,
      "select distinct resource_identity from object_versions where id=any($1::uuid[])",
      [expected],
    );
    rows.rows.forEach((row) => identities.add(row.resource_identity));
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
  const parsed = [...identities].map(parseIdentity);
  const rows: Runtime[] = [];
  for (const item of parsed) {
    const row = (await query<Runtime>(
      tx,
      `select publisher,pack_name,definition_kind,definition_name,table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_name=$3`,
      [item.publisher, item.pack, item.name],
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

async function authorizationCutoff(
  tx: Queryable,
  stageId: string,
  stage: Stage,
  auth: AuthContext,
): Promise<string> {
  const row = (await query<
    {
      cutoff: string;
      actor_valid: boolean;
      ancestry_valid: boolean;
      commit_other: boolean;
      operations_allowed: boolean;
      approvals_valid: boolean;
    }
  >(
    tx,
    `
with recursive lineage(id,parent_authorization_id,valid) as (
 select a.id,a.parent_authorization_id,(a.revoked_at is null and a.superseded_at is null) from agent_authorizations a where a.id=$4::uuid
 union all select a.id,a.parent_authorization_id,(a.revoked_at is null and a.superseded_at is null) from agent_authorizations a join lineage l on a.id=l.parent_authorization_id
), actor as (
 select s.principal_id,s.authorization_id from auth_sessions s join principals p on p.id=s.principal_id and p.active join human_users h on h.id=s.human_user_id and h.status='active'
 where s.id=$1 and s.principal_id=$2 and s.human_user_id=$3 and s.revoked_at is null
), requested as (
 select project_id,action,resource_identity resource
 from staged_policy_decisions where stage_id=$5
),
roles as (
 select ra.role_id,ra.boundary_type,ra.project_id from actor a join role_assignments ra on a.authorization_id is null and ra.principal_id=a.principal_id and ra.active
 union all select ar.role_id,ar.boundary_type,ar.project_id from actor a join agent_authorization_roles ar on ar.authorization_id=a.authorization_id
), superadmin as (select exists(select 1 from roles where role_id='system:super_admin' and boundary_type='system') value),
allowed as (select r.*,exists(select 1 from superadmin where value) or exists(select 1 from roles er join policy_rules pr on pr.role_id=er.role_id join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active where pr.capability=r.action and (pr.resource='*' or pr.resource=r.resource) and er.boundary_type in ('system','all_projects','project') and (er.boundary_type<>'project' or er.project_id=r.project_id) and pa.boundary_type in ('system','all_projects','project') and (pa.boundary_type<>'project' or pa.project_id=r.project_id)) ok from requested r),
approvals as (select not exists(select 1 from staged_approval_requirements req where req.stage_id=$5 and (((req.requirement_json->>'expires_at') is not null and (req.requirement_json->>'expires_at')::timestamptz<=statement_timestamp()) or (select count(distinct d.principal_id)
 from staged_approval_decisions d
 join principals p on p.id=d.principal_id and p.active
 join auth_contexts dc on dc.id=d.decided_auth_context_id
 join auth_sessions ds on ds.id=dc.session_id and ds.revoked_at is null
 where d.requirement_id=req.id and d.decision='approve'
   and (req.requirement_json->'principal_types') ? p.type
   and ((req.requirement_json->>'allow_initiator')::boolean or d.principal_id<>$6::uuid)
   and (exists(select 1 from role_assignments ra where ds.authorization_id is null and ra.principal_id=d.principal_id and ra.active and ra.role_id=req.requirement_json->>'role'
         and (ra.boundary_type in ('system','all_projects') or ra.project_id=(req.requirement_json->'boundary'->>'project_id')::uuid))
     or exists(select 1 from agent_authorization_roles ar join agent_authorizations aa on aa.id=ar.authorization_id and aa.revoked_at is null and aa.superseded_at is null
         where ar.authorization_id=ds.authorization_id and ar.role_id=req.requirement_json->>'role'
         and (ar.boundary_type in ('system','all_projects') or ar.project_id=(req.requirement_json->'boundary'->>'project_id')::uuid)))) < (req.requirement_json->>'minimum')::int or exists(select 1 from staged_approval_decisions d where d.requirement_id=req.id and d.decision='reject'))) valid)
select statement_timestamp()::text cutoff,exists(select 1 from actor) actor_valid,coalesce((select bool_and(valid) from lineage),true) ancestry_valid,
 $2::uuid=$6::uuid or (select value from superadmin) or exists(select 1 from roles er join policy_rules pr on pr.role_id=er.role_id join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active where pr.capability='changeset.commit_others' and (pr.resource='*' or pr.resource='system:changeset')) commit_other,
 coalesce((select bool_and(ok) from allowed),false) operations_allowed,(select valid from approvals) approvals_valid`,
    [
      auth.sessionId,
      auth.principalId,
      auth.humanUserId,
      auth.authorizationId ?? null,
      stageId,
      stage.created_principal_id,
    ],
  )).rows[0];
  if (!row?.actor_valid) {
    throw new CommitFailure("authorization_changed", "authorization");
  }
  if (!row.ancestry_valid) {
    throw new CommitFailure("authorization_ancestor_invalid", "authorization");
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
  produced: Map<string, string>,
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
    let targetVersion = produced.get(String(operation.object_id));
    if (!targetVersion) {
      targetVersion = (await query<{ current_object_version_id: string }>(
        tx,
        `select current_object_version_id from ${table} where project_id=$1 and id=$2`,
        [project, operation.object_id],
      )).rows[0]?.current_object_version_id;
    }
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
    return;
  }
  const objectId = String(operation.object_id ?? operation.relationship_id);
  let version = 1,
    previous: string | null = null,
    snapshot: Record<string, unknown>,
    changed: string[];
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
    await query(
      tx,
      `insert into ${table}(${
        [...baseColumns, ...columns].map(quoteIdentifier).join(",")
      }) values(${params.map((_, i) => `$${i + 1}`).join(",")})`,
      params,
    );
    snapshot = operation.op === "link"
      ? {
        from: operation.from,
        to: operation.to,
        fields: values,
        archived_at: null,
      }
      : { data: values, archived_at: null };
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
    version = Number(current.version) + 1;
    previous = String(current.current_object_version_id);
    const set = record(operation.set),
      unset = array(operation.unset).map(String),
      assignments: string[] = [
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
    if (operation.op === "transition") {
      const lifecycle = await lifecycleField(
        tx,
        evidence.pack_revision_id,
        identity(operation),
      );
      params.push(operation.to);
      assignments.push(`${quoteIdentifier(lifecycle)}=$${params.length}`);
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
        ...(operation.op === "transition"
          ? [
            await lifecycleField(
              tx,
              evidence.pack_revision_id,
              identity(operation),
            ),
          ]
          : []),
        ...(operation.op === "archive" || operation.op === "unlink"
          ? ["archived_at"]
          : []),
      ]),
    ].sort();
  }
  const versionId = uuidV7();
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
  produced.set(objectId, versionId);
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
    { changed_fields: changed },
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
  await query(
    tx,
    `insert into audit_events(id,stage_id,changeset_commit_id,auth_context_id,event_type,action,decision,policy_summary_json) values($1,$2,$3,$4,'changeset.committed','changeset.commit','committed',$5::jsonb)`,
    [uuidV7(), stageId, commitId, authId, { authorization_cutoff_at: cutoff }],
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
) {
  await query(
    tx,
    `insert into events(id,changeset_commit_id,project_id,object_version_id,schema_version,event_type,resource_identity,object_id,payload_json) values($1,$2,$3,$4,1,$5,$6,$7,$8::jsonb)`,
    [uuidV7(), commitId, project, version, type, resource, objectId, payload],
  );
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
) {
  await query(
    tx,
    `insert into audit_events(id,changeset_commit_id,object_version_id,auth_context_id,event_type,project_id,resource_identity,object_id,action,decision) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'committed')`,
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
    ],
  );
}
async function lifecycleField(
  tx: Queryable,
  revision: string,
  resource: string,
): Promise<string> {
  const row = (await query<{ normalized: unknown }>(
    tx,
    "select normalized from pack_candidate_revisions where id=$1",
    [revision],
  )).rows[0];
  const lifecycles = Object.values(record(record(row?.normalized).lifecycles))
    .map(record);
  const found = lifecycles.find((item) =>
    record(item.spec).resource === resource
  );
  if (!found) {
    throw new CommitFailure("stage_stale", "conflict", {
      reason: "pack_revision_changed",
    });
  }
  return String(record(found.spec).field);
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
async function jitter(attempt: number) {
  const max = Math.min(50, 5 * (attempt + 1));
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      crypto.getRandomValues(new Uint32Array(1))[0] % (max + 1),
    )
  );
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
