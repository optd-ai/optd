export type CredentialKind =
  | "human_full"
  | "authorization_request"
  | "agent_authorization";

export type AuthorizationBoundary =
  | { type: "project"; projectId: string }
  | { type: "all_projects" }
  | { type: "system" };

export type RoleAssignment = {
  role: string;
  boundary: AuthorizationBoundary;
};

export type AuthContext = Readonly<{
  id: string;
  principalId: string;
  principalType: "human_user" | "agent_user";
  humanUserId: string;
  sessionId: string;
  authorizationId?: string;
  credentialKind: CredentialKind;
  roles: readonly string[];
  createdAt: string;
}>;

export type BootstrapInput = {
  bootstrapToken: string;
  username: string;
  displayName: string;
  password: string;
};

export type IssuedCredentials = {
  token: string;
  fullSessionId: string;
  requestToken?: string;
  requestSessionId: string;
  requestRetained: boolean;
};

export type HumanUser = {
  id: string;
  principalId: string;
  username: string;
  displayName: string;
  status: "active" | "disabled";
};

export type HumanSession = {
  id: string;
  credentialKind: CredentialKind;
  createdAt: string;
  current: boolean;
};

export type CurrentIdentity = {
  credentialKind: CredentialKind;
  principalType: "human_user" | "agent_user";
  principalId: string;
  humanUser: HumanUser;
  agent?: {
    id: string;
    principalId: string;
    name: string;
    authorizationId: string;
    parentAuthorizationId?: string;
    rootAuthorizationId: string;
    authorizationAncestryIds: string[];
  };
  roleAssignments: RoleAssignment[];
  sessionId: string;
  authContextId: string;
  active: boolean;
};

export type LoginResult = {
  user: HumanUser;
  credentials: IssuedCredentials;
};

export type BootstrapResult = LoginResult;

export type PasswordPolicy = {
  minimumLength: number;
  maximumBytes: 1024;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
};

export type AgentAuthorizationRequest = {
  id: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "invalidated";
  version: number;
  roles: string[];
  boundary: AuthorizationBoundary;
  reason: string;
  denialReason?: string;
  agentName?: string;
  createdAt: string;
  alreadyAuthorized?: boolean;
  authorizationId?: string;
};

export type AgentAuthorization = {
  id: string;
  agentUserId: string;
  humanUserId: string;
  parentAuthorizationId?: string;
  rootAuthorizationId: string;
  roleAssignments: RoleAssignment[];
  active: boolean;
  createdAt: string;
};

export type PasswordReset = {
  id: string;
  username: string;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "cancelled"
    | "completed"
    | "expired";
  createdAt: string;
  expiresAt: string;
};

export function immutableAuthContext(input: AuthContext): AuthContext {
  return Object.freeze({ ...input, roles: Object.freeze([...input.roles]) });
}
