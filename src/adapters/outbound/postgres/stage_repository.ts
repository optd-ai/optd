import type {
  StageDto,
  StageRepository,
} from "../../../application/ports/stage_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { CanonicalOperation } from "../../../domain/changesets/operations.ts";
import { stageDigest } from "../../../domain/changesets/stage.ts";
import { canonicalJson } from "../../../domain/ids/canonical_json.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { PostgresAuthorizationRepository } from "./authorization_repository.ts";
import { query, type Queryable, quoteIdentifier, type Sql } from "./client.ts";
import { lockReadAuthority } from "./object_read_boundary.ts";

type Revision = {
  id: string;
  publisher: string;
  pack: string;
  contentDigest: string;
  normalized: Record<string, unknown>;
};
type Prepared = {
  projects: unknown[];
  revisions: Revision[];
  dependencies: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  operationRows: Array<
    { operationId: string; revisionId: string; operation: CanonicalOperation }
  >;
};

export class PostgresStageRepository implements StageRepository {
  constructor(private readonly sql: Sql) {}

  async create(
    input: { operations: CanonicalOperation[]; operationGraphDigest: string },
    auth: AuthContext,
  ): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        const prepared = await prepare(tx, input.operations, auth);
        const evidence = {
          operation_graph_digest: input.operationGraphDigest,
          projects: prepared.projects,
          pack_revisions: prepared.revisions.map(publicRevision),
          operations: input.operations,
          dependencies: prepared.dependencies,
          hook_executions: [],
          policy_decisions: prepared.decisions,
          approval_requirements: [],
          planned_events: [],
          planned_deliveries: [],
        };
        const digest = await stageDigest(evidence);
        const id = uuidV7();
        await query(
          tx,
          `insert into staged_changesets(
          id,schema_version,source_kind,source_identity_json,created_auth_context_id,creating_context_json,
          operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,
          planned_events_json,planned_deliveries_json) values($1,1,'direct',$2::jsonb,$3,$4::jsonb,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'[]','[]','[]') returning created_at`,
          [
            id,
            {},
            auth.id,
            {
              principal_id: auth.principalId,
              human_user_id: auth.humanUserId,
              session_id: auth.sessionId,
              authorization_id: auth.authorizationId ?? null,
            },
            input.operationGraphDigest,
            digest,
            {
              schema: "changeset.operations.v1",
              operations: input.operations,
            },
            prepared.projects,
            prepared.revisions.map(publicRevision),
          ],
        );
        for (
          let ordinal = 0;
          ordinal < prepared.operationRows.length;
          ordinal++
        ) {
          const row = prepared.operationRows[ordinal];
          await query(
            tx,
            `insert into staged_changeset_operations(stage_id,ordinal,operation_id,project_id,pack_revision_id,resource_revision_id,operation_kind,object_id,canonical_operation_json)
            values($1,$2,$3,$4,$5,$5,$6,$7,$8::jsonb)`,
            [
              id,
              ordinal,
              row.operationId,
              row.operation.project_id,
              row.revisionId,
              row.operation.op,
              operationObjectId(row.operation),
              row.operation,
            ],
          );
        }
        for (
          let ordinal = 0;
          ordinal < prepared.dependencies.length;
          ordinal++
        ) {
          const dep = prepared.dependencies[ordinal];
          await query(
            tx,
            `insert into staged_changeset_dependencies(stage_id,ordinal,dependency_kind,project_id,pack_revision_id,resource_revision_id,object_id,expected_version_id,dependency_json)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              id,
              ordinal,
              dep.kind,
              dep.project_id ?? null,
              dep.pack_revision_id ?? null,
              dep.resource_revision_id ?? null,
              dep.object_id ?? null,
              dep.expected_version_id ?? null,
              dep,
            ],
          );
        }
        for (let ordinal = 0; ordinal < prepared.decisions.length; ordinal++) {
          const decision = prepared.decisions[ordinal];
          await query(
            tx,
            `insert into staged_policy_decisions(id,stage_id,ordinal,project_id,action,resource_identity,decision_json) values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [
              uuidV7(),
              id,
              ordinal,
              decision.project_id,
              decision.action,
              decision.resource_identity,
              decision,
            ],
          );
        }
        await query(
          tx,
          "insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'ready',1)",
          [id],
        );
        return ok(await load(tx, id)!);
      }) as Result<StageDto>;
    } catch (error) {
      return mapError(error);
    }
  }

  async inspect(id: string, auth: AuthContext): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        if (!await canAccess(tx, id, auth, "changeset.inspect", false)) {
          return err(notFound());
        }
        const value = await load(tx, id);
        return value ? ok(value) : err(notFound());
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }

  async cancel(
    id: string,
    reason: string | null,
    auth: AuthContext,
  ): Promise<Result<StageDto>> {
    try {
      return await this.sql.begin(async (tx) => {
        if (!await canAccess(tx, id, auth, "changeset.cancel", true)) {
          return err(notFound());
        }
        const lifecycle = await query<{ status: string }>(
          tx,
          "select status from staged_changeset_lifecycle where stage_id=$1 for update",
          [id],
        );
        const status = lifecycle.rows[0]?.status;
        if (!status) return err(notFound());
        if (status === "cancelled") return ok((await load(tx, id))!);
        if (status === "committed") {
          return err({
            code: "already_committed",
            message: "changeset is already committed",
            severity: "conflict",
            details: {},
          });
        }
        if (status === "rejected") {
          return err({
            code: "already_rejected",
            message: "changeset is already rejected",
            severity: "conflict",
            details: {},
          });
        }
        await query(
          tx,
          `update staged_changeset_lifecycle set status='cancelled',version=version+1,cancelled_auth_context_id=$2,cancelled_at=now(),cancellation_reason=$3 where stage_id=$1`,
          [id, auth.id, reason],
        );
        return ok((await load(tx, id))!);
      }) as Result<StageDto>;
    } catch (error) {
      return mapAccessError(error);
    }
  }
}

