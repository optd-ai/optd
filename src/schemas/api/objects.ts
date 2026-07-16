import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract, strictObject } from "./contracts.ts";

const UuidV7 = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
const CanonicalPublisher = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const CanonicalName = Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" });
const UtcTimestamp = Type.String({
  pattern:
    "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$",
});
const Identity = strictObject({
  publisher: CanonicalPublisher,
  pack: CanonicalName,
  name: CanonicalName,
  revision_id: UuidV7,
});
const Fields = Type.Record(
  Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" }),
  Type.Unknown(),
);

export const ObjectDtoSchema = strictObject({
  kind: Type.Literal("object"),
  id: UuidV7,
  project_id: UuidV7,
  resource: Identity,
  version: Type.Integer({ minimum: 1 }),
  object_version_id: UuidV7,
  data: Fields,
  archived_at: Type.Union([UtcTimestamp, Type.Null()]),
  created_at: UtcTimestamp,
  updated_at: UtcTimestamp,
});
export const RelationshipDtoSchema = strictObject({
  kind: Type.Literal("relationship"),
  id: UuidV7,
  project_id: UuidV7,
  relationship: Identity,
  version: Type.Integer({ minimum: 1 }),
  object_version_id: UuidV7,
  from: UuidV7,
  to: UuidV7,
  fields: Fields,
  archived_at: Type.Union([UtcTimestamp, Type.Null()]),
  created_at: UtcTimestamp,
  updated_at: UtcTimestamp,
});
const Provenance = strictObject({
  changeset_commit_id: UuidV7,
  auth_context_id: UuidV7,
});
const VersionBase = {
  object_version_id: UuidV7,
  version: Type.Integer({ minimum: 1 }),
  operation: Type.Union([
    Type.Literal("create"),
    Type.Literal("update"),
    Type.Literal("archive"),
    Type.Literal("transition"),
    Type.Literal("link"),
    Type.Literal("unlink"),
  ]),
  provenance: Provenance,
  changed_fields: Type.Array(CanonicalName, { uniqueItems: true }),
  archived_at: Type.Union([UtcTimestamp, Type.Null()]),
  created_at: UtcTimestamp,
};
export const ObjectVersionEntrySchema = strictObject({
  kind: Type.Literal("object_version"),
  ...VersionBase,
  data: Fields,
});
export const RelationshipVersionEntrySchema = strictObject({
  kind: Type.Literal("object_version"),
  ...VersionBase,
  from: UuidV7,
  to: UuidV7,
  fields: Fields,
});
export const CommentEntrySchema = strictObject({
  kind: Type.Literal("comment"),
  comment_id: UuidV7,
  body: Type.String({ minLength: 1, maxLength: 10000 }),
  target_object_version_id: UuidV7,
  provenance: Provenance,
  created_at: UtcTimestamp,
});
export const HistoryEntrySchema = Type.Union([
  ObjectVersionEntrySchema,
  RelationshipVersionEntrySchema,
  CommentEntrySchema,
]);
export const HistoryDtoSchema = strictObject({
  items: Type.Array(HistoryEntrySchema),
});

export type ObjectDto = Static<typeof ObjectDtoSchema>;
export type RelationshipDto = Static<typeof RelationshipDtoSchema>;
export type HistoryEntry = Static<typeof HistoryEntrySchema>;
export const objectDtoContract = compileContract<ObjectDto>(ObjectDtoSchema);
export const relationshipDtoContract = compileContract<RelationshipDto>(
  RelationshipDtoSchema,
);
export const historyEntryContract = compileContract<HistoryEntry>(
  HistoryEntrySchema,
);
