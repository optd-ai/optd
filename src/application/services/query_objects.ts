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

export type QueryExecutionPlan = Readonly<{
  request: QueryRequest;
  auth: AuthContext;
  definition: QueryDefinition;
  fields: readonly string[];
  sort: readonly ResolvedSort[];
}>;

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
    QueryResponse
  >
  & Pick<
    QueryObjectRepository<
      QueryExecutionPlan,
      QueryResponse,
      never,
      never,
      never,
      never
    >,
    "query"
  >;

export type QueryReadSession = Readonly<{
  definition(): Promise<QueryDefinition | null>;
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
export function makeQueryObjectsService(port: QueryReadSessionPort) {
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
            const definition = await session.definition();
            if (!definition) throw hidden();
            const fields = resolveFields(request.fields, definition);
            const sort = resolveSort(request.sort, definition);
            return await session.page.query({
              request,
              auth,
              definition,
              fields,
              sort,
            });
          },
        );
        return ok(response);
      } catch (error) {
        const failure = error instanceof QueryRepositoryError
          ? error
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