async function prepare(
  sql: Queryable,
  operations: CanonicalOperation[],
  auth: AuthContext,
): Promise<Prepared> {
  const projectIds = [
    ...new Set(operations.map((operation) => operation.project_id)),
  ].sort();
  const projects: Record<string, unknown>[] = [];
  const dependencies: Record<string, unknown>[] = [];
  for (const projectId of projectIds) {
    const anchor = await lockReadAuthority(sql, auth, projectId);
    const project =
      (await query<{ id: string; version: string; status: string }>(
        sql,
        "select id,version,status from projects where id=$1 for share",
        [projectId],
      )).rows[0];
    if (!project) {
      throw domain("not_found", "Project was not found", "not_found");
    }
    if (project.status !== "active") {
      throw domain("project_inactive", "Project is inactive", "conflict");
    }
    const fact = {
      project_id: project.id,
      version: Number(project.version),
      status: project.status,
    };
    projects.push(fact);
    dependencies.push({
      kind: "project",
      ...fact,
      authorization_root_id: anchor.authorizationRootId,
    });
  }
  const identities = [...new Set(operations.map(componentIdentity))].sort();
  const revisions = new Map<string, Revision>();
  for (const identity of identities) {
    const parsed = parseIdentity(identity);
    const row =
      (await query<{ id: string; content_digest: string; normalized: unknown }>(
        sql,
        `select cr.id,cr.content_digest,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher=$1 and ar.pack_name=$2 for share of ar,cr`,
        [parsed.publisher, parsed.pack],
      )).rows[0];
    if (!row) {
      throw domain(
        "validation_failed",
        `No active revision defines ${identity}`,
        "validation",
      );
    }
    const revision = {
      id: row.id,
      publisher: parsed.publisher,
      pack: parsed.pack,
      contentDigest: row.content_digest,
      normalized: record(row.normalized),
    };
    revisions.set(`${parsed.publisher}/${parsed.pack}`, revision);
    const collection = operationDefinitionKind(
      operations.find((op) => componentIdentity(op) === identity)!,
    );
    if (!record(revision.normalized[collection])[parsed.name]) {
      throw domain(
        "validation_failed",
        `Active revision does not define ${identity}`,
        "validation",
      );
    }
  }
  const uniqueRevisions = [
    ...new Map(
      [...revisions.values()].map((revision) => [revision.id, revision]),
    ).values(),
  ].sort((a, b) =>
    `${a.publisher}/${a.pack}`.localeCompare(`${b.publisher}/${b.pack}`)
  );
  for (const revision of uniqueRevisions) {
    dependencies.push({
      kind: "pack_revision",
      pack_revision_id: revision.id,
      publisher: revision.publisher,
      pack: revision.pack,
      content_digest: revision.contentDigest,
    });
    if (
      hasStageHook(
        revision.normalized,
        operations.filter((operation) => {
          const parsed = parseIdentity(componentIdentity(operation));
          return parsed.publisher === revision.publisher &&
            parsed.pack === revision.pack;
        }),
      )
    ) {
      throw domain(
        "hook_coordinator_unavailable",
        "A required stage hook coordinator is unavailable",
        "unavailable",
      );
    }
  }
  const decisions: Record<string, unknown>[] = [];
  const operationRows: Prepared["operationRows"] = [];
  const creates = new Map(
    operations.filter((op) => op.op === "create").map((
      op,
    ) => [String(op.object_id), String(op.resource)]),
  );
  for (const operation of operations) {
    const identity = componentIdentity(operation),
      parsed = parseIdentity(identity);
    const revision = revisions.get(`${parsed.publisher}/${parsed.pack}`)!;
    validateDeclaredFields(
      operation,
      record(
        record(
          revision.normalized[operationDefinitionKind(operation)],
        )[parsed.name],
      ),
    );
    const action = operation.op;
    const authorization = await new PostgresAuthorizationRepository(sql as Sql)
      .authorize({
        auth,
        boundary: { type: "project", projectId: operation.project_id },
        action,
        resource: identity,
      });
    if (!authorization.ok) {
      throw domain(
        authorization.error.code,
        authorization.error.message,
        authorization.error.severity,
      );
    }
    const matchingCapabilities = authorization.value.capabilities.filter((
      capability,
    ) =>
      capability.action === action &&
      (capability.resource === "*" || capability.resource === identity)
    );
    if (
      !authorization.value.superAdmin &&
      !matchingCapabilities.some((capability) =>
        capability.condition === "unconditional"
      )
    ) {
      throw domain(
        "policy_denied",
        "Conditional policy did not produce a proven stage-time allow decision",
        "authorization",
      );
    }
    decisions.push({
      project_id: operation.project_id,
      action,
      resource_identity: identity,
      decision: "allow",
      authority_digest: authorization.value.digest,
      superadmin_bypass: authorization.value.superAdmin,
      operation_key: operation.key,
    });
    dependencies.push({
      kind: "policy",
      project_id: operation.project_id,
      authority_digest: authorization.value.digest,
      action,
      resource_identity: identity,
      capabilities: matchingCapabilities,
    });
    dependencies.push({
      kind: "assignment",
      project_id: operation.project_id,
      effective_roles: [...authorization.value.effectiveRoles].sort(),
      superadmin: authorization.value.superAdmin,
    });
    dependencies.push({
      kind: "resource",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: revision.id,
      identity,
    });
    await validateCurrent(
      sql,
      operation,
      parsed,
      revision,
      dependencies,
      creates,
    );
    operationRows.push({
      operationId: uuidV7(),
      revisionId: revision.id,
      operation,
    });
  }
  dependencies.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return {
    projects,
    revisions: uniqueRevisions,
    dependencies,
    decisions,
    operationRows,
  };
}

