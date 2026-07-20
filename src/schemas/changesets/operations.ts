import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract, strictObject } from "../api/contracts.ts";

export const UuidV7Schema = Type.String({
  pattern:
    "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
});
export const QualifiedIdentitySchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62}$",
});
const LocalKey = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_-]{0,127}$" });
const FieldName = Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" });
const Fields = Type.Record(FieldName, Type.Unknown());
const Ref = strictObject({
  $ref: Type.String({
    pattern:
      "^[A-Za-z][A-Za-z0-9_-]{0,127}\\.(?:object_id|relationship_id|comment_id)$",
  }),
});
const IdOrRef = Type.Union([UuidV7Schema, Ref]);
const common = {
  key: Type.Optional(LocalKey),
  project_id: Type.Optional(UuidV7Schema),
};
const mutation = {
  expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
  set: Type.Optional(Fields),
  unset: Type.Optional(Type.Array(FieldName, { uniqueItems: true })),
};

export const AuthoredCreateSchema = strictObject({
  op: Type.Literal("create"),
  ...common,
  resource: QualifiedIdentitySchema,
  fields: Fields,
});
export const AuthoredUpdateSchema = strictObject({
  op: Type.Literal("update"),
  ...common,
  resource: QualifiedIdentitySchema,
  object_id: IdOrRef,
  ...mutation,
});
export const AuthoredTransitionSchema = strictObject({
  op: Type.Literal("transition"),
  ...common,
  resource: QualifiedIdentitySchema,
  object_id: IdOrRef,
  to: FieldName,
  ...mutation,
});
export const AuthoredArchiveSchema = strictObject({
  op: Type.Literal("archive"),
  ...common,
  resource: QualifiedIdentitySchema,
  object_id: IdOrRef,
  expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const AuthoredLinkSchema = strictObject({
  op: Type.Literal("link"),
  ...common,
  relationship: QualifiedIdentitySchema,
  from: IdOrRef,
  to: IdOrRef,
  fields: Type.Optional(Fields),
});
export const AuthoredUnlinkSchema = strictObject({
  op: Type.Literal("unlink"),
  ...common,
  relationship: QualifiedIdentitySchema,
  relationship_id: UuidV7Schema,
  expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const AuthoredCommentSchema = strictObject({
  op: Type.Literal("comment"),
  ...common,
  resource: QualifiedIdentitySchema,
  object_id: IdOrRef,
  body: Type.String({ minLength: 1, pattern: ".*\\S.*" }),
});
export const AuthoredOperationSchema = Type.Union([
  AuthoredCreateSchema,
  AuthoredUpdateSchema,
  AuthoredTransitionSchema,
  AuthoredArchiveSchema,
  AuthoredLinkSchema,
  AuthoredUnlinkSchema,
  AuthoredCommentSchema,
]);
const resolvedCommon = { key: LocalKey, project_id: UuidV7Schema };
const resolvedMutation = {
  expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
  set: Type.Optional(Fields),
  unset: Type.Optional(Type.Array(FieldName, { uniqueItems: true })),
};
export const ResolvedOperationSchema = Type.Union([
  strictObject({
    op: Type.Literal("create"),
    ...resolvedCommon,
    resource: QualifiedIdentitySchema,
    object_id: UuidV7Schema,
    fields: Fields,
  }),
  strictObject({
    op: Type.Literal("update"),
    ...resolvedCommon,
    resource: QualifiedIdentitySchema,
    object_id: UuidV7Schema,
    ...resolvedMutation,
  }),
  strictObject({
    op: Type.Literal("transition"),
    ...resolvedCommon,
    resource: QualifiedIdentitySchema,
    object_id: UuidV7Schema,
    to: FieldName,
    ...resolvedMutation,
  }),
  strictObject({
    op: Type.Literal("archive"),
    ...resolvedCommon,
    resource: QualifiedIdentitySchema,
    object_id: UuidV7Schema,
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  strictObject({
    op: Type.Literal("link"),
    ...resolvedCommon,
    relationship: QualifiedIdentitySchema,
    relationship_id: UuidV7Schema,
    from: UuidV7Schema,
    to: UuidV7Schema,
    fields: Type.Optional(Fields),
  }),
  strictObject({
    op: Type.Literal("unlink"),
    ...resolvedCommon,
    relationship: QualifiedIdentitySchema,
    relationship_id: UuidV7Schema,
    expected_version: Type.Optional(Type.Integer({ minimum: 1 })),
  }),
  strictObject({
    op: Type.Literal("comment"),
    ...resolvedCommon,
    resource: QualifiedIdentitySchema,
    object_id: UuidV7Schema,
    comment_id: UuidV7Schema,
    body: Type.String({ minLength: 1 }),
  }),
]);
export const StageRequestSchema = strictObject({
  project_id: Type.Optional(UuidV7Schema),
  operations: Type.Array(AuthoredOperationSchema, {
    minItems: 1,
    maxItems: 10000,
  }),
});
export const authoredOperationContract = compileContract<AuthoredOperation>(
  AuthoredOperationSchema,
);
export const resolvedOperationContract = compileContract<ResolvedOperation>(
  ResolvedOperationSchema,
);
export const stageRequestContract = compileContract<StageRequest>(
  StageRequestSchema,
);
export type AuthoredOperation = Static<typeof AuthoredOperationSchema>;
export type ResolvedOperation = Static<typeof ResolvedOperationSchema>;
export type StageRequest = Static<typeof StageRequestSchema>;
