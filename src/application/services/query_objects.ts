import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import {
  type FieldSpec,
  type FieldType,
  lowerCelToSql,
} from "../../domain/queries/expression_lowerer.ts";
import {
  query,
  type Queryable,
  quoteIdentifier,
} from "../../adapters/outbound/postgres/client.ts";

export type QuerySort = { field: string; direction?: "asc" | "desc" };
export type QueryActor = string | {
  id?: string;
  roles?: string[];
  [key: string]: unknown;
};
export type QueryObjectsRequest = {
  actor?: QueryActor;
  resource: string;
  fields?: string[];
  where?: string;
  sort?: QuerySort[];
  limit?: number;
  cursor?: string | null;
  include_archived?: boolean;
};
export type QueryObjectsDto = {
  resource: string;
  items: Record<string, unknown>[];
  page: {
    limit: number;
    returned: number;
    has_more: boolean;
    next_cursor: string | null;
    sort: Required<QuerySort>[];
  };
  fields: { source: "request" | "axi" | "default"; selected: string[] };
  filter: { where: string | null };
  policy: { digest: string; summary: string };
};

type ResourceMeta = {
  namespace: string;
  name: string;
  revision: string;
  tableName: string;
  fields: Record<string, { type?: string; required?: boolean }>;
  axiFields: string[];
};
type CursorPayload = { v: 1; digest: string; values: Record<string, unknown> };

const PLATFORM_FIELDS: Record<string, FieldSpec> = {
  id: { type: "string" },
  version: { type: "integer" },
  archived_at: { type: "timestamp", nullable: true },
  archived_by: { type: "string", nullable: true },
  current_object_version_id: { type: "string", nullable: true },
  created_at: { type: "timestamp" },
  updated_at: { type: "timestamp" },
};

export function makeQueryObjectsService(deps: { sql: Queryable }) {
  return {
    async query(input: QueryObjectsRequest): Promise<Result<QueryObjectsDto>> {
      try {
        return ok(await runQuery(deps.sql, input));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof QueryError ? error.code : "bad_query";
        return err(validationError(code, message));
      }
    },
  };
}

export async function runQuery(
  sql: Queryable,
  input: QueryObjectsRequest,
): Promise<QueryObjectsDto> {
  if (!input || typeof input !== "object") {
    throw new QueryError("bad_request", "query body must be an object");
  }
  const meta = await getResourceMeta(sql, input.resource);
  if (!meta) {
    throw new QueryError(
      "unknown_resource",
      `resource ${input.resource} not found`,
    );
  }
  const selectable = fieldContext(meta);
  const selected = selectFields(input.fields, meta, selectable);
  const sort = normalizeSort(input.sort, selectable);
  const limit = normalizeLimit(input.limit);
  const actor = normalizeActor(input.actor);
  if (input.include_archived && !actor.roles.includes("super_admin")) {
    throw new QueryError(
      "include_archived_denied",
      "include_archived requires super_admin until policy integration",
    );
  }

  const whereParts: string[] = [];
  const params: unknown[] = [];
  if (input.where?.trim()) {
    const lowered = lowerCelToSql(input.where, {
      fields: selectable,
      actor: actorFields(actor),
      allowSelfAlias: true,
      maxNodes: 80,
      maxLength: 1_000,
    });
    whereParts.push(offsetParams(lowered.sql, params.length));
    params.push(...lowered.params);
  }
  if (!input.include_archived) whereParts.push(`${qi("archived_at")} is null`);

  const digest = await queryDigest({
    resource: input.resource,
    where: input.where?.trim() || null,
    sort,
    fields: selected,
    actor_policy: actorPolicyDigest(actor),
    include_archived: input.include_archived === true,
  });
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor && cursor.digest !== digest) {
    throw new QueryError(
      "cursor_mismatch",
      "cursor does not match query filter/sort/projection/actor-policy context",
    );
  }
  if (cursor) whereParts.push(keysetPredicate(sort, cursor.values, params));

  const orderBy = sort.map((s) => `${qi(s.field)} ${s.direction}`).join(", ");
  const sqlText = `select ${selected.map(qi).join(", ")} from ${
    qi(meta.tableName)
  }${
    whereParts.length
      ? ` where ${whereParts.map((p) => `(${p})`).join(" and ")}`
      : ""
  } order by ${orderBy} limit $${params.length + 1}`;
  const result = await query<Record<string, unknown>>(sql, sqlText, [
    ...params,
    limit + 1,
  ]);
  const pageRows = result.rows.slice(0, limit);
  const hasMore = result.rows.length > limit;
  return {
    resource: input.resource,
    items: pageRows,
    page: {
      limit,
      returned: pageRows.length,
      has_more: hasMore,
      next_cursor: hasMore
        ? encodeCursor({
          v: 1,
          digest,
          values: cursorValues(pageRows[pageRows.length - 1], sort),
        })
        : null,
      sort,
    },
    fields: {
      source: input.fields?.length
        ? "request"
        : meta.axiFields.length
        ? "axi"
        : "default",
      selected,
    },
    filter: { where: input.where?.trim() || null },
    policy: {
      digest: actorPolicyDigest(actor),
      summary: "policy pending; super_admin may include archived",
    },
  };
}

