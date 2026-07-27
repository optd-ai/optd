// deno-lint-ignore-file no-import-prefix
import { type Static, Type } from "npm:@sinclair/typebox@0.34.38";
import {
  compileContract,
  ContractValidationError,
  type ContractValidator,
  type ValidationIssue,
} from "../api/contracts.ts";

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

const HumanCredentialKindSchema = Type.Union([
  Type.Literal("human_full"),
  Type.Literal("authorization_request"),
]);

const Common = {
  human_user: CurrentHumanUserSchema,
  role_assignments: Type.Array(RoleAssignmentSchema),
  session_id: NonEmptyString,
  auth_context_id: NonEmptyString,
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
  session_id: NonEmptyString,
  auth_context_id: NonEmptyString,
}, { additionalProperties: false });

export const CurrentIdentitySchema = Type.Union([
  HumanCurrentIdentitySchema,
  AgentCurrentIdentitySchema,
]);

export type CurrentIdentityDto = Static<typeof CurrentIdentitySchema>;

const currentIdentityShape = compileContract<CurrentIdentityDto>(
  CurrentIdentitySchema,
);

function identityConsistencyIssues(
  value: CurrentIdentityDto,
): ValidationIssue[] {
  if (!("agent" in value)) {
    return value.principal.id === value.human_user.principal_id ? [] : [{
      path: "/human_user/principal_id",
      code: "identity_mismatch",
      message: "human principal IDs must match",
    }];
  }

  const issues: ValidationIssue[] = [];
  if (value.principal.id !== value.agent.principal_id) {
    issues.push({
      path: "/agent/principal_id",
      code: "identity_mismatch",
      message: "agent principal IDs must match",
    });
  }
  if (value.principal.id === value.human_user.principal_id) {
    issues.push({
      path: "/human_user/principal_id",
      code: "identity_mismatch",
      message: "agent principal and anchoring human principal must be distinct",
    });
  }
  return issues;
}

export const currentIdentityContract: ContractValidator<CurrentIdentityDto> = {
  check(value: unknown): value is CurrentIdentityDto {
    return currentIdentityShape.check(value) &&
      identityConsistencyIssues(value).length === 0;
  },
  issues(value: unknown): ValidationIssue[] {
    const shapeIssues = currentIdentityShape.issues(value);
    if (shapeIssues.length > 0) return shapeIssues;
    return identityConsistencyIssues(value as CurrentIdentityDto);
  },
  assert(value: unknown): asserts value is CurrentIdentityDto {
    const issues = currentIdentityContract.issues(value);
    if (issues.length > 0) throw new ContractValidationError(issues);
  },
};