async function validateCurrent(
  sql: Queryable,
  operation: CanonicalOperation,
  parsed: ReturnType<typeof parseIdentity>,
  revision: Revision,
  dependencies: Record<string, unknown>[],
  creates: Map<string, string>,
): Promise<void> {
  if (operation.op === "create" || operation.op === "link") {
    if (operation.op === "link") {
      const relationship = record(
        record(revision.normalized.relationships)[parsed.name],
      );
      const spec = record(relationship.spec);
      const endpointFacts = [
        [String(operation.from), String(record(spec.from).resource), "from"],
        [String(operation.to), String(record(spec.to).resource), "to"],
      ] as const;
      for (const [endpoint, expectedResource, side] of endpointFacts) {
        if (creates.has(endpoint)) {
          if (creates.get(endpoint) !== expectedResource) {
            throw domain(
              "validation_failed",
              "Generated relationship endpoint does not satisfy its definition",
              "validation",
            );
          }
          continue;
        }
        if (expectedResource === "system:principal") {
          const principal = (await query<{ id: string }>(
            sql,
            "select id from principals where id=$1 and active for share",
            [endpoint],
          )).rows[0];
          if (!principal) {
            throw domain(
              "validation_failed",
              "Relationship principal endpoint is not active",
              "validation",
            );
          }
        } else {
          const row = (await query<
            {
              id: string;
              resource_identity: string;
              expected_version_id: string;
            }
          >(
            sql,
            "select object_id id,resource_identity,id expected_version_id from object_versions where project_id=$1 and object_id=$2 order by version desc limit 1 for share",
            [operation.project_id, endpoint],
          )).rows[0];
          if (!row || row.resource_identity !== expectedResource) {
            throw domain(
              "validation_failed",
              "Relationship endpoint does not satisfy its definition",
              "validation",
            );
          }
          dependencies.push({
            kind: "relationship",
            project_id: operation.project_id,
            pack_revision_id: revision.id,
            object_id: endpoint,
            expected_version_id: row.expected_version_id,
            endpoint: side,
            resource_identity: row.resource_identity,
          });
        }
      }
    }
    return;
  }
  const kind = operation.op === "unlink" ? "relationship" : "resource";
  const name = parsed.name;
  const runtime = (await query<{ table_name: string }>(
    sql,
    "select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind=$3 and definition_name=$4",
    [parsed.publisher, parsed.pack, kind, name],
  )).rows[0];
  if (!runtime) {
    throw domain(
      "validation_failed",
      "Runtime definition is unavailable",
      "validation",
    );
  }
  const objectId = String(
    operation.op === "unlink" ? operation.relationship_id : operation.object_id,
  );
  if (creates.has(objectId)) {
    dependencies.push({
      kind: "object_version",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: revision.id,
      object_id: objectId,
      expected_version_id: null,
      created_in_graph: true,
    });
    return;
  }
  const lifecycle = operation.op === "transition"
    ? Object.values(record(revision.normalized.lifecycles)).map(record).find(
      (candidate) =>
        record(candidate.spec).resource === componentIdentity(operation),
    )
    : undefined;
  const lifecycleField = lifecycle
    ? String(record(lifecycle.spec).field)
    : null;
  const row = (await query<
    {
      version: number;
      current_object_version_id: string;
      archived_at: unknown;
      lifecycle_value: unknown;
      snapshot: unknown;
    }
  >(
    sql,
    `select version,current_object_version_id,archived_at,to_jsonb(current_row) snapshot${
      lifecycleField
        ? `,${quoteIdentifier(lifecycleField)} lifecycle_value`
        : ",null lifecycle_value"
    } from ${
      quoteIdentifier(runtime.table_name)
    } current_row where project_id=$1 and id=$2 for share`,
    [operation.project_id, objectId],
  )).rows[0];
  if (!row || row.archived_at) {
    throw domain("not_found", "Current object was not found", "not_found");
  }
  if (operation.op === "transition") {
    if (!lifecycle) {
      throw domain(
        "validation_failed",
        "Resource has no active lifecycle",
        "validation",
      );
    }
    const spec = record(lifecycle.spec);
    const target = String(operation.to);
    const states = Array.isArray(spec.states)
      ? spec.states.map((state) => String(record(state).name))
      : [];
    const edge = Array.isArray(spec.transitions)
      ? spec.transitions.map(record).find((transition) =>
        transition.to === target && Array.isArray(transition.from) &&
        transition.from.includes(String(row.lifecycle_value))
      )
      : undefined;
    if (!states.includes(target) || !edge) {
      throw domain(
        "operation_conflict",
        "Lifecycle transition is not allowed",
        "conflict",
      );
    }
    const proposed = { ...record(row.snapshot), ...record(operation.set) };
    for (const field of (operation.unset as string[] | undefined) ?? []) {
      delete proposed[field];
    }
    proposed[lifecycleField!] = target;
    for (const [field, value] of Object.entries(record(edge.set))) {
      if (
        Object.hasOwn(record(operation.set), field) &&
        canonicalJson(record(operation.set)[field]) !== canonicalJson(value)
      ) {
        throw domain(
          "operation_conflict",
          "Lifecycle constant conflicts with authored mutation",
          "conflict",
        );
      }
      proposed[field] = value;
    }
    for (const field of (edge.unset as string[] | undefined) ?? []) {
      if (Object.hasOwn(record(operation.set), field)) {
        throw domain(
          "operation_conflict",
          "Lifecycle unset conflicts with authored mutation",
          "conflict",
        );
      }
      delete proposed[field];
    }
    const state = (spec.states as unknown[]).map(record).find((candidate) =>
      candidate.name === target
    );
    for (
      const required of (state?.required_fields as string[] | undefined) ?? []
    ) {
      if (proposed[required] === undefined || proposed[required] === null) {
        throw domain(
          "validation_failed",
          `Lifecycle state requires field '${required}'`,
          "validation",
        );
      }
    }
    dependencies.push({
      kind: "lifecycle",
      project_id: operation.project_id,
      pack_revision_id: revision.id,
      resource_revision_id: revision.id,
      identity: String(lifecycle.identity ?? "lifecycle"),
      from: row.lifecycle_value,
      to: target,
    });
  }
  if (operation.op === "update") {
    const current = record(row.snapshot);
    const set = record(operation.set);
    const unset = (operation.unset as string[] | undefined) ?? [];
    const changed = Object.entries(set).some(([field, value]) =>
      canonicalJson(current[field]) !== canonicalJson(value)
    ) || unset.some((field) =>
      current[field] !== null && current[field] !== undefined
    );
    if (!changed) {
      throw domain(
        "no_changes",
        "Update does not change current state",
        "validation",
      );
    }
  }
  if (
    operation.expected_version !== undefined &&
    Number(operation.expected_version) !== Number(row.version)
  ) {
    throw domain(
      "object_version_conflict",
      "Expected object version is not current",
      "conflict",
    );
  }
  dependencies.push({
    kind: operation.op === "unlink" ? "relationship" : "object_version",
    project_id: operation.project_id,
    pack_revision_id: revision.id,
    resource_revision_id: revision.id,
    object_id: objectId,
    expected_version_id: row.current_object_version_id,
    version: Number(row.version),
  });
}

