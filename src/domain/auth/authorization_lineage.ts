export type AuthorizationLineageFact = Readonly<{
  authorizationId: string;
  agentUserId: string;
  authorizationHumanUserId: string;
  parentAuthorizationId: string | null;
  rootAuthorizationId: string;
  revoked: boolean;
  superseded: boolean;
  agentPrincipalId: string;
  agentName: string | null;
  agentHumanUserId: string;
  agentPrincipalType: "human_user" | "agent_user" | null;
  agentPrincipalActive: boolean;
}>;

export type ActiveAuthorizationLineage = Readonly<{
  current: AuthorizationLineageFact;
  rootAuthorizationId: string;
  /** Canonical active parent chain, root to current, inclusive. */
  ancestry: readonly AuthorizationLineageFact[];
}>;

export type AuthorizationLineageInvalidReason =
  | "missing_fact"
  | "duplicate_fact"
  | "inactive_fact"
  | "malformed_chain"
  | "root_mismatch"
  | "anchor_mismatch"
  | "principal_mismatch"
  | "unrelated_fact";

export type AuthorizationLineageValidation =
  | Readonly<{ ok: true; value: ActiveAuthorizationLineage }>
  | Readonly<{ ok: false; reason: AuthorizationLineageInvalidReason }>;

export function validateActiveAuthorizationLineage(
  input: Readonly<{
    currentAuthorizationId: string;
    expectedPrincipalId: string;
    expectedHumanUserId: string;
    facts: readonly AuthorizationLineageFact[];
  }>,
): AuthorizationLineageValidation {
  const facts = new Map<string, AuthorizationLineageFact>();
  for (const fact of input.facts) {
    if (!fact.authorizationId || facts.has(fact.authorizationId)) {
      return invalid("duplicate_fact");
    }
    facts.set(fact.authorizationId, fact);
  }

  const current = facts.get(input.currentAuthorizationId);
  if (!current) return invalid("missing_fact");
  if (current.agentPrincipalId !== input.expectedPrincipalId) {
    return invalid("principal_mismatch");
  }

  const leafToRoot: AuthorizationLineageFact[] = [];
  const visited = new Set<string>();
  let fact: AuthorizationLineageFact | undefined = current;
  while (fact) {
    if (visited.has(fact.authorizationId)) return invalid("malformed_chain");
    visited.add(fact.authorizationId);
    leafToRoot.push(fact);
    if (fact.parentAuthorizationId === null) break;
    fact = facts.get(fact.parentAuthorizationId);
    if (!fact) return invalid("missing_fact");
  }

  const logicalRootId = current.rootAuthorizationId;
  for (const entry of leafToRoot) {
    if (entry.revoked || entry.superseded) return invalid("inactive_fact");
    if (entry.rootAuthorizationId !== logicalRootId) {
      return invalid("root_mismatch");
    }
    if (
      entry.authorizationHumanUserId !== input.expectedHumanUserId ||
      entry.agentHumanUserId !== input.expectedHumanUserId
    ) {
      return invalid("anchor_mismatch");
    }
    if (
      !entry.agentPrincipalId || entry.agentPrincipalType !== "agent_user" ||
      !entry.agentPrincipalActive
    ) {
      return invalid("principal_mismatch");
    }
  }

  const activeRoot = leafToRoot.at(-1)!;
  const extras = input.facts.filter((entry) =>
    !visited.has(entry.authorizationId)
  );
  if (activeRoot.authorizationId === logicalRootId) {
    if (extras.length !== 0) return invalid("unrelated_fact");
  } else {
    // A root replacement retains the original root as its durable lineage key.
    // The active replacement must occupy the same root slot and be the same
    // agent; no other detached fact is part of the current parent chain.
    const originalRoot = facts.get(logicalRootId);
    if (
      extras.length !== 1 || !originalRoot || extras[0] !== originalRoot ||
      originalRoot.authorizationId !== originalRoot.rootAuthorizationId ||
      originalRoot.parentAuthorizationId !== null || originalRoot.revoked ||
      !originalRoot.superseded ||
      originalRoot.agentUserId !== activeRoot.agentUserId ||
      originalRoot.agentPrincipalId !== activeRoot.agentPrincipalId ||
      originalRoot.authorizationHumanUserId !== input.expectedHumanUserId ||
      originalRoot.agentHumanUserId !== input.expectedHumanUserId ||
      originalRoot.agentPrincipalType !== "agent_user" ||
      !originalRoot.agentPrincipalActive
    ) {
      return invalid(extras.length > 1 ? "unrelated_fact" : "root_mismatch");
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      current,
      rootAuthorizationId: logicalRootId,
      ancestry: Object.freeze([...leafToRoot].reverse()),
    }),
  };
}

function invalid(
  reason: AuthorizationLineageInvalidReason,
): AuthorizationLineageValidation {
  return { ok: false, reason };
}
