import type {
  AgentAuthorization,
  AgentAuthorizationRequest,
  AuthContext,
  AuthorizationBoundary,
  BootstrapInput,
  BootstrapResult,
  CurrentIdentity,
  HumanSession,
  HumanUser,
  LoginResult,
  PasswordReset,
} from "../../domain/auth/model.ts";
import type { Result } from "../../domain/errors/result.ts";

export type BootstrapStatus =
  | "bootstrap_required"
  | "bootstrap_in_progress"
  | "active";

export interface BootstrapRepository {
  bootstrap(input: BootstrapInput): Promise<Result<BootstrapResult>>;
  bootstrapStatus(): Promise<Result<BootstrapStatus>>;
}

export interface AuthRepository extends BootstrapRepository {
  authenticate(token: string): Promise<Result<AuthContext>>;
  login(
    username: string,
    password: string,
    existingRequestSessionId?: string,
  ): Promise<Result<LoginResult>>;
  currentIdentity(auth: AuthContext): Promise<Result<CurrentIdentity>>;
  current(auth: AuthContext): Promise<Result<HumanUser>>;
  sessions(auth: AuthContext): Promise<Result<HumanSession[]>>;
  logout(auth: AuthContext): Promise<Result<{ revoked: true }>>;
  logoutAll(
    auth: AuthContext,
    password: string,
  ): Promise<Result<{ revoked: number }>>;
  changePassword(
    auth: AuthContext,
    currentPassword: string,
    newPassword: string,
  ): Promise<Result<LoginResult>>;
  listUsers(auth: AuthContext): Promise<Result<HumanUser[]>>;
  createUser(
    auth: AuthContext,
    input: { username: string; displayName: string; password: string },
  ): Promise<Result<HumanUser>>;
  setUserStatus(
    auth: AuthContext,
    userId: string,
    status: "active" | "disabled",
  ): Promise<Result<HumanUser>>;
  createPasswordReset(input: {
    username: string;
    nonceHash: string;
    idempotencyKey: string;
  }): Promise<Result<{ requestId: string }>>;
  createPasswordResetWatchTicket(
    id: string,
    nonce: string,
  ): Promise<Result<{ ticket: string }>>;
  consumePasswordResetWatchTicket(
    id: string,
    ticket: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  >;
  passwordResetStatus(
    id: string,
  ): Promise<
    Result<
      { requestId: string; version: number; status: PasswordReset["status"] }
    >
  >;
  subscribePasswordReset(id: string, listener: () => void): () => void;
  inspectPasswordReset(
    auth: AuthContext,
    id: string,
  ): Promise<Result<PasswordReset>>;
  decidePasswordReset(
    auth: AuthContext,
    id: string,
    decision: "approved" | "denied",
  ): Promise<Result<PasswordReset>>;
  cancelPasswordReset(
    id: string,
    nonce: string,
  ): Promise<Result<PasswordReset>>;
  redeemPasswordReset(
    id: string,
    nonce: string,
  ): Promise<Result<{ capability: string }>>;
  completePasswordReset(
    id: string,
    capability: string,
    password: string,
  ): Promise<Result<LoginResult>>;
  beginRecovery(input: {
    username: string;
    token: string;
    enableUser: boolean;
    restoreSuperAdmin: boolean;
    replace?: boolean;
  }): Promise<Result<{ challengeId: string }>>;
  cancelRecovery(username: string): Promise<Result<{ cancelled: true }>>;
  completeRecovery(input: {
    username: string;
    token: string;
    password: string;
  }): Promise<Result<LoginResult>>;
  discoverRoles(
    auth: AuthContext,
    boundary: AuthorizationBoundary,
  ): Promise<Result<{ roles: string[]; boundary: AuthorizationBoundary }>>;
  createAuthorizationRequest(auth: AuthContext, input: {
    roles: string[];
    boundary: AuthorizationBoundary;
    reason: string;
    nonceHash: string;
    idempotencyKey: string;
    agentName?: string;
  }): Promise<Result<AgentAuthorizationRequest>>;
  inspectAuthorizationRequest(
    auth: AuthContext,
    id: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  decideAuthorizationRequest(auth: AuthContext, id: string, input: {
    decision: "approved" | "denied";
    reason?: string;
    agentName?: string;
    capabilitySummaryDigest?: string;
  }): Promise<Result<AgentAuthorizationRequest>>;
  cancelAuthorizationRequest(
    auth: AuthContext,
    id: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  createAuthorizationWatchTicket(
    auth: AuthContext,
    id: string,
  ): Promise<Result<{ ticket: string }>>;
  consumeAuthorizationWatchTicket(
    id: string,
    ticket: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  authorizationRequestStatus(
    id: string,
  ): Promise<Result<AgentAuthorizationRequest>>;
  subscribeAuthorizationRequest(id: string, listener: () => void): () => void;
  redeemAuthorizationRequest(
    auth: AuthContext,
    id: string,
    nonce: string,
  ): Promise<
    Result<{
      authorization: AgentAuthorization;
      token: string;
    }>
  >;
  listAuthorizations(auth: AuthContext): Promise<Result<AgentAuthorization[]>>;
  revokeAuthorization(
    auth: AuthContext,
    id: string,
  ): Promise<Result<{ revoked: true }>>;
}

export type AgentAuthorizationGrantabilitySnapshot = {
  roleDefinitionVersions: ReadonlyArray<{
    role: string;
    versionId: string;
    version: number;
  }>;
  policyDefinitionVersions: ReadonlyArray<{
    policy: string;
    versionId: string;
    version: number;
  }>;
  capabilitySummaryDigest: string;
};

export interface AgentAuthorizationGrantabilityState {
  current(input: {
    auth: AuthContext;
    roles: readonly string[];
    boundary: AuthorizationBoundary;
  }): Promise<
    Result<{
      superAdmin: boolean;
      canDecide: boolean;
      effectiveRoles: readonly string[];
      snapshot: AgentAuthorizationGrantabilitySnapshot;
    }>
  >;
}

export interface AgentAuthorizationGrantability {
  canDecide(input: {
    auth: AuthContext;
    decision: "approved" | "denied";
    roles: readonly string[];
    boundary: AuthorizationBoundary;
    state: AgentAuthorizationGrantabilityState;
  }): Promise<Result<AgentAuthorizationGrantabilitySnapshot>>;
}

export interface RequestAuthenticator {
  authenticate(token: string): Promise<Result<AuthContext>>;
}
