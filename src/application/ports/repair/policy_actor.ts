export type PolicyActor = Readonly<{
  id: string;
  principal_type: "human_user" | "agent_user" | "system";
  human_user_id: string | null;
}>;

export type AuthorizationLineageFact = Readonly<{
  id: string;
  parentAuthorizationId: string | null;
  rootAuthorizationId: string;
  status: "active" | "revoked" | "replaced";
  replacedByAuthorizationId?: string;
}>;

export type ServerDerivedAuthorizationLineage = Readonly<{
  currentAuthorizationId: string;
  rootAuthorizationId: string;
  /** Canonical root-to-current path, inclusive. */
  authorizationAncestryIds: readonly string[];
  facts: readonly AuthorizationLineageFact[];
  /** Set only when the current authorization is a server-issued replacement. */
  replacesAuthorizationId?: string;
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
    authorization: ServerDerivedAuthorizationLineage;
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

function assertActiveAuthorizationLineage(
  lineage: ServerDerivedAuthorizationLineage,
): void {
  const current = required(
    lineage.currentAuthorizationId,
    "currentAuthorizationId",
  );
  const root = required(lineage.rootAuthorizationId, "rootAuthorizationId");
  const ancestry = lineage.authorizationAncestryIds;
  if (
    ancestry.length === 0 || ancestry[0] !== root ||
    ancestry[ancestry.length - 1] !== current ||
    new Set(ancestry).size !== ancestry.length
  ) {
    throw new InvalidPolicySubjectError(
      "agent authorization ancestry is invalid",
    );
  }

  const facts = new Map<string, AuthorizationLineageFact>();
  for (const fact of lineage.facts) {
    const id = required(fact.id, "authorization fact id");
    required(
      fact.rootAuthorizationId,
      "authorization fact rootAuthorizationId",
    );
    if (facts.has(id)) {
      throw new InvalidPolicySubjectError(
        "agent authorization lineage contains duplicate facts",
      );
    }
    if (
      (fact.status === "replaced") !==
        (fact.replacedByAuthorizationId !== undefined)
    ) {
      throw new InvalidPolicySubjectError(
        "agent authorization lineage contains contradictory facts",
      );
    }
    facts.set(id, fact);
  }
  for (let index = 0; index < ancestry.length; index++) {
    const id = ancestry[index];
    const fact = facts.get(id);
    const expectedParent = index === 0 ? null : ancestry[index - 1];
    if (
      !fact || fact.rootAuthorizationId !== root ||
      fact.parentAuthorizationId !== expectedParent || fact.status !== "active"
    ) {
      throw new InvalidPolicySubjectError(
        "agent authorization lineage is not active",
      );
    }
  }

  if (lineage.replacesAuthorizationId !== undefined) {
    const replacedId = required(
      lineage.replacesAuthorizationId,
      "replacesAuthorizationId",
    );
    const replaced = facts.get(replacedId);
    if (
      ancestry.includes(replacedId) || !replaced ||
      replaced.status !== "replaced" ||
      replaced.replacedByAuthorizationId !== current ||
      replaced.rootAuthorizationId !== root
    ) {
      throw new InvalidPolicySubjectError(
        "agent replacement authorization is invalid",
      );
    }
  }
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
  if (subject.principalType === "agent_user") {
    assertActiveAuthorizationLineage(subject.authorization);
  }

  return Object.freeze({
    id,
    principal_type: subject.principalType,
    human_user_id: humanUserId,
  });
}
