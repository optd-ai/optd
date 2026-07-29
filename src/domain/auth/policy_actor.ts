import type { AuthContext } from "./model.ts";

export type AuthPolicyActor = Readonly<{
  id: string;
  principal_type: "human_user" | "agent_user";
  human_user_id: string;
}>;

export class InvalidAuthContextActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthContextActorError";
  }
}

function required(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new InvalidAuthContextActorError(`${field} is required`);
  }
  return value;
}

/** Derives the only policy actor shape from an immutable authenticated context. */
export function policyActorFromAuthContext(
  auth: AuthContext,
): AuthPolicyActor {
  const id = required(auth.principalId, "principalId");
  const humanUserId = required(auth.humanUserId, "humanUserId");
  required(auth.id, "authContextId");
  required(auth.sessionId, "sessionId");

  const agent = auth.principalType === "agent_user";
  if (
    agent !== (auth.credentialKind === "agent_authorization") ||
    agent !== (auth.authorizationId !== undefined) ||
    (auth.authorizationId !== undefined && auth.authorizationId.trim() === "")
  ) {
    throw new InvalidAuthContextActorError(
      "authenticated principal and authorization are inconsistent",
    );
  }

  return Object.freeze({
    id,
    principal_type: auth.principalType,
    human_user_id: humanUserId,
  });
}
