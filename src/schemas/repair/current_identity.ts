import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import { compileContract } from "../api/contracts.ts";

const NonEmptyString = Type.String({ minLength: 1 });

const PrincipalSchema = (type: "human_user" | "agent_user") =>
  Type.Object({
    id: NonEmptyString,
    type: Type.Literal(type),
  }, { additionalProperties: false });

export const CurrentHumanUserSchema = Type.Object({
  id: NonEmptyString,
  principal_id: NonEmptyString,
  username: NonEmptyString,
  display_name: NonEmptyString,
  status: Type.Union([Type.Literal("active"), Type.Literal("disabled")]),
}, { additionalProperties: false });

export const CurrentAgentSchema = Type.Object({
  id: NonEmptyString,
  principal_id: NonEmptyString,
  name: NonEmptyString,
  authorization_id: NonEmptyString,
  parent_authorization_id: Type.Optional(NonEmptyString),
  root_authorization_id: NonEmptyString,
  authorization_ancestry_ids: Type.Array(NonEmptyString),
}, { additionalProperties: false });

const AuthorizationBoundarySchema = Type.Union([
  Type.Object({
    type: Type.Literal("project"),
    project_id: NonEmptyString,
  }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("all_projects") }, {
    additionalProperties: false,
  }),
  Type.Object({ type: Type.Literal("system") }, {
    additionalProperties: false,
  }),
]);

const RoleAssignmentSchema = Type.Object({
  role: NonEmptyString,
  boundary: AuthorizationBoundarySchema,
}, { additionalProperties: false });

const SessionSchema = Type.Object({ id: NonEmptyString }, {
  additionalProperties: false,
});
const AuthContextSchema = Type.Object({
  id: NonEmptyString,
  active: Type.Boolean(),
}, { additionalProperties: false });
const HumanCredentialKindSchema = Type.Union([
  Type.Literal("human_full"),
  Type.Literal("authorization_request"),
]);

const Common = {
  human_user: CurrentHumanUserSchema,
  role_assignments: Type.Array(RoleAssignmentSchema),
  session: SessionSchema,
  auth_context: AuthContextSchema,
};

export const HumanCurrentIdentitySchema = Type.Object({
  credential_kind: HumanCredentialKindSchema,
  principal: PrincipalSchema("human_user"),
  ...Common,
}, { additionalProperties: false });

export const AgentCurrentIdentitySchema = Type.Object({
  credential_kind: Type.Literal("agent_authorization"),
  principal: PrincipalSchema("agent_user"),
  human_user: CurrentHumanUserSchema,
  agent: CurrentAgentSchema,
  role_assignments: Type.Array(RoleAssignmentSchema),
  session: SessionSchema,
  auth_context: AuthContextSchema,
}, { additionalProperties: false });

export const CurrentIdentitySchema = Type.Union([
  HumanCurrentIdentitySchema,
  AgentCurrentIdentitySchema,
]);

export type CurrentIdentityDto = Static<typeof CurrentIdentitySchema>;
export const currentIdentityContract = compileContract<CurrentIdentityDto>(
  CurrentIdentitySchema,
);