async function getResourceMeta(
  sql: Queryable,
  id: string,
): Promise<ResourceMeta | null> {
  const [namespace, name] = splitId(id);
  if (!namespace || !name) return null;
  const rows = await query<
    {
      namespace: string;
      name: string;
      revision: string;
      spec: unknown;
      table_name: string;
    }
  >(
    sql,
    `select r.namespace,r.name,r.revision,r.spec,g.table_name from resource_definitions r join generated_sql_objects g on g.revision=r.revision and g.namespace=r.namespace and g.name=r.name and g.kind='resource_table' where r.namespace=$1 and r.name=$2 and r.revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1)`,
    [namespace, name],
  );
  const row = rows.rows[0];
  if (!row) return null;
  const spec = asRecord(row.spec);
  const axi = asRecord(spec.axi);
  const list = asRecord(axi.list);
  return {
    namespace,
    name,
    revision: row.revision,
    tableName: row.table_name,
    fields: asRecord(spec.fields) as ResourceMeta["fields"],
    axiFields: Array.isArray(list.fields) &&
        list.fields.every((f) => typeof f === "string")
      ? list.fields
      : [],
  };
}

function fieldContext(meta: ResourceMeta): Record<string, FieldSpec> {
  const fields: Record<string, FieldSpec> = { ...PLATFORM_FIELDS };
  for (const [name, spec] of Object.entries(meta.fields)) {
    fields[name] = { type: mapFieldType(spec.type), nullable: !spec.required };
  }
  return fields;
}
function mapFieldType(type: unknown): FieldType {
  if (
    type === "integer" || type === "decimal" || type === "boolean" ||
    type === "timestamp" || type === "date"
  ) return type;
  return "string";
}
function selectFields(
  requested: string[] | undefined,
  meta: ResourceMeta,
  fields: Record<string, FieldSpec>,
): string[] {
  const selected = requested?.length
    ? requested
    : meta.axiFields.length
    ? meta.axiFields
    : ["id", ...Object.keys(meta.fields).slice(0, 4)];
  const seen = new Set<string>();
  for (const field of selected) {
    if (!fields[field]) {
      throw new QueryError(
        "unknown_projection_field",
        `unknown projection field ${field}`,
      );
    }
    seen.add(field);
  }
  return [...seen];
}
function normalizeSort(
  input: QuerySort[] | undefined,
  fields: Record<string, FieldSpec>,
): Required<QuerySort>[] {
  const sort = input?.length
    ? input
    : [{ field: "updated_at", direction: "desc" as const }];
  const normalized = sort.map((s) => {
    if (!fields[s.field]) {
      throw new QueryError(
        "unknown_sort_field",
        `unknown sort field ${s.field}`,
      );
    }
    const direction = s.direction ?? "asc";
    if (direction !== "asc" && direction !== "desc") {
      throw new QueryError("bad_sort", `bad sort direction ${direction}`);
    }
    return { field: s.field, direction };
  });
  if (!normalized.some((s) => s.field === "id")) {
    normalized.push({
      field: "id",
      direction: normalized[0]?.direction ?? "asc",
    });
  }
  return normalized;
}
function normalizeLimit(limit: unknown): number {
  const value = limit === undefined ? 25 : Number(limit);
  if (!Number.isInteger(value) || value < 1) {
    throw new QueryError("bad_limit", "limit must be a positive integer");
  }
  return Math.min(value, 100);
}
function normalizeActor(
  actor: QueryActor | undefined,
): { id: string; roles: string[] } {
  if (typeof actor === "string") {
    return { id: actor, roles: actor === "super_admin" ? ["super_admin"] : [] };
  }
  if (actor && typeof actor === "object") {
    return {
      id: typeof actor.id === "string" ? actor.id : "anonymous",
      roles: Array.isArray(actor.roles)
        ? actor.roles.filter((r) => typeof r === "string")
        : [],
    };
  }
  return { id: "anonymous", roles: [] };
}
function actorFields(actor: { id: string; roles: string[] }) {
  return {
    id: { type: "string" as const, value: actor.id },
    roles: { type: "string" as const, array: true, value: actor.roles },
  };
}
function keysetPredicate(
  sort: Required<QuerySort>[],
  values: Record<string, unknown>,
  params: unknown[],
): string {
  const clauses: string[] = [];
  for (let i = 0; i < sort.length; i++) {
    const equals = sort.slice(0, i).map((s) => {
      params.push(values[s.field]);
      return `${qi(s.field)} = $${params.length}`;
    });
    const s = sort[i];
    params.push(values[s.field]);
    const op = s.direction === "desc" ? "<" : ">";
    clauses.push(
      `(${
        [...equals, `${qi(s.field)} ${op} $${params.length}`].join(" and ")
      })`,
    );
  }
  return clauses.join(" or ");
}
function cursorValues(
  row: Record<string, unknown>,
  sort: Required<QuerySort>[],
) {
  const values: Record<string, unknown> = {};
  for (const s of sort) values[s.field] = row[s.field];
  return values;
}
function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}
function decodeCursor(value: string): CursorPayload {
  try {
    const json = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") +
        "===".slice((value.length + 3) % 4),
    );
    const payload = JSON.parse(json);
    if (
      payload?.v !== 1 || typeof payload.digest !== "string" ||
      !payload.values || typeof payload.values !== "object"
    ) throw new Error("bad cursor");
    return payload;
  } catch {
    throw new QueryError(
      "bad_cursor",
      "cursor is not a valid Operant query cursor",
    );
  }
}
async function queryDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function actorPolicyDigest(actor: { id: string; roles: string[] }) {
  return `pending:${actor.id}:${actor.roles.slice().sort().join(",")}`;
}
function offsetParams(sql: string, offset: number) {
  return sql.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}
function splitId(id: string): [string | null, string | null] {
  const parts = String(id).split(".");
  return parts.length === 2 ? [parts[0], parts[1]] : [null, null];
}
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function qi(identifier: string): string {
  return quoteIdentifier(identifier);
}
class QueryError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
