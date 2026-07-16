import { Type } from "npm:@sinclair/typebox";

export const AuthorizationBoundarySchema = Type.Union([
  Type.Object({
    type: Type.Literal("project"),
    project_id: Type.String({ format: "uuid" }),
  }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("all_projects") }, {
    additionalProperties: false,
  }),
  Type.Object({ type: Type.Literal("system") }, {
    additionalProperties: false,
  }),
]);

export const RoleAssignmentCreateSchema = Type.Object({
  role: Type.String({
    pattern:
      "^(system:[a-z][a-z0-9_]*|[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:[a-z][a-z0-9_]*)$",
  }),
  boundary: AuthorizationBoundarySchema,
}, { additionalProperties: false });

export const PolicyAssignmentCreateSchema = Type.Object({
  policy_revision_id: Type.String({ format: "uuid" }),
  boundary: AuthorizationBoundarySchema,
}, { additionalProperties: false });

export const AssignmentDisableSchema = Type.Object({
  expected_version: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
