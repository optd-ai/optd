import type { AuthContext } from "../../../domain/auth/model.ts";
import { policyActorFromAuthContext } from "../../../domain/auth/policy_actor.ts";
import {
  ExpressionError,
  type FieldSpec,
  lowerExpression,
} from "../../../domain/expressions/cel.ts";
import { canonicalJson } from "../../../domain/ids/canonical_json.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import {
  type QueryRequest,
  type ResolvedSort,
} from "../../../schemas/queries/query.ts";
import { query, type Queryable, quoteIdentifier, type Sql } from "./client.ts";
import { lockReadAuthority } from "./object_read_boundary.ts";
import { ObjectReadAuthorityInvalidError } from "../../../application/ports/object_reader.ts";
import type { DefinitionIdentity } from "../../../domain/objects/read.ts";
import type {
  ReviewedTarget,
  TargetAuthorityEvidence,
} from "../../../application/ports/repair/targeted_action.ts";
import {
  type QueryDefinition,
  type QueryExecutionPlan,
  QueryPhysicalError,
  type QueryPhysicalPage,
  type QueryReadSessionPort,
} from "../../../application/services/query_objects.ts";

export type QueryObjectsRequest = QueryRequest;
type Definition = QueryDefinition & {
  revisionId: string;
  table: string;
  document: Record<string, unknown>;
  fields: Record<string, FieldSpec>;
  packFields: string[];
  identity: string;
};
type PolicyRow = {
  id: string;
  rule_name: string | null;
  role_id: string;
  capability: string;
  resource: string;
  condition_kind: "unconditional" | "abac" | "rebac";
  predicate: string | null;
  relation_relationship: string | null;
  relation_object_side: "from" | "to" | null;
  relation_subject_side: "from" | "to" | null;
  relation_subject: "actor.id" | "actor.human_user_id" | null;
  evaluation_order: number;
  policy_id: string;
  policy_version_id: string;
  policy_version: number;
  policy_version_active: boolean;
  policy_candidate_revision_id: string | null;
  policy_definition_name: string | null;
  policy_candidate_active: boolean;
  assignment_id: string;
  assignment_version: number;
  assignment_boundary_type: "system" | "all_projects" | "project";
  assignment_project_id: string | null;
  assignment_active: boolean;
};
type EffectiveRole = {
  assignment_id: string;
  assignment_owner_id: string;
  assignment_active: boolean;
  assignment_version: number | null;
  role_id: string;
  system_role_active: boolean;
  version_id: string;
  version: number;
  role_version_active: boolean;
  role_candidate_revision_id: string | null;
  role_definition_name: string | null;
  boundary_type: "system" | "all_projects" | "project";
  project_id: string | null;
};

export type ExactTargetAuthorityEvaluation = Readonly<{
  allowed: boolean;
  targets: readonly TargetAuthorityEvidence[];
  /** Exact normalized facts used to persist first-class dependencies. */
  dependencies: readonly Readonly<Record<string, unknown>>[];
}>;
type PolicyAuthorization = {
  predicates: Record<string, string>;
  rules: Record<string, PolicyRow[]>;
  superAdmin: boolean;
  digest: string;
};

export type ObjectPolicyEvaluation = Readonly<{
  allowed: boolean;
  policyDigest: string;
}>;

export type TargetedActionPolicyTarget = Readonly<{
  definition: DefinitionIdentity;
  objectId?: string;
}>;

type QueryFailure = QueryPhysicalError;
const QueryFailure = QueryPhysicalError;
class ApplicationQueryCallbackError extends Error {
  constructor(readonly applicationError: unknown) {
    super("application query callback failed");
  }
}

export function makePostgresQueryObjectRepository(
  deps: { sql: Sql },
): QueryReadSessionPort {
  return Object.freeze({
    async execute<T>(
      call: Readonly<{ input: QueryRequest; auth: AuthContext }>,
      work: Parameters<QueryReadSessionPort["execute"]>[1],
    ): Promise<T> {
      try {
        return await deps.sql.begin(async (tx) => {
          await lockReadAuthority(tx, call.auth, call.input.project_id);
          const project = await query(
            tx,
            "select id from projects where id=$1 for share",
            [call.input.project_id],
          );
          const projectExists = project.rows.length > 0;
          let definition: Definition | null | undefined;
          let prepared: PreparedQuery | undefined;
          try {
            return await work(Object.freeze({
              projectExists,
              async definition(): Promise<QueryDefinition | null> {
                if (!projectExists) return null;
                definition ??= await resolveDefinition(tx, call.input);
                if (!definition) return null;
                const { table: _table, ...publicDefinition } = definition;
                return publicDefinition;
              },
              async authorize(
                _plan: Omit<QueryExecutionPlan, "cursorPosition">,
              ) {
                definition ??= await resolveDefinition(tx, call.input);
                if (!definition) throw new QueryPhysicalError("invalid_data");
                prepared ??= await prepareQuery(
                  tx,
                  call.input,
                  call.auth,
                  definition,
                );
                return {
                  policyDigest: prepared.policy.digest,
                  normalizedWhere: prepared.user.normalized,
                  visible: prepared.policy.superAdmin ||
                    (prepared.policy.rules.read?.length ?? 0) > 0,
                  archivedVisible: prepared.policy.superAdmin ||
                    (prepared.policy.rules.read_archived?.length ?? 0) > 0,
                };
              },
              page: Object.freeze({
                async query(
                  plan: QueryExecutionPlan,
                ): Promise<QueryPhysicalPage> {
                  definition ??= await resolveDefinition(tx, call.input);
                  if (!definition) throw new QueryPhysicalError("invalid_data");
                  prepared ??= await prepareQuery(
                    tx,
                    call.input,
                    call.auth,
                    definition,
                  );
                  return await executePage(
                    tx,
                    call.input,
                    definition,
                    [...plan.sort],
                    plan.cursorPosition,
                    prepared,
                  );
                },
              }),
            })) as T;
          } catch (error) {
            throw new ApplicationQueryCallbackError(error);
          }
        }) as T;
      } catch (error) {
        if (error instanceof ApplicationQueryCallbackError) {
          throw error.applicationError;
        }
        if (error instanceof QueryPhysicalError) throw error;
        if (error instanceof ExpressionError) {
          throw new QueryPhysicalError("invalid_expression", {
            issues: [{
              path: "/where",
              code: error.code,
              message: error.message,
              ...error.details,
            }],
          });
        }
        if (error instanceof ObjectReadAuthorityInvalidError) {
          throw new QueryPhysicalError("authority_invalid");
        }
        throw new QueryPhysicalError("unexpected");
      }
    },
  });
}

