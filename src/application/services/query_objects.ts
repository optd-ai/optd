import type { AuthContext } from "../../domain/auth/model.ts";
import type { FieldSpec } from "../../domain/expressions/cel.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../domain/errors/result.ts";
import type { DefinitionIdentity } from "../../domain/objects/read.ts";
import {
  type QueryRequest,
  queryRequestContract,
  type QueryResponse,
  type ResolvedSort,
} from "../../schemas/queries/query.ts";
import type {
  QueryObjectRepository,
  QueryPolicyRepository,
  ReadSessionPort,
} from "../ports/repair/repositories.ts";

export type QueryObjectsRequest = QueryRequest;
export type QueryObjectsDto = QueryResponse;
export type ObjectPolicyEvaluation = Readonly<{
  allowed: boolean;
  policyDigest: string;
}>;
export type TargetedActionPolicyTarget = Readonly<{
  definition: DefinitionIdentity;
  objectId?: string;
}>;

export type QueryDefinition = Readonly<{
  revisionId: string;
  document: Readonly<Record<string, unknown>>;
  fields: Readonly<Record<string, FieldSpec>>;
  packFields: readonly string[];
  identity: string;
}>;

export type QueryCursorPosition = Readonly<{ values: unknown[]; id: string }>;

export type QueryPolicyFacts = Readonly<{
  policyDigest: string;
  normalizedWhere: unknown;
  visible: boolean;
  archivedVisible: boolean;
}>;

export type QueryPhysicalPage = Readonly<{
  rows: readonly Readonly<Record<string, unknown>>[];
  nextPosition: QueryCursorPosition | null;
  hasMore: boolean;
  total: number | null;
}>;

export type QueryExecutionPlan = Readonly<{
  request: QueryRequest;
  auth: AuthContext;
  definition: QueryDefinition;
  fields: readonly string[];
  sort: readonly ResolvedSort[];
  cursorPosition: QueryCursorPosition | null;
}>;

export interface QueryCursorPort {
  shapeDigest(value: unknown): Promise<string>;
  decode(
    cursor: string,
    shapeDigest: string,
    policyDigest: string,
    specs: readonly FieldSpec[],
  ): Promise<QueryCursorPosition>;
  encode(
    shapeDigest: string,
    policyDigest: string,
    position: QueryCursorPosition,
  ): Promise<string>;
}

export type QueryPhysicalFailureKind =
  | "hidden"
  | "invalid_expression"
  | "cursor_invalid"
  | "authority_invalid"
  | "invalid_data"
  | "unexpected";

export class QueryPhysicalError extends Error {
  constructor(
    readonly kind: QueryPhysicalFailureKind,
    readonly context?: unknown,
  ) {
    super(kind);
    this.name = "QueryPhysicalError";
  }
}

export class QueryRepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type QueryPagePort =
  & QueryPolicyRepository<
    QueryExecutionPlan,
    QueryPhysicalPage
  >
  & Pick<
    QueryObjectRepository<
      QueryExecutionPlan,
      QueryPhysicalPage,
      never,
      never,
      never,
      never
    >,
    "query"
  >;

export type QueryReadSession = Readonly<{
  projectExists: boolean;
  definition(): Promise<QueryDefinition | null>;
  authorize(
    plan: Omit<QueryExecutionPlan, "cursorPosition">,
  ): Promise<QueryPolicyFacts>;
  page: QueryPagePort;
}>;

/**
 * Same-transaction read session. The adapter locks immutable authority before
 * invoking application orchestration and retains every physical handle.
 */
export type QueryReadSessionPort = ReadSessionPort<
  Readonly<{ input: QueryRequest; auth: AuthContext }>,
  QueryReadSession
>;