async function canAccess(
  sql: Queryable,
  stageId: string,
  auth: AuthContext,
  action: string,
  lock: boolean,
): Promise<boolean> {
  const root = (await query<{ created_auth_context_id: string }>(
    sql,
    `select created_auth_context_id from staged_changesets where id=$1 ${
      lock ? "for share" : ""
    }`,
    [stageId],
  )).rows[0];
  if (!root) return false;
  const projects = (await query<{ project_id: string }>(
    sql,
    "select distinct project_id from staged_changeset_operations where stage_id=$1 order by project_id",
    [stageId],
  )).rows.map((row) => row.project_id);
  for (const projectId of projects) {
    await lockReadAuthority(sql, auth, projectId);
  }
  if (root.created_auth_context_id === auth.id) return true;
  for (const projectId of projects) {
    const allowed = await new PostgresAuthorizationRepository(sql as Sql)
      .authorize({
        auth,
        boundary: { type: "project", projectId },
        action,
        resource: "changeset",
      });
    if (!allowed.ok) return false;
  }
  return true;
}

async function load(sql: Queryable, id: string): Promise<StageDto | null> {
  const row = (await query<Record<string, unknown>>(
    sql,
    `select s.*,l.status,l.version lifecycle_version,l.cancelled_auth_context_id,l.cancelled_at,l.cancellation_reason,l.committed_at from staged_changesets s join staged_changeset_lifecycle l on l.stage_id=s.id where s.id=$1`,
    [id],
  )).rows[0];
  if (!row) return null;
  const operations = (await query<{ canonical_operation_json: unknown }>(
    sql,
    "select canonical_operation_json from staged_changeset_operations where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) =>
    record(item.canonical_operation_json) as CanonicalOperation
  );
  const dependencies = (await query<{ dependency_json: unknown }>(
    sql,
    "select dependency_json from staged_changeset_dependencies where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.dependency_json));
  const policies = (await query<{ decision_json: unknown }>(
    sql,
    "select decision_json from staged_policy_decisions where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.decision_json));
  const approvals = (await query<{ requirement_json: unknown }>(
    sql,
    "select requirement_json from staged_approval_requirements where stage_id=$1 order by ordinal",
    [id],
  )).rows.map((item) => record(item.requirement_json));
  const decisions = (await query<Record<string, unknown>>(
    sql,
    "select id,requirement_id,principal_id,decision,reason,decided_auth_context_id,decided_at from staged_approval_decisions where stage_id=$1 order by decided_at,id",
    [id],
  )).rows;
  const commit = (await query<Record<string, unknown>>(
    sql,
    "select id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest,committed_at from changeset_commits where stage_id=$1",
    [id],
  )).rows[0] ?? null;
  const cancelledAt = timestamp(row.cancelled_at);
  return {
    id: String(row.id),
    schema_version: 1,
    source: { kind: "direct", identity: {} },
    status: String(row.status) as StageDto["status"],
    lifecycle_version: Number(row.lifecycle_version),
    created_at: timestamp(row.created_at)!,
    created_auth_context_id: String(row.created_auth_context_id),
    operation_graph_digest: String(row.operation_graph_digest),
    stage_digest: String(row.stage_digest),
    projects: array(row.projects_json),
    pack_revisions: array(row.pack_revisions_json),
    operations,
    dependencies,
    hook_executions: [],
    policy_decisions: policies,
    warnings: array(row.warnings_json),
    approval_requirements: approvals,
    approval_decisions: decisions,
    planned_events: array(row.planned_events_json),
    planned_deliveries: array(row.planned_deliveries_json),
    commit,
    cancellation: cancelledAt
      ? {
        auth_context_id: String(row.cancelled_auth_context_id),
        at: cancelledAt,
        reason: row.cancellation_reason === null
          ? null
          : String(row.cancellation_reason),
      }
      : null,
  };
}

function hasStageHook(
  normalized: Record<string, unknown>,
  operations: CanonicalOperation[],
): boolean {
  const resources = new Set(operations.map(componentIdentity));
  return Object.values(record(normalized.hooks)).some((hook) => {
    const attachments = record(record(hook).spec).attachments;
    return Array.isArray(attachments) && attachments.some((attachment) => {
      const phase = record(attachment).phase;
      const stagePhase = phase === "changeset.before_stage" ||
        phase === "changeset.validate";
      const resource = record(attachment).resource;
      return stagePhase &&
        (resource === undefined || resources.has(String(resource)));
    });
  });
}
function validateDeclaredFields(
  operation: CanonicalOperation,
  definition: Record<string, unknown>,
): void {
  const fields = record(record(definition.spec).fields);
  for (const map of [operation.fields, operation.set]) {
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [key, value] of Object.entries(map)) {
        if (!Object.hasOwn(fields, key)) {
          throw domain(
            "validation_failed",
            `Field '${key}' is not declared`,
            "validation",
          );
        }
        const field = record(fields[key]);
        const valid = value === null
          ? field.nullable === true
          : field.type === "string" || field.type === "timestamp"
          ? typeof value === "string"
          : field.type === "integer"
          ? Number.isSafeInteger(value)
          : field.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : field.type === "boolean"
          ? typeof value === "boolean"
          : true;
        if (!valid) {
          throw domain(
            "validation_failed",
            `Field '${key}' has the wrong type`,
            "validation",
          );
        }
      }
    }
  }
  for (const key of (operation.unset as string[] | undefined) ?? []) {
    if (!Object.hasOwn(fields, key)) {
      throw domain(
        "validation_failed",
        `Field '${key}' is not declared`,
        "validation",
      );
    }
  }
  if (operation.op === "create") {
    for (const [key, value] of Object.entries(fields)) {
      if (
        record(value).required === true &&
        !Object.hasOwn(record(operation.fields), key)
      ) {
        throw domain(
          "validation_failed",
          `Required field '${key}' is missing`,
          "validation",
        );
      }
    }
  }
}
function componentIdentity(operation: CanonicalOperation): string {
  return String(operation.relationship ?? operation.resource);
}
function operationDefinitionKind(
  operation: CanonicalOperation,
): "resources" | "relationships" {
  return operation.relationship ? "relationships" : "resources";
}
function operationObjectId(operation: CanonicalOperation): string | null {
  return operation.op === "link" || operation.op === "unlink"
    ? String(operation.relationship_id)
    : operation.object_id
    ? String(operation.object_id)
    : null;
}
function parseIdentity(identity: string) {
  const match = /^([^/]+)\/([^:]+):(.+)$/.exec(identity);
  if (!match) {
    throw domain(
      "validation_failed",
      "Component identity is invalid",
      "validation",
    );
  }
  return { publisher: match[1], pack: match[2], name: match[3] };
}
function publicRevision(revision: Revision) {
  return {
    publisher: revision.publisher,
    pack: revision.pack,
    revision_id: revision.id,
    content_digest: revision.contentDigest,
  };
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function array(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}
function timestamp(value: unknown): string | null {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
    ? new Date(value).toISOString()
    : null;
}
function domain(code: string, message: string, severity: string): Error {
  return Object.assign(new Error(message), { code, severity });
}
function mapError(error: unknown): Result<never> {
  const item = error as { code?: string; severity?: string; message?: string };
  if (
    item.code &&
    [
      "validation",
      "authentication",
      "authorization",
      "not_found",
      "conflict",
      "unavailable",
    ].includes(item.severity ?? "")
  ) {
    return err({
      code: item.code,
      message: item.message ?? item.code,
      severity: (item.severity ?? "validation") as never,
      details: {},
    });
  }
  console.error(error);
  return err({
    code: "internal_error",
    message: "unexpected server error",
    severity: "internal",
    details: {},
  });
}
function mapAccessError(error: unknown): Result<never> {
  const item = error as { code?: string };
  if (item.code === "OBJECT_READ_AUTHORITY_INVALID") return err(notFound());
  return mapError(error);
}
function notFound() {
  return {
    code: "not_found",
    message: "changeset was not found",
    severity: "not_found" as const,
    details: {},
  };
}
