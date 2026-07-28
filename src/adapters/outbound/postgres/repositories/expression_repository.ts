import type {
  ExpressionDefinitionPort,
  ExpressionValidationRequest,
} from "../../../../application/services/queries/expressions.ts";
import type { FieldSpec } from "../../../../domain/expressions/cel.ts";
import { query, type Queryable } from "../client.ts";

/** PostgreSQL expression-definition catalog; lowering stays in application. */
export function makePostgresExpressionDefinitionPort(
  sql: Queryable,
): ExpressionDefinitionPort {
  return {
    async definition(identity: ExpressionValidationRequest["definition"]) {
      const section = identity.kind === "resource"
        ? "resources"
        : "relationships";
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
          type:
            (["integer", "decimal", "boolean", "date", "timestamp"].includes(
                declared,
              )
              ? declared
              : "string") as FieldSpec["type"],
          nullable: descriptor.required !== true,
        };
      }
      return fields;
    },
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