/** Application-owned public query use case over a same-session read port. */
export function makeQueryObjectsService(
  port: QueryReadSessionPort,
  cursorFactory: () => QueryCursorPort,
) {
  let cursorPort: QueryCursorPort | undefined;
  const queryCursors = () => cursorPort ??= cursorFactory();
  return Object.freeze({
    async query(
      input: unknown,
      auth?: AuthContext,
    ): Promise<Result<QueryResponse>> {
      try {
        if (!auth) {
          throw new QueryRepositoryError(
            "authentication_required",
            "authentication is required",
          );
        }
        const issues = queryRequestContract.issues(input);
        if (issues.length) {
          throw new QueryRepositoryError(
            "bad_request",
            "query request is invalid",
            { issues },
          );
        }
        const request = input as QueryRequest;
        const response = await port.execute(
          { input: request, auth },
          async (session) => {
            if (!session.projectExists) throw hidden();
            const definition = await session.definition();
            if (!definition) throw hidden();
            const fields = resolveFields(request.fields, definition);
            const sort = resolveSort(request.sort, definition);
            const policy = await session.authorize({
              request,
              auth,
              definition,
              fields,
              sort,
            });
            if (
              !request.cursor &&
              (!policy.visible ||
                (request.include_archived && !policy.archivedVisible))
            ) {
              throw hidden();
            }
            const cursors = queryCursors();
            const shapeDigest = await cursors.shapeDigest({
              project_id: request.project_id,
              definition: request.definition,
              revision_id: definition.revisionId,
              where: policy.normalizedWhere,
              fields,
              sort,
              limit: request.limit ?? 50,
              include_archived: request.include_archived ?? false,
              include_total: request.include_total ?? false,
            });
            let cursorPosition: QueryCursorPosition | null = null;
            if (request.cursor) {
              try {
                cursorPosition = await cursors.decode(
                  request.cursor,
                  shapeDigest,
                  policy.policyDigest,
                  sort.map((item) => definition.fields[item.field]),
                );
              } catch {
                throw new QueryPhysicalError("cursor_invalid");
              }
            }
            const page = await session.page.query({
              request,
              auth,
              definition,
              fields,
              sort,
              cursorPosition,
            });
            const nextCursor = page.nextPosition
              ? await cursors.encode(
                shapeDigest,
                policy.policyDigest,
                page.nextPosition,
              )
              : null;
            return {
              items: page.rows.map((row) =>
                queryRowDto(row, request, definition, fields)
              ),
              resolved_fields: fields,
              resolved_sort: sort,
              next_cursor: nextCursor,
              has_more: page.hasMore,
              total: page.total,
              policy_context_digest: policy.policyDigest,
            };
          },
        );
        return ok(response);
      } catch (error) {
        const failure = error instanceof QueryRepositoryError
          ? error
          : error instanceof QueryPhysicalError
          ? mapPhysicalFailure(error)
          : new QueryRepositoryError(
            "internal_error",
            "query could not be completed",
          );
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
  });
}

function mapPhysicalFailure(error: QueryPhysicalError): QueryRepositoryError {
  switch (error.kind) {
    case "hidden":
      return hidden();
    case "invalid_expression":
      return new QueryRepositoryError(
        "bad_request",
        "query expression is invalid",
        error.context,
      );
    case "cursor_invalid":
      return new QueryRepositoryError(
        "invalid_cursor",
        "query cursor is invalid or stale",
      );
    case "authority_invalid":
      return new QueryRepositoryError(
        "credential_invalid",
        "credential authority is no longer valid",
      );
    case "invalid_data":
    case "unexpected":
      return new QueryRepositoryError(
        "internal_error",
        "query could not be completed",
      );
  }
}

function resolveFields(
  requested: string[] | undefined,
  definition: QueryDefinition,
): string[] {
  if (requested) {
    rejectDuplicates(requested, "projection");
    for (const field of requested) {
      if (!definition.packFields.includes(field)) {
        throw new QueryRepositoryError(
          "bad_request",
          `unknown projection field ${field}`,
        );
      }
    }
    return requested;
  }
  const list = record(record(record(definition.document.spec).axi).list);
  const axi = Array.isArray(list.fields)
    ? list.fields.map(String).filter((field) =>
      field !== "id" && definition.packFields.includes(field)
    )
    : [];
  return axi.length ? axi : definition.packFields.slice(0, 20);
}

function resolveSort(
  input: QueryRequest["sort"],
  definition: QueryDefinition,
): ResolvedSort[] {
  const raw = input ?? [{ field: "updated_at", direction: "desc" as const }];
  rejectDuplicates(raw.map((item) => item.field), "sort");
  for (const item of raw) {
    if (item.field === "id") {
      throw new QueryRepositoryError(
        "bad_request",
        "id is an implicit sort tie-breaker",
      );
    }
    if (!definition.fields[item.field]) {
      throw new QueryRepositoryError(
        "bad_request",
        `unknown sort field ${item.field}`,
      );
    }
  }
  return [
    ...raw,
    { field: "id", direction: raw[raw.length - 1].direction },
  ];
}

function rejectDuplicates(values: readonly string[], kind: string): void {
  if (new Set(values).size !== values.length) {
    throw new QueryRepositoryError(
      "bad_request",
      `${kind} fields must not contain duplicates`,
    );
  }
}

function queryRowDto(
  row: Readonly<Record<string, unknown>>,
  request: QueryRequest,
  definition: QueryDefinition,
  fields: readonly string[],
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
  const projected = Object.fromEntries(fields.map((field) => [
    field,
    typedQueryValue(row, field, definition.fields[field]),
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

function typedQueryValue(
  row: Readonly<Record<string, unknown>>,
  field: string,
  spec: FieldSpec | undefined,
): unknown {
  let found = row[field];
  if (typeof found === "bigint") found = Number(found);
  if (found instanceof Date) found = found.toISOString();
  if (spec?.type === "decimal") return canonicalDecimal(found);
  if (spec?.type === "timestamp" && found !== null) {
    const instant = new Date(String(found));
    if (Number.isNaN(instant.getTime())) {
      throw new QueryRepositoryError(
        "internal_error",
        "database timestamp is invalid",
      );
    }
    return instant.toISOString();
  }
  if (spec?.type === "integer" && found !== null) {
    if (typeof found !== "string" || !/^-?[0-9]+$/.test(found)) {
      throw new QueryRepositoryError(
        "internal_error",
        "database integer was not returned as text",
      );
    }
    const integer = BigInt(found);
    if (
      integer > BigInt(Number.MAX_SAFE_INTEGER) ||
      integer < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      throw new QueryRepositoryError(
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
    throw new QueryRepositoryError(
      "internal_error",
      "database decimal was not returned as text",
    );
  }
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value)) {
    throw new QueryRepositoryError(
      "internal_error",
      "database returned a non-canonical decimal",
    );
  }
  const [integer, fraction = ""] = value.split(".");
  const trimmed = fraction.replace(/0+$/, "");
  const normalized = trimmed ? `${integer}.${trimmed}` : integer;
  return /^-0(?:\.0*)?$/.test(normalized) ? "0" : normalized;
}

function timestamp(value: unknown): string | null {
  if (value == null) return null;
  const instant = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(instant.getTime())
    ? String(value)
    : instant.toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hidden(): QueryRepositoryError {
  return new QueryRepositoryError(
    "not_found",
    "requested project or definition was not found",
  );
}
