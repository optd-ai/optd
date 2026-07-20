import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract, strictObject } from "../api/contracts.ts";

const Name = Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" });
const Publisher = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const UuidV7 = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const QueryRequestSchema = strictObject({
  project_id: UuidV7,
  definition: strictObject({
    kind: Type.Union([Type.Literal("resource"), Type.Literal("relationship")]),
    publisher: Publisher,
    pack: Name,
    name: Name,
  }),
  where: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  fields: Type.Optional(Type.Array(Name, { maxItems: 100 })),
  sort: Type.Optional(
    Type.Array(
      strictObject({
        field: Name,
        direction: Type.Union([Type.Literal("asc"), Type.Literal("desc")]),
      }),
      { minItems: 1, maxItems: 10 },
    ),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(
    Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  ),
  include_archived: Type.Optional(Type.Boolean()),
  include_total: Type.Optional(Type.Boolean()),
});
export type QueryRequest = Static<typeof QueryRequestSchema>;
export const queryRequestContract = compileContract<QueryRequest>(
  QueryRequestSchema,
);

export type ResolvedSort = { field: string; direction: "asc" | "desc" };
export type QueryResponse = {
  items: Record<string, unknown>[];
  resolved_fields: string[];
  resolved_sort: ResolvedSort[];
  next_cursor: string | null;
  has_more: boolean;
  total: number | null;
  policy_context_digest: string;
};
