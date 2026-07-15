export type CredentialKind = "human_full" | "authorization_request";

export type AuthContext = Readonly<{
  id: string;
  principalId: string;
  principalType: "human_user";
  humanUserId: string;
  sessionId: string;
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
  requestToken: string;
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

export type PasswordReset = {
  id: string;
  username: string;
  status: "pending" | "approved" | "denied" | "cancelled" | "completed";
  createdAt: string;
  expiresAt: string;
};

export function immutableAuthContext(input: AuthContext): AuthContext {
  return Object.freeze({ ...input, roles: Object.freeze([...input.roles]) });
}
