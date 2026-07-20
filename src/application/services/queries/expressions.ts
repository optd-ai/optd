import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import {
  ExpressionError,
  expressionHelp,
  type FieldSpec,
  lowerExpression,
} from "../../../domain/expressions/cel.ts";
import {
  query,
  type Queryable,
} from "../../../adapters/outbound/postgres/client.ts";

const CONTEXTS = new Set([
  "query",
  "policy",
  "partial-index",
  "constraint",
  "lifecycle",
  "action",
  "hook",
  "axi",
]);
export type ExpressionValidationRequest = {
  definition: {
    kind: "resource" | "relationship";
    publisher: string;
    pack: string;
    name: string;
  };
  context: string;
  expression: string;
};

export function makeExpressionService(sql: Queryable) {
  return {
    help(context = "query"): Result<{ context: string; help: string }> {
      if (!CONTEXTS.has(context)) {
        return err(
          validationError("bad_request", "unknown expression context"),
        );
      }
      return ok({ context, help: expressionHelp(context) });
    },
    async validate(
      input: unknown,
    ): Promise<Result<{ valid: true; context: string; normalized: unknown }>> {
      if (!isRequest(input)) {
        return err(
          validationError(
            "bad_request",
            "expression validation request is invalid",
          ),
        );
      }
      if (!CONTEXTS.has(input.context)) {
        return err(
          validationError("bad_request", "unknown expression context"),
        );
      }
      const metadata = await definition(sql, input.definition);
      if (!metadata) {
        return err({
          code: "not_found",
          message: "definition was not found",
          severity: "not_found",
        });
      }
      try {
        const actor = input.context === "policy"
          ? {
            id: {
              type: "string" as const,
              value: "00000000-0000-7000-8000-000000000001",
            },
            principal_type: { type: "string" as const, value: "human_user" },
            human_user_id: { type: "string" as const, value: null },
          }
          : undefined;
        const lowered = lowerExpression(input.expression, {
          fields: metadata,
          actor,
        });
        return ok({
          valid: true,
          context: input.context,
          normalized: lowered.normalized,
        });
      } catch (error) {
        if (!(error instanceof ExpressionError)) throw error;
        return err(validationError("bad_request", "expression is invalid", {
          issues: [{
            path: "/expression",
            code: error.code,
            message: error.message,
            ...error.details,
          }],
        }));
      }
    },
  };
}

async function definition(
  sql: Queryable,
  identity: ExpressionValidationRequest["definition"],
): Promise<Record<string, FieldSpec> | null> {
  const section = identity.kind === "resource" ? "resources" : "relationships";
  const result = await query<{ document: unknown }>(
    sql,
    `select jsonb_extract_path(cr.normalized,$4,$3) document
    from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
    where ar.publisher=$1 and ar.pack_name=$2`,
    [identity.publisher, identity.pack, identity.name, section],
  );
  const document = record(result.rows[0]?.document);
  if (!Object.keys(document).length) return null;
  const descriptors = record(record(document.spec).fields);
  const fields: Record<string, FieldSpec> = {
    id: { type: "string" },
    created_at: { type: "timestamp" },
    updated_at: { type: "timestamp" },
    archived_at: { type: "timestamp", nullable: true },
  };
  if (identity.kind === "relationship") {
    fields.from = { type: "string" };
    fields.to = { type: "string" };
  }
  for (const [name, value] of Object.entries(descriptors)) {
    const descriptor = record(value);
    const declared = String(descriptor.type);
    fields[name] = {
      type: (["integer", "decimal", "boolean", "date", "timestamp"].includes(
          declared,
        )
        ? declared
        : "string") as FieldSpec["type"],
      nullable: descriptor.required !== true,
    };
  }
  return fields;
}

function isRequest(value: unknown): value is ExpressionValidationRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).sort().join(",") !== "context,definition,expression"
  ) return false;
  const definition = request.definition;
  if (
    !definition || typeof definition !== "object" || Array.isArray(definition)
  ) return false;
  const identity = definition as Record<string, unknown>;
  return Object.keys(identity).sort().join(",") ===
      "kind,name,pack,publisher" &&
    (identity.kind === "resource" || identity.kind === "relationship") &&
    [
      identity.publisher,
      identity.pack,
      identity.name,
      request.context,
      request.expression,
    ].every((item) => typeof item === "string");
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
