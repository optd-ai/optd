import type { AuthorizationBoundary } from "../auth/model.ts";

export type RoleDefinition = {
  id: string;
  versionId: string;
  version: number;
  displayName: string;
  description?: string;
  axiSummary?: string;
  active: boolean;
};

export type RoleAssignmentRecord = {
  id: string;
  userId: string;
  principalId: string;
  role: string;
  boundary: AuthorizationBoundary;
  active: boolean;
  version: number;
  createdAt: string;
  disabledAt?: string;
};

export type PolicyAssignmentRecord = {
  id: string;
  policy: string;
  policyRevisionId: string;
  boundary: AuthorizationBoundary;
  active: boolean;
  version: number;
  source: "operator" | "pack_default" | "platform";
  createdAt: string;
  disabledAt?: string;
};

export type CapabilityCondition = "unconditional" | "abac" | "rebac";

export type Capability = {
  action: string;
  resource: string;
  condition: CapabilityCondition;
  policy: string;
  policyRevisionId: string;
  ruleId: string;
  summary?: string;
};

export type BoundaryAuthority = {
  authContextId: string;
  principal: {
    id: string;
    type: "human_user" | "agent_user";
    humanUserId: string;
  };
  boundary: AuthorizationBoundary;
  effectiveRoles: string[];
  superAdmin: boolean;
  capabilities: Capability[];
  digest: string;
};
