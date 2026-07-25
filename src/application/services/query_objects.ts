import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import {
  ExpressionError,
  type FieldSpec,
  lowerExpression,
} from "../../domain/expressions/cel.ts";
import { canonicalJson } from "../../domain/ids/canonical_json.ts";
import { QueryCursorSigner } from "../../domain/queries/cursor.ts";
import {
  type QueryRequest,
  queryRequestContract,
  type QueryResponse,
  type ResolvedSort,
} from "../../schemas/queries/query.ts";
import {
  query,
  type Queryable,
  quoteIdentifier,
  type Sql,
} from "../../adapters/outbound/postgres/client.ts";
import { lockReadAuthority } from "../../adapters/outbound/postgres/object_read_boundary.ts";
import { ObjectReadAuthorityInvalidError } from "../ports/object_reader.ts";

export type QueryObjectsRequest = QueryRequest;
export type QueryObjectsDto = QueryResponse;
type Definition = {
  revisionId: string;
  table: string;
  document: Record<string, unknown>;
  fields: Record<string, FieldSpec>;
  packFields: string[];
  identity: string;
};
type PolicyRow = {
  id: string;
  rule_name: string;
  role_id: string;
  capability: string;
  resource: string;
  predicate: string | null;
  relation_relationship: string | null;
  relation_object_side: "from" | "to" | null;
  relation_subject_side: "from" | "to" | null;
  relation_subject: "actor.id" | "actor.human_user_id" | null;
  policy_id: string;
  policy_version_id: string;
  policy_version: number;
  assignment_id: string;
  assignment_version: number;
};
class QueryFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function makeQueryObjectsService(
  deps: { sql: Sql; cursors?: () => QueryCursorSigner },
) {
  let cursor: QueryCursorSigner | undefined;
  return {
    async query(
      input: unknown,
      auth?: AuthContext,
    ): Promise<Result<QueryResponse>> {
      try {
        if (!auth) {
          throw new QueryFailure(
            "authentication_required",
            "authentication is required",
          );
        }
        const issues = queryRequestContract.issues(input);
        if (issues.length) {
          throw new QueryFailure("bad_request", "query request is invalid", {
            issues,
          });
        }
        const request = input as QueryRequest;
        return ok(
          await deps.sql.begin(async (tx) => {
            await lockReadAuthority(tx, auth, request.project_id);
            return await execute(
              tx,
              request,
              auth,
              deps.cursors?.() ??
                (cursor ??= QueryCursorSigner.fromEnvironment()),
            );
          }) as QueryResponse,
        );
      } catch (error) {
        const failure = error instanceof QueryFailure
          ? error
          : error instanceof ExpressionError
          ? new QueryFailure("bad_request", "query expression is invalid", {
            issues: [{
              path: "/where",
              code: error.code,
              message: error.message,
              ...error.details,
            }],
          })
          : error instanceof ObjectReadAuthorityInvalidError
          ? new QueryFailure(
            "credential_invalid",
            "credential authority is no longer valid",
          )
          : new QueryFailure("internal_error", "query could not be completed");
        return err({
          ...validationError(failure.code, failure.message, failure.details),
          severity: failure.code === "not_found"
            ? "not_found"
            : failure.code === "authentication_required" ||
                failure.code === "credential_invalid"
            ? "authentication"
            : failure.code === "internal_error"
            ? "internal"
            : "validation",
        });
      }
    },
  };
}

