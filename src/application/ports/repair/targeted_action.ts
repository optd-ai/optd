import type { PolicyActor } from "./policy_actor.ts";

export type ReviewedTarget = Readonly<{
  projectId: string;
  resource: string;
  objectId: string;
  objectVersion: number;
}>;

export type MatchedRuleEvidence = Readonly<{
  policy: string;
  policyVersionId: string;
  policyVersion: number;
  rule: string;
}>;

export type TargetAuthorityEvidence = Readonly<{
  target: ReviewedTarget;
  policyDigest: string;
  matchedRules: readonly MatchedRuleEvidence[];
  roleAssignmentIds: readonly string[];
  relationshipIds: readonly string[];
}>;

export type AuthorizationCutoff = Readonly<{
  actor: PolicyActor;
  authorizationRootId: string;
  authorizationLineageIds: readonly string[];
  targets: readonly TargetAuthorityEvidence[];
}>;

/** Effects are graph constraints, not authorization inputs. */
export type EffectManifest = Readonly<{
  operationKinds: readonly string[];
  resourceIdentities: readonly string[];
}>;

export type TargetDigestInput = Readonly<{
  actor: PolicyActor;
  authorization_root_id: string;
  authorization_lineage_ids: readonly string[];
  targets: readonly Readonly<{
    project_id: string;
    resource: string;
    object_id: string;
    object_version: number;
    policy_digest: string;
    matched_rules: readonly Readonly<{
      policy: string;
      policy_version_id: string;
      policy_version: number;
      rule: string;
    }>[];
    role_assignment_ids: readonly string[];
    relationship_ids: readonly string[];
  }>[];
}>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalTargetDigestInput(
  cutoff: AuthorizationCutoff,
): TargetDigestInput {
  const targets = cutoff.targets.map((evidence) => ({
    project_id: evidence.target.projectId,
    resource: evidence.target.resource,
    object_id: evidence.target.objectId,
    object_version: evidence.target.objectVersion,
    policy_digest: evidence.policyDigest,
    matched_rules: evidence.matchedRules.map((rule) => ({
      policy: rule.policy,
      policy_version_id: rule.policyVersionId,
      policy_version: rule.policyVersion,
      rule: rule.rule,
    })).toSorted((left, right) =>
      compareText(left.policy, right.policy) ||
      left.policy_version - right.policy_version ||
      compareText(left.policy_version_id, right.policy_version_id) ||
      compareText(left.rule, right.rule)
    ),
    role_assignment_ids: evidence.roleAssignmentIds.toSorted(compareText),
    relationship_ids: evidence.relationshipIds.toSorted(compareText),
  })).toSorted((left, right) =>
    compareText(left.project_id, right.project_id) ||
    compareText(left.resource, right.resource) ||
    compareText(left.object_id, right.object_id) ||
    left.object_version - right.object_version
  );

  return Object.freeze({
    actor: cutoff.actor,
    authorization_root_id: cutoff.authorizationRootId,
    authorization_lineage_ids: cutoff.authorizationLineageIds.toSorted(
      compareText,
    ),
    targets,
  });
}

export type TargetEvaluationRequest = Readonly<{
  actor: PolicyActor;
  targets: readonly ReviewedTarget[];
  action: string;
}>;

export interface TargetedPolicyEvaluator {
  evaluate(
    request: TargetEvaluationRequest,
  ): Promise<readonly TargetAuthorityEvidence[]>;
}

export interface TargetedAuthorityCutoff {
  revalidate(cutoff: AuthorizationCutoff): Promise<
    | Readonly<{ valid: true }>
    | Readonly<{ valid: false; reason: "stale" | "denied" }>
  >;
}
