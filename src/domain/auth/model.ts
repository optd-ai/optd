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

export type BootstrapResult = {
  user: {
    id: string;
    principalId: string;
    username: string;
    displayName: string;
  };
  credentials: IssuedCredentials;
};

export function immutableAuthContext(input: AuthContext): AuthContext {
  return Object.freeze({ ...input, roles: Object.freeze([...input.roles]) });
}
