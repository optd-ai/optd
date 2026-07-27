export type PolicyActor = Readonly<{
  id: string;
  principal_type: "human_user" | "agent_user" | "system";
  human_user_id: string | null;
}>;

export type ServerDerivedPolicySubject =
  | Readonly<{
    principalType: "human_user";
    principalId: string;
    humanUserId: string;
  }>
  | Readonly<{
    principalType: "agent_user";
    principalId: string;
    humanUserId: string;
    authorizationId: string;
    authorizationActive: boolean;
  }>
  | Readonly<{
    principalType: "system";
    principalId: string;
  }>;

export class InvalidPolicySubjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPolicySubjectError";
  }
}

function required(value: string, field: string): string {
  if (value.trim().length === 0) {
    throw new InvalidPolicySubjectError(`${field} is required`);
  }
  return value;
}

/** Maps immutable, server-authenticated identity state into policy input. */
export function derivePolicyActor(
  subject: ServerDerivedPolicySubject,
): PolicyActor {
  const id = required(subject.principalId, "principalId");
  if (subject.principalType === "system") {
    return Object.freeze({
      id,
      principal_type: "system" as const,
      human_user_id: null,
    });
  }

  const humanUserId = required(subject.humanUserId, "humanUserId");
  if (
    subject.principalType === "agent_user" &&
    (!subject.authorizationActive ||
      subject.authorizationId.trim().length === 0)
  ) {
    throw new InvalidPolicySubjectError(
      "agent authorization lineage is not active",
    );
  }

  return Object.freeze({
    id,
    principal_type: subject.principalType,
    human_user_id: humanUserId,
  });
}