type PreparedQuery = Readonly<{
  params: unknown[];
  user: ReturnType<typeof lowerExpression>;
  policy: PolicyAuthorization;
}>;

async function prepareQuery(
  sql: Queryable,
  request: QueryRequest,
  auth: AuthContext,
  definition: Definition,
): Promise<PreparedQuery> {
  const params: unknown[] = [request.project_id];
  const user = lowerExpression(request.where ?? "true", {
    fields: definition.fields,
    alias: "q",
    parameterOffset: params.length,
  });
  params.push(...user.params);
  const policy = await resolvePolicyAuthorization(
    sql,
    request.project_id,
    definition,
    auth,
    request.include_archived ? ["read", "read_archived"] : ["read"],
    params,
  );
  return { params, user, policy };
}

async function executePage(
  sql: Queryable,
  request: QueryRequest,
  definition: Definition,
  sort: ResolvedSort[],
  position: Readonly<{ values: unknown[]; id: string }> | null,
  prepared: PreparedQuery,
): Promise<QueryPhysicalPage> {
  const params = [...prepared.params];
  const { user, policy } = prepared;
  const readPredicate = policy.predicates.read;
  const archivePredicate = request.include_archived
    ? policy.predicates.read_archived
    : `q."archived_at" is null`;
  const keyset = position
    ? keysetSql(
      sort,
      position.values,
      params,
      request.definition.kind,
      definition.fields,
    )
    : "true";
  const order = sort.map((item) =>
    `q.${qi(column(item.field, request.definition.kind))} ${item.direction} ${
      item.direction === "asc" ? "nulls last" : "nulls first"
    }`
  ).join(",");
  params.push((request.limit ?? 50) + 1);
  const overrides = Object.entries(definition.fields).filter(([, spec]) =>
    spec.type === "decimal" || spec.type === "integer" ||
    spec.type === "timestamp"
  ).flatMap(([field, spec]) => [
    `'${column(field, request.definition.kind)}'`,
    spec.type === "timestamp"
      ? `to_char(page.${
        qi(column(field, request.definition.kind))
      } at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : `page.${qi(column(field, request.definition.kind))}::text`,
  ]).join(",");
  const rowJson = overrides
    ? `to_jsonb(page) || jsonb_build_object(${overrides})`
    : "to_jsonb(page)";
  const statement = `with eligible as materialized (
    select q.* from ${
    qi(definition.table)
  } q where q.project_id=$1 and (${user.sql}) and (${archivePredicate}) and (${readPredicate})
  ), tally as (select count(*)::bigint total from eligible), page as (
    select q.* from eligible q where ${keyset} order by ${order} limit $${params.length}
  ) select ${rowJson} row_data,tally.total::text total from tally left join page on true order by ${
    order.replaceAll("q.", "page.")
  }`;
  const result = await query<
    { row_data: Record<string, unknown> | string | null; total: string }
  >(sql, statement, params);
  const rows = result.rows.map((r) => record(r.row_data)).filter((r) =>
    Object.keys(r).length
  );
  const limit = request.limit ?? 50;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = hasMore ? page[page.length - 1] : null;
  return {
    rows: page,
    nextPosition: last
      ? {
        values: sort.map((item) =>
          typedValue(
            last,
            column(item.field, request.definition.kind),
            definition.fields[item.field],
          )
        ),
        id: String(last.id),
      }
      : null,
    hasMore,
    total: request.include_total ? Number(result.rows[0]?.total ?? 0) : null,
  };
}

async function resolveDefinition(
  sql: Queryable,
  request: QueryRequest,
): Promise<Definition | null> {
  const section = request.definition.kind === "resource"
    ? "resources"
    : "relationships";
  const found = await query<
    { revision_id: string; table_name: string; document: unknown }
  >(
    sql,
    `select ar.candidate_revision_id revision_id,rt.table_name,jsonb_extract_path(cr.normalized,$4::text,$5::text) document
    from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
    join pack_runtime_tables rt on rt.publisher=ar.publisher and rt.pack_name=ar.pack_name and rt.definition_kind=$3 and rt.definition_name=$5
    where ar.publisher=$1 and ar.pack_name=$2 for share of ar,cr,rt`,
    [
      request.definition.publisher,
      request.definition.pack,
      request.definition.kind,
      section,
      request.definition.name,
    ],
  );
  const row = found.rows[0];
  if (!row || !row.document) return null;
  const document = record(row.document),
    spec = record(document.spec),
    descriptors = record(spec.fields);
  const fields: Record<string, FieldSpec> = {
    id: { type: "string", format: "uuid" },
    created_at: { type: "timestamp" },
    updated_at: { type: "timestamp" },
    archived_at: { type: "timestamp", nullable: true },
  };
  if (request.definition.kind === "relationship") {
    fields.from = {
      type: "string",
      column: "from_object_id",
      format: "uuid",
    };
    fields.to = {
      type: "string",
      column: "to_object_id",
      format: "uuid",
    };
  }
  for (const [name, d] of Object.entries(descriptors)) {
    const desc = record(d);
    fields[name] = {
      type: fieldType(desc.type),
      nullable: desc.required !== true,
      ...(desc.ref ? { format: "uuid" as const } : {}),
    };
  }
  return {
    revisionId: row.revision_id,
    table: row.table_name,
    document,
    fields,
    packFields: Object.keys(descriptors).sort(),
    identity:
      `${request.definition.publisher}/${request.definition.pack}:${request.definition.name}`,
  };
}
export async function evaluateObjectPolicy(
  sql: Queryable,
  input: {
    projectId: string;
    objectId: string;
    definition: DefinitionIdentity;
    actions: string[];
  },
  auth: AuthContext,
): Promise<ObjectPolicyEvaluation> {
  const request = {
    project_id: input.projectId,
    definition: input.definition,
  } as QueryRequest;
  const definition = await resolveDefinition(sql, request);
  if (!definition) return { allowed: false, policyDigest: await digest(null) };
  try {
    const params: unknown[] = [input.projectId, input.objectId];
    const policy = await resolvePolicyAuthorization(
      sql,
      input.projectId,
      definition,
      auth,
      input.actions,
      params,
    );
    const predicates = input.actions.map((action) =>
      `(${policy.predicates[action] ?? "false"})`
    );
    const result = await query<{ allowed: boolean }>(
      sql,
      `select exists(select 1 from ${qi(definition.table)} q
        where q.project_id=$1 and q.id=$2 and ${
        predicates.join(" and ")
      }) allowed`,
      params,
    );
    return {
      allowed: result.rows[0]?.allowed === true,
      policyDigest: policy.digest,
    };
  } catch (error) {
    if (error instanceof QueryFailure || error instanceof ExpressionError) {
      return { allowed: false, policyDigest: await digest(null) };
    }
    throw error;
  }
}

export async function targetedActionAuthorityFactsDigest(
  sql: Queryable,
  projectId: string,
  targets: readonly TargetedActionPolicyTarget[],
  auth: AuthContext,
): Promise<string> {
  const assignmentTable = auth.authorizationId
    ? "agent_authorization_roles"
    : "role_assignments";
  const assignmentColumn = auth.authorizationId
    ? "authorization_id"
    : "principal_id";
  const assignments = (await query<Record<string, unknown>>(
    sql,
    `select to_jsonb(a) fact from ${qi(assignmentTable)} a where ${
      qi(assignmentColumn)
    }=$1 and (boundary_type='all_projects' or
      (boundary_type='project' and project_id=$2) or
      (role_id='system:super_admin' and boundary_type='system')) order by id`,
    [auth.authorizationId ?? auth.principalId, projectId],
  )).rows.map((row) => row.fact);
  const roles = (await query<Record<string, unknown>>(
    sql,
    `select to_jsonb(sr) role,to_jsonb(rv) role_version
       from system_roles sr join role_definition_versions rv on rv.role_id=sr.id
      where sr.id in (select role_id from ${qi(assignmentTable)} where ${
      qi(assignmentColumn)
    }=$1) order by sr.id,rv.id`,
    [auth.authorizationId ?? auth.principalId],
  )).rows;
  const policies = (await query<Record<string, unknown>>(
    sql,
    `select to_jsonb(pa) assignment,to_jsonb(pd) policy_version,to_jsonb(pr) rule
       from policy_assignments pa
       join policy_definition_versions pd on pd.id=pa.policy_definition_version_id
       join policy_rules pr on pr.policy_definition_version_id=pd.id
      where pa.boundary_type='all_projects' or
        (pa.boundary_type='project' and pa.project_id=$1)
      order by pa.id,pd.id,pr.id`,
    [projectId],
  )).rows;
  const relationships: unknown[] = [];
  const packs = [
    ...new Set(
      targets.map((target) =>
        `${target.definition.publisher}/${target.definition.pack}`
      ),
    ),
  ].sort();
  for (const identity of packs) {
    const [publisher, pack] = identity.split("/");
    const tables = (await query<{ table_name: string }>(
      sql,
      `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='relationship' order by table_name`,
      [publisher, pack],
    )).rows;
    for (const row of tables) {
      const facts = (await query<Record<string, unknown>>(
        sql,
        `select to_jsonb(r) fact from ${
          qi(row.table_name)
        } r where project_id=$1 order by id`,
        [projectId],
      )).rows.map((fact) => fact.fact);
      relationships.push({ table: row.table_name, facts });
    }
  }
  return await digest({ assignments, roles, policies, relationships });
}

export async function lockTargetedActionAuthority(
  sql: Queryable,
  targets: readonly TargetedActionPolicyTarget[],
): Promise<void> {
  // Stabilize only metadata needed to resolve reviewed target runtimes. Exact
  // authority rows are locked after evaluation by dependency identity.
  for (
    const target of [...targets].sort((left, right) =>
      targetKey(left).localeCompare(targetKey(right))
    )
  ) {
    await query(
      sql,
      `select table_name from pack_runtime_tables
        where publisher=$1 and pack_name=$2 and definition_kind='resource'
          and definition_name=$3 for share`,
      [
        target.definition.publisher,
        target.definition.pack,
        target.definition.name,
      ],
    );
  }
}

export async function lockExactTargetAuthorityDependencies(
  sql: Queryable,
  dependencies: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  const locks: Array<{ table: string; id: string }> = [];
  const relationships = dependencies.filter((dependency) =>
    dependency.target_dependency === "relationship"
  ).sort((left, right) =>
    String(left.resource_identity).localeCompare(
      String(right.resource_identity),
    ) ||
    String(left.object_id).localeCompare(String(right.object_id))
  );
  for (const dependency of relationships) {
    const parsed = parseResource(String(dependency.resource_identity));
    if (!parsed) continue;
    const runtime = (await query<{ table_name: string }>(
      sql,
      `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2
        and definition_kind='relationship' and definition_name=$3 for share`,
      parsed,
    )).rows[0];
    if (runtime) {
      locks.push({
        table: runtime.table_name,
        id: String(dependency.object_id),
      });
    }
  }
  for (const dependency of dependencies) {
    if (dependency.target_dependency === "role_assignment") {
      locks.push({
        table: dependency.assignment_table === "agent_authorization_roles"
          ? "agent_authorization_roles"
          : "role_assignments",
        id: String(dependency.assignment_id),
      }, {
        table: "system_roles",
        id: String(dependency.system_role_id),
      }, {
        table: "role_definition_versions",
        id: String(dependency.role_version_id),
      });
    } else if (dependency.target_dependency === "policy_rule") {
      locks.push({
        table: "policy_assignments",
        id: String(dependency.policy_assignment_id),
      }, {
        table: "policy_definition_versions",
        id: String(dependency.policy_version_id),
      }, {
        table: "policy_rules",
        id: String(dependency.rule_id),
      });
    }
  }
  const ordered = [...new Map(
    locks.map((lock) => [`${lock.table}:${lock.id}`, lock]),
  ).values()].sort((left, right) =>
    left.table.localeCompare(right.table) || left.id.localeCompare(right.id)
  );
  for (const lock of ordered) {
    await query(
      sql,
      `select id from ${qi(lock.table)} where id=$1 for share`,
      [lock.id],
    );
  }
}

/**
 * Evaluates exact reviewed targets and returns only facts which participated in
 * an allow. Target order is preserved; set-like evidence is canonically sorted.
 */
export async function evaluateExactTargetedActionAuthority(
  sql: Queryable,
  input: {
    projectId: string;
    action: string;
    targets: readonly ReviewedTarget[];
  },
  auth: AuthContext,
): Promise<ExactTargetAuthorityEvaluation> {
  const evidence: TargetAuthorityEvidence[] = [];
  const dependencies: Record<string, unknown>[] = [];
  for (const reviewed of input.targets) {
    const parsed =
      /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
        .exec(reviewed.resource);
    if (!parsed || reviewed.projectId !== input.projectId) {
      return { allowed: false, targets: [], dependencies: [] };
    }
    const target: TargetedActionPolicyTarget = {
      definition: {
        kind: "resource",
        publisher: parsed[1],
        pack: parsed[2],
        name: parsed[3],
      },
      ...(reviewed.object ? { objectId: reviewed.object.id } : {}),
    };
    const definition = await resolveDefinition(sql, {
      project_id: input.projectId,
      definition: target.definition,
    } as QueryRequest);
    if (!definition) return { allowed: false, targets: [], dependencies: [] };
    const roles = await effectiveRoles(sql, auth, input.projectId);
    const superAdminRoles = roles.filter((role) =>
      role.role_id === "system:super_admin" && role.boundary_type === "system"
    );
    const rows = superAdminRoles.length ? [] : await policyRows(
      sql,
      roles.map((role) => role.role_id),
      input.projectId,
      reviewed.resource,
      input.action,
      true,
    );
    const matched: PolicyRow[] = [];
    const relationshipIds = new Set<string>();
    for (const rule of rows) {
      if (!reviewed.object && (rule.predicate || rule.relation_relationship)) {
        continue;
      }
      const params: unknown[] = reviewed.object
        ? [input.projectId, reviewed.object.id]
        : [input.projectId];
      const predicate = reviewed.object
        ? await compilePolicy(
          sql,
          [rule],
          definition,
          auth,
          input.projectId,
          params,
        )
        : "true";
      const allowed = reviewed.object
        ? (await query<{ allowed: boolean }>(
          sql,
          `select exists(select 1 from ${qi(definition.table)} q
             where q.project_id=$1 and q.id=$2 and q.archived_at is null
               and (${predicate})) allowed`,
          params,
        )).rows[0]?.allowed === true
        : true;
      if (!allowed) continue;
      matched.push(rule);
      if (rule.relation_relationship && reviewed.object) {
        for (
          const relationship of await directRelationshipEvidence(
            sql,
            rule,
            definition,
            auth,
            input.projectId,
            reviewed.object.id,
          )
        ) {
          relationshipIds.add(relationship.id);
          dependencies.push({
            kind: "relationship",
            target_dependency: "relationship",
            project_id: input.projectId,
            resource_identity: rule.relation_relationship,
            object_id: relationship.id,
            expected_version_id: relationship.current_object_version_id,
            relationship_project_id: relationship.project_id,
            from_object_id: relationship.from_object_id,
            to_object_id: relationship.to_object_id,
            archived_at: relationship.archived_at,
          });
        }
      }
    }
    if (!superAdminRoles.length && !matched.length) {
      return { allowed: false, targets: [], dependencies: [] };
    }
    const matchedRoleIds = new Set(
      (superAdminRoles.length
        ? superAdminRoles
        : roles.filter((role) =>
          matched.some((rule) => rule.role_id === role.role_id)
        )).map((role) => role.assignment_id),
    );
    const targetDependencies = [
      ...(reviewed.object
        ? [{
          kind: "object_version",
          target_dependency: "object_version",
          project_id: input.projectId,
          resource_identity: reviewed.resource,
          object_id: reviewed.object.id,
          expected_version_id: reviewed.object.versionId,
        }]
        : []),
      ...roles.filter((role) => matchedRoleIds.has(role.assignment_id)).map(
        (role) => ({
          kind: "assignment",
          target_dependency: "role_assignment",
          project_id: input.projectId,
          assignment_table: auth.authorizationId
            ? "agent_authorization_roles"
            : "role_assignments",
          assignment_id: role.assignment_id,
          assignment_owner_id: role.assignment_owner_id,
          assignment_role_id: role.role_id,
          assignment_boundary_type: role.boundary_type,
          assignment_project_id: role.project_id,
          assignment_active: role.assignment_active,
          assignment_version: role.assignment_version === null
            ? null
            : Number(role.assignment_version),
          system_role_id: role.role_id,
          system_role_active: role.system_role_active,
          role_version_id: role.version_id,
          role_version_role_id: role.role_id,
          role_version: Number(role.version),
          role_version_active: role.role_version_active,
          role_candidate_revision_id: role.role_candidate_revision_id,
          role_definition_name: role.role_definition_name,
        }),
      ),
      ...matched.map((rule) => ({
        kind: "policy",
        target_dependency: "policy_rule",
        project_id: input.projectId,
        policy_assignment_id: rule.assignment_id,
        policy_assignment_policy_version_id: rule.policy_version_id,
        policy_assignment_boundary_type: rule.assignment_boundary_type,
        policy_assignment_project_id: rule.assignment_project_id,
        policy_assignment_active: rule.assignment_active,
        policy_assignment_version: Number(rule.assignment_version),
        policy: rule.policy_id,
        policy_version_id: rule.policy_version_id,
        policy_version: Number(rule.policy_version),
        policy_version_active: rule.policy_version_active,
        policy_candidate_revision_id: rule.policy_candidate_revision_id,
        policy_definition_name: rule.policy_definition_name,
        policy_candidate_active: rule.policy_candidate_active,
        rule_id: rule.id,
        rule_policy_version_id: rule.policy_version_id,
        rule: rule.rule_name ?? rule.id,
        rule_name: rule.rule_name,
        rule_role_id: rule.role_id,
        rule_action: rule.capability,
        rule_resource: rule.resource,
        rule_condition_kind: rule.condition_kind,
        rule_effect: "allow",
        rule_evaluation_order: Number(rule.evaluation_order),
        rule_predicate: rule.predicate,
        rule_relation_relationship: rule.relation_relationship,
        rule_relation_object_side: rule.relation_object_side,
        rule_relation_subject_side: rule.relation_subject_side,
        rule_relation_subject: rule.relation_subject,
      })),
    ];
    dependencies.push(...targetDependencies);
    const matchedRules = [...new Map(matched.map((rule) => [rule.id, {
      policy: rule.policy_id,
      policyVersionId: rule.policy_version_id,
      policyVersion: Number(rule.policy_version),
      rule: rule.rule_name ?? rule.id,
    }])).values()].sort((left, right) =>
      left.policy.localeCompare(right.policy) ||
      left.policyVersion - right.policyVersion ||
      left.policyVersionId.localeCompare(right.policyVersionId) ||
      left.rule.localeCompare(right.rule)
    );
    const roleAssignmentIds = [...matchedRoleIds].sort();
    const sortedRelationshipIds = [...relationshipIds].sort();
    const policyDigest = await digest({
      action: input.action,
      target: reviewed,
      matched_rules: matchedRules,
      role_assignment_ids: roleAssignmentIds,
      relationship_ids: sortedRelationshipIds,
      dependencies: targetDependencies,
    });
    evidence.push({
      target: reviewed,
      policyDigest,
      matchedRules,
      roleAssignmentIds,
      relationshipIds: sortedRelationshipIds,
    });
  }
  return {
    allowed: evidence.length === input.targets.length && evidence.length > 0,
    targets: evidence,
    dependencies: dependencies.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right))
    ),
  };
}

async function directRelationshipEvidence(
  sql: Queryable,
  rule: PolicyRow,
  definition: Definition,
  auth: AuthContext,
  projectId: string,
  objectId: string,
): Promise<
  readonly {
    id: string;
    project_id: string;
    from_object_id: string;
    to_object_id: string;
    current_object_version_id: string;
    archived_at: string | null;
  }[]
> {
  if (
    !rule.relation_relationship || !rule.relation_object_side ||
    !rule.relation_subject_side || !rule.relation_subject ||
    rule.relation_object_side === rule.relation_subject_side
  ) return [];
  const parsed = parseResource(rule.relation_relationship);
  if (!parsed) return [];
  const found = (await query<{ table_name: string; document: unknown }>(
    sql,
    `select rt.table_name,jsonb_extract_path(cr.normalized,'relationships',$3) document
       from pack_active_revisions ar
       join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
       join pack_runtime_tables rt on rt.publisher=ar.publisher and rt.pack_name=ar.pack_name
        and rt.definition_kind='relationship' and rt.definition_name=$3
      where ar.publisher=$1 and ar.pack_name=$2`,
    parsed,
  )).rows[0];
  if (!found) return [];
  const spec = record(record(found.document).spec);
  if (
    String(record(spec[rule.relation_object_side]).resource) !==
      definition.identity ||
    String(record(spec[rule.relation_subject_side]).resource) !==
      "system:principal"
  ) return [];
  const actor = policyActorFromAuthContext(auth);
  const subjectId = rule.relation_subject === "actor.id"
    ? actor.id
    : actor.human_user_id;
  const objectColumn = rule.relation_object_side === "from"
    ? "from_object_id"
    : "to_object_id";
  const subjectColumn = rule.relation_subject_side === "from"
    ? "from_object_id"
    : "to_object_id";
  return (await query<{
    id: string;
    project_id: string;
    from_object_id: string;
    to_object_id: string;
    current_object_version_id: string;
    archived_at: string | null;
  }>(
    sql,
    `select id,project_id,from_object_id,to_object_id,current_object_version_id,
            archived_at::text archived_at
       from ${qi(found.table_name)}
      where project_id=$1 and ${qi(objectColumn)}=$2 and ${qi(subjectColumn)}=$3
        and archived_at is null order by id`,
    [projectId, objectId, subjectId],
  )).rows;
}

function parseResource(value: string): [string, string, string] | null {
  const match =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(value);
  return match ? [match[1], match[2], match[3]] : null;
}

/**
 * Evaluates one semantic action against its reviewed, concrete targets. Object
 * targets use the same SQL ABAC/ReBAC lowering as canonical object reads;
 * targets without an object only accept an unconditional exact-resource rule.
 */
export async function evaluateTargetedActionPolicy(
  sql: Queryable,
  input: {
    projectId: string;
    action: string;
    targets: TargetedActionPolicyTarget[];
  },
  auth: AuthContext,
): Promise<ObjectPolicyEvaluation> {
  if (!input.targets.length) {
    return { allowed: false, policyDigest: await digest(null) };
  }
  try {
    const evaluations: Array<{ target: string; digest: string }> = [];
    for (const target of input.targets) {
      const request = {
        project_id: input.projectId,
        definition: target.definition,
      } as QueryRequest;
      const definition = await resolveDefinition(sql, request);
      if (!definition) {
        await auditTargetedActionDecision(
          sql,
          auth,
          input.projectId,
          input.action,
          target,
          "policy.denied",
          [],
        );
        return { allowed: false, policyDigest: await digest(null) };
      }
      const params: unknown[] = target.objectId
        ? [input.projectId, target.objectId]
        : [input.projectId];
      const policy = await resolvePolicyAuthorization(
        sql,
        input.projectId,
        definition,
        auth,
        [input.action],
        params,
        true,
      );
      let allowed = policy.superAdmin;
      if (!allowed && target.objectId) {
        const result = await query<{ allowed: boolean }>(
          sql,
          `select exists(select 1 from ${qi(definition.table)} q
            where q.project_id=$1 and q.id=$2 and q.archived_at is null
            and (${policy.predicates[input.action]})) allowed`,
          params,
        );
        allowed = result.rows[0]?.allowed === true;
      } else if (!allowed) {
        allowed = policy.rules[input.action].some((rule) =>
          !rule.predicate && !rule.relation_relationship
        );
      }
      await auditTargetedActionDecision(
        sql,
        auth,
        input.projectId,
        input.action,
        target,
        policy.superAdmin
          ? "policy.bypassed"
          : allowed
          ? "policy.allowed"
          : "policy.denied",
        policy.rules[input.action].map((rule) => rule.policy_id),
      );
      if (!allowed) return { allowed: false, policyDigest: policy.digest };
      evaluations.push({ target: targetKey(target), digest: policy.digest });
    }
    return {
      allowed: true,
      policyDigest: await digest({
        action: input.action,
        targets: evaluations.sort((a, b) => a.target.localeCompare(b.target)),
      }),
    };
  } catch (error) {
    if (error instanceof QueryFailure || error instanceof ExpressionError) {
      return { allowed: false, policyDigest: await digest(null) };
    }
    throw error;
  }
}

async function auditTargetedActionDecision(
  sql: Queryable,
  auth: AuthContext,
  projectId: string,
  action: string,
  target: TargetedActionPolicyTarget,
  eventType: "policy.allowed" | "policy.denied" | "policy.bypassed",
  policies: string[],
): Promise<void> {
  const actor = policyActorFromAuthContext(auth);
  await query(
    sql,
    "insert into authorization_audit_events(id,auth_context_id,event_type,details) values($1,$2,$3,$4::jsonb)",
    [
      uuidV7(),
      auth.id,
      eventType,
      JSON.stringify({
        principal_id: actor.id,
        actor,
        boundary: { type: "project", project_id: projectId },
        action,
        resource:
          `${target.definition.publisher}/${target.definition.pack}:${target.definition.name}`,
        object_id: target.objectId ?? null,
        checked_policies: [...new Set(policies)].sort(),
      }),
    ],
  );
}

function targetKey(target: TargetedActionPolicyTarget): string {
  const definition = target.definition;
  return `${definition.kind}:${definition.publisher}/${definition.pack}:${definition.name}:${
    target.objectId ?? "unconditional"
  }`;
}

async function resolvePolicyAuthorization(
  sql: Queryable,
  project: string,
  definition: Definition,
  auth: AuthContext,
  actions: string[],
  params: unknown[],
  exactResource = false,
): Promise<PolicyAuthorization> {
  const roles = await effectiveRoles(sql, auth, project);
  const superAdmin = roles.some((role) =>
    role.role_id === "system:super_admin" && role.boundary_type === "system"
  );
  const rules: Record<string, PolicyRow[]> = {};
  const predicates: Record<string, string> = {};
  for (const action of [...new Set(actions)]) {
    rules[action] = superAdmin ? [] : await policyRows(
      sql,
      roles.map((role) => role.role_id),
      project,
      definition.identity,
      action,
      exactResource,
    );
    predicates[action] = superAdmin ? "true" : await compilePolicy(
      sql,
      rules[action],
      definition,
      auth,
      project,
      params,
    );
  }
  const anchor = await lockReadAuthority(sql, auth, project);
  return {
    predicates,
    rules,
    superAdmin,
    digest: await digest({
      principal: auth.principalId,
      leaf: auth.authorizationId ?? null,
      root: anchor.authorizationRootId,
      roles: roles.map((role) => [
        role.role_id,
        role.version_id,
        role.version,
        role.boundary_type,
      ]),
      assignments: Object.values(rules).flat().map((rule) => [
        rule.assignment_id,
        rule.assignment_version,
        rule.policy_version_id,
        rule.policy_version,
        rule.id,
      ]).sort(),
      actions: [...new Set(actions)].sort(),
      super_admin: superAdmin,
    }),
  };
}

async function effectiveRoles(
  sql: Queryable,
  auth: AuthContext,
  project: string,
): Promise<EffectiveRole[]> {
  return (await query<EffectiveRole>(
    sql,
    auth.authorizationId
      ? `select ar.id assignment_id,ar.authorization_id assignment_owner_id,
          true assignment_active,null::bigint assignment_version,
          ar.role_id,sr.active system_role_active,rv.id version_id,rv.version,
          rv.active role_version_active,rv.candidate_revision_id role_candidate_revision_id,
          rv.definition_name role_definition_name,ar.boundary_type,ar.project_id
         from agent_authorization_roles ar
         join system_roles sr on sr.id=ar.role_id and sr.active
         join role_definition_versions rv on rv.role_id=ar.role_id and rv.active
        where ar.authorization_id=$1 and
          (ar.boundary_type='all_projects' or
            (ar.boundary_type='project' and ar.project_id=$2) or
            (ar.role_id='system:super_admin' and ar.boundary_type='system'))
        order by ar.role_id,ar.id,rv.id`
      : `select ra.id assignment_id,ra.principal_id assignment_owner_id,
          ra.active assignment_active,ra.version assignment_version,
          ra.role_id,sr.active system_role_active,rv.id version_id,rv.version,
          rv.active role_version_active,rv.candidate_revision_id role_candidate_revision_id,
          rv.definition_name role_definition_name,ra.boundary_type,ra.project_id
         from role_assignments ra
         join system_roles sr on sr.id=ra.role_id and sr.active
         join role_definition_versions rv on rv.role_id=ra.role_id and rv.active
        where ra.principal_id=$1 and ra.active and
          (ra.boundary_type='all_projects' or
            (ra.boundary_type='project' and ra.project_id=$2) or
            (ra.role_id='system:super_admin' and ra.boundary_type='system'))
        order by ra.role_id,ra.id,rv.id`,
    [auth.authorizationId ?? auth.principalId, project],
  )).rows;
}
async function policyRows(
  sql: Queryable,
  roles: string[],
  project: string,
  resource: string,
  action: string,
  exactResource = false,
) {
  if (!roles.length) return [];
  return (await query<PolicyRow>(
    sql,
    `select pr.id,pr.rule_name,pr.role_id,pr.capability,pr.resource,
      pr.condition_kind,pr.predicate,pr.relation_relationship,
      pr.relation_object_side,pr.relation_subject_side,pr.relation_subject,
      (row_number() over(order by pd.policy_id,pr.rule_name,pr.id,pa.id)-1)::int evaluation_order,
      pd.policy_id,pd.id policy_version_id,pd.version policy_version,
      pd.active policy_version_active,pd.candidate_revision_id policy_candidate_revision_id,
      pd.definition_name policy_definition_name,
      (pd.candidate_revision_id is null or ar.candidate_revision_id is not null) policy_candidate_active,
      pa.id assignment_id,pa.version assignment_version,
      pa.boundary_type assignment_boundary_type,pa.project_id assignment_project_id,
      pa.active assignment_active
 from policy_rules pr join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active
 join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active
 left join pack_active_revisions ar on ar.candidate_revision_id=pd.candidate_revision_id
 where pr.role_id=any($1::text[]) and pr.capability=$2
 and (pr.resource=$3 or (not $5::boolean and pr.resource='*'))
 and (pa.boundary_type='all_projects' or
      (pa.boundary_type='project' and pa.project_id=$4))
 and (pd.candidate_revision_id is null or ar.candidate_revision_id is not null)
 order by pd.policy_id,pr.rule_name,pr.id,pa.id`,
    [roles, action, resource, project, exactResource],
  )).rows;
}

async function compilePolicy(
  sql: Queryable,
  rules: PolicyRow[],
  definition: Definition,
  auth: AuthContext,
  project: string,
  params: unknown[],
): Promise<string> {
  const actor = policyActorFromAuthContext(auth);
  const candidates: string[] = [];
  for (const rule of rules) {
    const parts: string[] = [];
    if (rule.predicate) {
      let lowered;
      try {
        lowered = lowerExpression(rule.predicate, {
          fields: definition.fields,
          alias: "q",
          parameterOffset: params.length,
          actor: {
            id: { type: "string", value: actor.id },
            principal_type: {
              type: "string",
              value: actor.principal_type,
            },
            human_user_id: {
              type: "string",
              value: actor.human_user_id,
            },
          },
        });
      } catch {
        throw hidden();
      }
      params.push(...lowered.params);
      parts.push(lowered.sql);
    }
    if (rule.relation_relationship) {
      parts.push(
        await relationSql(sql, rule, definition, auth, project, params),
      );
    }
    candidates.push(parts.length ? `(${parts.join(" and ")})` : "true");
  }
  return candidates.length ? `(${candidates.join(" or ")})` : "false";
}
async function relationSql(
  sql: Queryable,
  rule: PolicyRow,
  definition: Definition,
  auth: AuthContext,
  project: string,
  params: unknown[],
): Promise<string> {
  if (
    !rule.relation_object_side || !rule.relation_subject_side ||
    rule.relation_object_side === rule.relation_subject_side ||
    !rule.relation_subject
  ) throw new QueryFailure("hidden");
  const parsed =
    /^([a-z][a-z0-9-]{0,62})\/([a-z][a-z0-9_]{0,62}):([a-z][a-z0-9_]{0,62})$/
      .exec(rule.relation_relationship!);
  if (!parsed) throw hidden();
  const rel = await query<{ table_name: string; document: unknown }>(
    sql,
    `select rt.table_name,jsonb_extract_path(cr.normalized,'relationships',$3) document from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id join pack_runtime_tables rt on rt.publisher=ar.publisher and rt.pack_name=ar.pack_name and rt.definition_kind='relationship' and rt.definition_name=$3 where ar.publisher=$1 and ar.pack_name=$2`,
    [parsed[1], parsed[2], parsed[3]],
  );
  const found = rel.rows[0];
  if (!found) throw hidden();
  const spec = record(record(found.document).spec);
  const objectEndpoint = String(
    record(spec[rule.relation_object_side]).resource,
  );
  const subjectEndpoint = String(
    record(spec[rule.relation_subject_side]).resource,
  );
  if (
    objectEndpoint !== definition.identity ||
    subjectEndpoint !== "system:principal"
  ) throw hidden();
  const actor = policyActorFromAuthContext(auth);
  const subjectId = rule.relation_subject === "actor.id"
    ? actor.id
    : actor.human_user_id;
  const projectParam = params.push(project);
  const subjectParam = params.push(subjectId);
  const objectCol = rule.relation_object_side === "from"
      ? "from_object_id"
      : "to_object_id",
    subjectCol = rule.relation_subject_side === "from"
      ? "from_object_id"
      : "to_object_id";
  return `exists(select 1 from ${
    qi(found.table_name)
  } rel where rel.project_id=$${projectParam}::uuid and rel.${
    qi(objectCol)
  }=q.id and rel.${
    qi(subjectCol)
  }=$${subjectParam}::uuid and rel.archived_at is null)`;
}
function keysetSql(
  sort: ResolvedSort[],
  values: unknown[],
  params: unknown[],
  kind: "resource" | "relationship",
  fields: Record<string, FieldSpec>,
) {
  // Bind timestamps as text so postgres.js cannot round them through Date.
  const parameter = (field: string) =>
    fields[field]?.type === "timestamp"
      ? `$${params.length}::text::timestamptz`
      : `$${params.length}`;
  const clauses: string[] = [];
  for (let i = 0; i < sort.length; i++) {
    const equal: string[] = [];
    for (let j = 0; j < i; j++) {
      params.push(values[j]);
      equal.push(
        `q.${qi(column(sort[j].field, kind))} is not distinct from ${
          parameter(sort[j].field)
        }`,
      );
    }
    const col = `q.${qi(column(sort[i].field, kind))}`;
    let after: string;
    if (values[i] === null) {
      after = sort[i].direction === "asc" ? "false" : `${col} is not null`;
    } else {
      params.push(values[i]);
      const p = parameter(sort[i].field);
      after = sort[i].direction === "asc"
        ? `(${col}>${p} or ${col} is null)`
        : `${col}<${p}`;
    }
    clauses.push(`(${[...equal, after].join(" and ")})`);
  }
  return `(${clauses.join(" or ")})`;
}
function column(field: string, kind: "resource" | "relationship") {
  return kind === "relationship" && field === "from"
    ? "from_object_id"
    : kind === "relationship" && field === "to"
    ? "to_object_id"
    : field;
}
function value(row: Record<string, unknown>, field: string) {
  const v = row[field];
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  return v;
}
function typedValue(
  row: Record<string, unknown>,
  field: string,
  spec: FieldSpec | undefined,
): unknown {
  const found = value(row, field);
  if (spec?.type === "decimal") return canonicalDecimal(found);
  if (spec?.type === "timestamp" && found !== null) {
    const instant = new Date(String(found));
    if (Number.isNaN(instant.getTime())) {
      throw new QueryFailure("invalid_data");
    }
    // SQL supplies canonical UTC microseconds. Date would truncate the keyset
    // boundary to milliseconds and skip rows sharing that millisecond.
    return found;
  }
  if (spec?.type === "integer" && found !== null) {
    if (typeof found !== "string" || !/^-?[0-9]+$/.test(found)) {
      throw new QueryFailure("invalid_data");
    }
    const integer = BigInt(found);
    if (
      integer > BigInt(Number.MAX_SAFE_INTEGER) ||
      integer < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new QueryFailure("invalid_data");
    }
    return Number(integer);
  }
  return found;
}
function canonicalDecimal(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new QueryFailure("invalid_data");
  }
  const source = value;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(source)) {
    throw new QueryFailure("invalid_data");
  }
  const [integer, fraction = ""] = source.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalized = trimmed ? `${integer}.${trimmed}` : integer;
  return /^-0(?:\.0*)?$/.test(normalized) ? "0" : normalized;
}
function fieldType(v: unknown): FieldSpec["type"] {
  return ["integer", "decimal", "boolean", "date", "timestamp"].includes(
      String(v),
    )
    ? String(v) as FieldSpec["type"]
    : "string";
}
function qi(v: string) {
  return quoteIdentifier(v);
}
function record(v: unknown): Record<string, unknown> {
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return v && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
}
function hidden() {
  return new QueryFailure("hidden");
}
async function digest(value: unknown) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return `sha256:${
    [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join(
      "",
    )
  }`;
}