async function execute(
  sql: Queryable,
  request: QueryRequest,
  auth: AuthContext,
  cursors: QueryCursorSigner,
): Promise<QueryResponse> {
  const project = await query(
    sql,
    "select id from projects where id=$1 for share",
    [request.project_id],
  );
  if (!project.rows.length) throw hidden();
  const definition = await resolveDefinition(sql, request);
  if (!definition) throw hidden();
  const fields = resolveFields(request.fields, definition);
  const sort = resolveSort(request.sort, definition);
  const roles = await effectiveRoles(sql, auth, request.project_id);
  const superAdmin = roles.some((role) =>
    role.role_id === "system:super_admin" && role.boundary_type === "system"
  );
  const readRules = superAdmin ? [] : await policyRows(
    sql,
    roles.map((r) => r.role_id),
    request.project_id,
    definition.identity,
    "read",
  );
  if (!superAdmin && !readRules.length && !request.cursor) throw hidden();
  let archivedRules: PolicyRow[] = [];
  if (request.include_archived && !superAdmin) {
    archivedRules = await policyRows(
      sql,
      roles.map((r) => r.role_id),
      request.project_id,
      definition.identity,
      "read_archived",
    );
    if (!archivedRules.length && !request.cursor) throw hidden();
  }

  const params: unknown[] = [request.project_id];
  const user = lowerExpression(request.where ?? "true", {
    fields: definition.fields,
    alias: "q",
    parameterOffset: params.length,
  });
  params.push(...user.params);
  const readPredicate = superAdmin ? "true" : await compilePolicy(
    sql,
    readRules,
    definition,
    auth,
    request.project_id,
    params,
  );
  const archivePredicate = request.include_archived
    ? (superAdmin ? "true" : await compilePolicy(
      sql,
      archivedRules,
      definition,
      auth,
      request.project_id,
      params,
    ))
    : `q."archived_at" is null`;
  const policyContext = {
    principal: auth.principalId,
    leaf: auth.authorizationId ?? null,
    root: (await lockReadAuthority(sql, auth, request.project_id))
      .authorizationRootId,
    roles: roles.map((r) => [
      r.role_id,
      r.version_id,
      r.version,
      r.boundary_type,
    ]),
    assignments: [...readRules, ...archivedRules].map((
      r,
    ) => [
      r.assignment_id,
      r.assignment_version,
      r.policy_version_id,
      r.policy_version,
      r.id,
    ]).sort(),
    super_admin: superAdmin,
  };
  const policyDigest = await digest(policyContext);
  const shapeDigest = await digest({
    project_id: request.project_id,
    definition: request.definition,
    revision_id: definition.revisionId,
    where: user.normalized,
    fields,
    sort,
    limit: request.limit ?? 50,
    include_archived: request.include_archived ?? false,
    include_total: request.include_total ?? false,
  });
  let position: { values: unknown[]; id: string } | null = null;
  if (request.cursor) {
    try {
      position = await cursors.decode(
        request.cursor,
        shapeDigest,
        policyDigest,
        sort.map((item) => definition.fields[item.field]),
      );
    } catch {
      throw new QueryFailure(
        "invalid_cursor",
        "query cursor is invalid or stale",
      );
    }
    if (position.values.length !== sort.length) {
      throw new QueryFailure(
        "invalid_cursor",
        "query cursor is invalid or stale",
      );
    }
  }
  const keyset = position
    ? keysetSql(sort, position.values, params, request.definition.kind)
    : "true";
  const order = sort.map((item) =>
    `q.${qi(column(item.field, request.definition.kind))} ${item.direction} ${
      item.direction === "asc" ? "nulls last" : "nulls first"
    }`
  ).join(",");
  params.push((request.limit ?? 50) + 1);
  const overrides = Object.entries(definition.fields).filter(([, spec]) =>
    spec.type === "decimal" || spec.type === "integer"
  ).flatMap(([field]) => [
    `'${column(field, request.definition.kind)}'`,
    `page.${qi(column(field, request.definition.kind))}::text`,
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
  const items = page.map((row) => dto(row, request, definition, fields));
  let next: string | null = null;
  if (hasMore) {
    const last = page[page.length - 1];
    next = await cursors.encode(shapeDigest, policyDigest, {
      values: sort.map((s) =>
        typedValue(
          last,
          column(s.field, request.definition.kind),
          definition.fields[s.field],
        )
      ),
      id: String(last.id),
    });
  }
  return {
    items,
    resolved_fields: fields,
    resolved_sort: sort,
    next_cursor: next,
    has_more: hasMore,
    total: request.include_total ? Number(result.rows[0]?.total ?? 0) : null,
    policy_context_digest: policyDigest,
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
function resolveFields(
  requested: string[] | undefined,
  definition: Definition,
) {
  if (requested) {
    duplicates(requested, "projection");
    for (const f of requested) {
      if (!definition.packFields.includes(f)) {
        throw new QueryFailure("bad_request", `unknown projection field ${f}`);
      }
    }
    return requested;
  }
  const list = record(record(record(definition.document.spec).axi).list);
  const axi = Array.isArray(list.fields)
    ? list.fields.map(String).filter((f) =>
      f !== "id" && definition.packFields.includes(f)
    )
    : [];
  return (axi.length ? axi : definition.packFields.slice(0, 20));
}
function resolveSort(
  input: QueryRequest["sort"],
  definition: Definition,
): ResolvedSort[] {
  const raw = input ?? [{ field: "updated_at", direction: "desc" as const }];
  duplicates(raw.map((s) => s.field), "sort");
  for (const s of raw) {
    if (s.field === "id") {
      throw new QueryFailure(
        "bad_request",
        "id is an implicit sort tie-breaker",
      );
    }
    if (!definition.fields[s.field]) {
      throw new QueryFailure("bad_request", `unknown sort field ${s.field}`);
    }
  }
  const out = [...raw];
  if (!out.some((s) => s.field === "id")) {
    out.push({ field: "id", direction: out[out.length - 1].direction });
  }
  return out;
}
async function effectiveRoles(
  sql: Queryable,
  auth: AuthContext,
  project: string,
) {
  return (await query<{
    role_id: string;
    version_id: string;
    version: number;
    boundary_type: "system" | "all_projects" | "project";
  }>(
    sql,
    auth.authorizationId
      ? `select ar.role_id,rv.id version_id,rv.version,ar.boundary_type from agent_authorization_roles ar join role_definition_versions rv on rv.role_id=ar.role_id and rv.active where ar.authorization_id=$1 and (ar.boundary_type='all_projects' or ar.project_id=$2 or (ar.role_id='system:super_admin' and ar.boundary_type='system')) order by ar.role_id`
      : `select ra.role_id,rv.id version_id,rv.version,ra.boundary_type from role_assignments ra join role_definition_versions rv on rv.role_id=ra.role_id and rv.active where ra.principal_id=$1 and ra.active and (ra.boundary_type='all_projects' or ra.project_id=$2 or (ra.role_id='system:super_admin' and ra.boundary_type='system')) order by ra.role_id`,
    [auth.authorizationId ?? auth.principalId, project],
  )).rows;
}
async function policyRows(
  sql: Queryable,
  roles: string[],
  project: string,
  resource: string,
  action: string,
) {
  if (!roles.length) return [];
  return (await query<PolicyRow>(
    sql,
    `select pr.id,pr.rule_name,pr.role_id,pr.capability,pr.resource,pr.predicate,pr.relation_relationship,pr.relation_object_side,pr.relation_subject_side,pr.relation_subject,
 pd.policy_id,pd.id policy_version_id,pd.version policy_version,pa.id assignment_id,pa.version assignment_version
 from policy_rules pr join policy_definition_versions pd on pd.id=pr.policy_definition_version_id and pd.active
 join policy_assignments pa on pa.policy_definition_version_id=pd.id and pa.active
 left join pack_active_revisions ar on ar.candidate_revision_id=pd.candidate_revision_id
 where pr.role_id=any($1::text[]) and pr.capability=$2 and pr.resource=$3 and (pa.boundary_type='all_projects' or pa.project_id=$4)
 and (pd.candidate_revision_id is null or ar.candidate_revision_id is not null) order by pd.policy_id,pr.rule_name,pr.id`,
    [roles, action, resource, project],
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
            id: { type: "string", value: auth.principalId },
            principal_type: { type: "string", value: auth.principalType },
            human_user_id: {
              type: "string",
              value: auth.principalType === "agent_user"
                ? null
                : auth.humanUserId,
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
  ) throw new QueryFailure("not_found", "requested definition was not found");
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
  const actor = rule.relation_subject === "actor.id"
    ? auth.principalId
    : auth.principalType === "agent_user"
    ? null
    : auth.humanUserId;
  if (!actor) return "false";
  const projectParam = params.push(project);
  const subjectParam = params.push(actor);
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
) {
  const clauses: string[] = [];
  for (let i = 0; i < sort.length; i++) {
    const equal: string[] = [];
    for (let j = 0; j < i; j++) {
      params.push(values[j]);
      equal.push(
        `q.${
          qi(column(sort[j].field, kind))
        } is not distinct from $${params.length}`,
      );
    }
    const col = `q.${qi(column(sort[i].field, kind))}`;
    let after: string;
    if (values[i] === null) {
      after = sort[i].direction === "asc" ? "false" : `${col} is not null`;
    } else {
      params.push(values[i]);
      const p = `$${params.length}`;
      after = sort[i].direction === "asc"
        ? `(${col}>${p} or ${col} is null)`
        : `${col}<${p}`;
    }
    clauses.push(`(${[...equal, after].join(" and ")})`);
  }
  return `(${clauses.join(" or ")})`;
}
function dto(
  row: Record<string, unknown>,
  request: QueryRequest,
  definition: Definition,
  fields: string[],
): Record<string, unknown> {
  const common = {
    id: String(row.id),
    project_id: String(row.project_id),
    version: Number(row.version),
    object_version_id: String(row.current_object_version_id),
    archived_at: timestamp(row.archived_at),
    created_at: timestamp(row.created_at),
    updated_at: timestamp(row.updated_at),
  };
  const identity = {
    publisher: request.definition.publisher,
    pack: request.definition.pack,
    name: request.definition.name,
    revision_id: definition.revisionId,
  };
  const projected = Object.fromEntries(fields.map((f) => [
    f,
    typedValue(row, f, definition.fields[f]),
  ]));
  return request.definition.kind === "resource"
    ? { kind: "object", ...common, resource: identity, data: projected }
    : {
      kind: "relationship",
      ...common,
      relationship: identity,
      from: String(row.from_object_id),
      to: String(row.to_object_id),
      fields: projected,
    };
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
      throw new QueryFailure("internal_error", "database timestamp is invalid");
    }
    return instant.toISOString();
  }
  if (spec?.type === "integer" && found !== null) {
    if (typeof found !== "string" || !/^-?[0-9]+$/.test(found)) {
      throw new QueryFailure(
        "internal_error",
        "database integer was not returned as text",
      );
    }
    const integer = BigInt(found);
    if (
      integer > BigInt(Number.MAX_SAFE_INTEGER) ||
      integer < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new QueryFailure(
        "internal_error",
        "database integer exceeds JSON-safe range",
      );
    }
    return Number(integer);
  }
  return found;
}
function canonicalDecimal(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new QueryFailure(
      "internal_error",
      "database decimal was not returned as text",
    );
  }
  const source = value;
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(source)) {
    throw new QueryFailure(
      "internal_error",
      "database returned a non-canonical decimal",
    );
  }
  const [integer, fraction = ""] = source.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalized = trimmed ? `${integer}.${trimmed}` : integer;
  return /^-0(?:\.0*)?$/.test(normalized) ? "0" : normalized;
}
function timestamp(v: unknown) {
  if (v == null) return null;
  const instant = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(instant.getTime()) ? String(v) : instant.toISOString();
}
function fieldType(v: unknown): FieldSpec["type"] {
  return ["integer", "decimal", "boolean", "date", "timestamp"].includes(
      String(v),
    )
    ? String(v) as FieldSpec["type"]
    : "string";
}
function duplicates(values: string[], kind: string) {
  if (new Set(values).size !== values.length) {
    throw new QueryFailure(
      "bad_request",
      `${kind} fields must not contain duplicates`,
    );
  }
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
  return new QueryFailure(
    "not_found",
    "requested project or definition was not found",
  );
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
