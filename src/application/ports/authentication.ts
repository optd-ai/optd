import type {
  AuthContext,
  BootstrapInput,
  BootstrapResult,
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
  login(username: string, password: string): Promise<Result<LoginResult>>;
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
}

export interface RequestAuthenticator {
  authenticate(token: string): Promise<Result<AuthContext>>;
}
