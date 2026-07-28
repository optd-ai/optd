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
import type { DefinitionCatalog } from "../../ports/repair/repositories.ts";

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
export type ExpressionDefinitionPort = DefinitionCatalog<
  ExpressionValidationRequest["definition"],
  Record<string, FieldSpec>
>;

/** Validates and lowers public expressions; persistence only supplies fields. */
export function makeExpressionService(definitions: ExpressionDefinitionPort) {
  return Object.freeze({
    help(context = "query"): Result<{ context: string; help: string }> {
      return CONTEXTS.has(context)
        ? ok({ context, help: expressionHelp(context) })
        : err(validationError("bad_request", "unknown expression context"));
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
      const metadata = await definitions.definition(input.definition);
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
  });
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
    ]
      .every((item) => typeof item === "string");
}
