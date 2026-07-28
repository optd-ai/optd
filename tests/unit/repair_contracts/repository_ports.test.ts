// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert";
import {
  type ActionStageAuthorityCutoff,
  type ActionStageAuthorityPort,
  assertActionStageAuthorityCutoff,
  type ChangesetFactRepository,
  createActionStageAuthorityCutoff,
  type HookSecretGrantRepository,
  InvalidActionStageAuthorityCutoffError,
  type QueryPolicyRepository,
  type ReadSessionPort,
  type SecretRepository,
} from "../../../src/application/ports/repair/repositories.ts";
import {
  canonicalTargetDigestInput,
  type TargetAuthorityEvidence,
} from "../../../src/application/ports/repair/targeted_action.ts";

const actor = {
  id: "agent-principal",
  principal_type: "agent_user",
  human_user_id: "anchoring-human",
} as const;
const reviewedTargets: readonly TargetAuthorityEvidence[] = [{
  target: {
    projectId: "019b1234-5678-7abc-8def-012345678900",
    resource: "publisher/crm:lead",
    object: {
      id: "019b1234-5678-7abc-8def-012345678901",
      versionId: "019b1234-5678-7abc-8def-012345678902",
    },
  },
  policyDigest: "policy-digest",
  matchedRules: [{
    policy: "publisher/crm:sales_access",
    policyVersionId: "policy-version-id",
    policyVersion: 3,
    rule: "convert",
  }],
  roleAssignmentIds: ["role-assignment"],
  relationshipIds: ["relationship"],
}];
const authorizationCutoff = {
  actor,
  authorizationRootId: "authorization-root",
  authorizationLineageIds: ["authorization-root", "authorization-current"],
  targets: reviewedTargets,
} as const;
const targetDigestInput = canonicalTargetDigestInput(authorizationCutoff);
const digestTarget = (input: typeof targetDigestInput): string =>
  JSON.stringify(input);

const secretRepository: SecretRepository<unknown, unknown, unknown> = {
  list: () => Promise.resolve([]),
  upsertByName: () => Promise.resolve({}),
  hardDeleteByName: () => Promise.resolve(false),
  resolveActiveByName: () => Promise.resolve(null),
  create: () => Promise.resolve({}),
  lockForUpdate: () => Promise.resolve(null),
  rotate: () => Promise.resolve({}),
  disable: () => Promise.resolve(null),
  resolveActive: () => Promise.resolve(null),
  appendAudit: () => Promise.resolve(),
  assertReady: () => Promise.resolve(),
};

const grantRepository: HookSecretGrantRepository<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> = {
  list: () => Promise.resolve([]),
  authorizeInTransaction: () => Promise.resolve(),
  lockAndValidateActiveHookSlot: () => Promise.resolve(null),
  lockActiveSecret: () => Promise.resolve(null),
  lockCurrentGrant: () => Promise.resolve(null),
  lockEffectiveGrant: () => Promise.resolve(null),
  create: () => Promise.resolve(),
  replace: () => Promise.resolve(false),
  revoke: () => Promise.resolve(false),
  appendAudit: () => Promise.resolve(),
};

const changesets: ChangesetFactRepository<
  readonly [input: unknown, auth: unknown],
  readonly [id: string, auth: unknown],
  readonly [id: string, requirementId: string, input: unknown, auth: unknown],
  readonly [id: string, reason: string | null, auth: unknown],
  unknown
> = {
  create: () => Promise.resolve({}),
  inspect: () => Promise.resolve({}),
  approvals: () => Promise.resolve({}),
  decideApproval: () => Promise.resolve({}),
  cancel: () => Promise.resolve({}),
};

const readSession: ReadSessionPort<
  {
    auth: { authContextId: string };
    address: { projectId: string; objectId: string };
  },
  {
    object: string;
    authorizationRootId: string;
  }
> = {
  async execute(request, work) {
    assertEquals(request.auth.authContextId, "auth-context");
    assertEquals(request.address, { projectId: "project", objectId: "object" });
    return await work({
      object: "object",
      authorizationRootId: "authorization-root",
    });
  },
};

const exactStageCutoff = await createActionStageAuthorityCutoff(
  {
    authorization: authorizationCutoff,
    authorityFactsDigest: "authority-facts-digest",
  },
  digestTarget,
);

const actionStageAuthority: ActionStageAuthorityPort<
  { projectId: string },
  { operations: readonly string[] },
  { stageId: string }
> = {
  lockAndEvaluate: () => Promise.resolve(exactStageCutoff),
  persistAfterHooks: (_request, cutoff) => {
    assertEquals(cutoff, exactStageCutoff);
    return Promise.resolve({ stageId: "stage" });
  },
};

const queryPolicy: QueryPolicyRepository<unknown, unknown> = {
  query: () => Promise.resolve({}),
};

Deno.test("repository ports cover complete secret and grant lifecycles", () => {
  assertEquals(Object.keys(secretRepository).toSorted(), [
    "appendAudit",
    "assertReady",
    "create",
    "disable",
    "hardDeleteByName",
    "list",
    "lockForUpdate",
    "resolveActive",
    "resolveActiveByName",
    "rotate",
    "upsertByName",
  ]);
  assertEquals(Object.keys(grantRepository).toSorted(), [
    "appendAudit",
    "authorizeInTransaction",
    "create",
    "list",
    "lockActiveSecret",
    "lockAndValidateActiveHookSlot",
    "lockCurrentGrant",
    "lockEffectiveGrant",
    "replace",
    "revoke",
  ]);
});

Deno.test("read session preserves immutable request and root anchor", async () => {
  const result = await readSession.execute(
    {
      auth: { authContextId: "auth-context" },
      address: { projectId: "project", objectId: "object" },
    },
    (session) => Promise.resolve(session),
  );
  assertEquals(result, {
    object: "object",
    authorizationRootId: "authorization-root",
  });
});

Deno.test("action stage authority freezes cutoff before post-hook persistence", async () => {
  const cutoff = await actionStageAuthority.lockAndEvaluate({
    projectId: "project",
  });
  assertEquals(cutoff.authorization.actor, actor);
  assertEquals(
    cutoff.authorization.authorizationRootId,
    "authorization-root",
  );
  assertEquals(cutoff.authorization.targets, reviewedTargets);
  assertEquals(
    canonicalTargetDigestInput(cutoff.authorization),
    targetDigestInput,
  );
  assertEquals(cutoff.canonicalTargetDigest, digestTarget(targetDigestInput));
  assertEquals(cutoff.authorityFactsDigest, "authority-facts-digest");

  // @ts-expect-error callers cannot construct the opaque validated cutoff.
  const incompleteCutoff: ActionStageAuthorityCutoff = {
    authorization: authorizationCutoff,
    canonicalTargetDigest: "forged",
    authorityFactsDigest: "facts",
  };
  assertEquals(Boolean(incompleteCutoff), true);
  assertThrows(
    () => assertActionStageAuthorityCutoff(incompleteCutoff),
    InvalidActionStageAuthorityCutoffError,
    "was not created by the validated factory",
  );
  assertActionStageAuthorityCutoff(cutoff);

  const forgedSpread = Object.freeze({
    ...cutoff,
    canonicalTargetDigest: "forged",
    authorityFactsDigest: "contradictory",
    authorization: Object.freeze({
      ...cutoff.authorization,
      authorizationRootId: "other-root",
    }),
  });
  assertThrows(
    () => assertActionStageAuthorityCutoff(forgedSpread),
    InvalidActionStageAuthorityCutoffError,
    "was not created by the validated factory",
  );
  assertThrows(
    () => assertActionStageAuthorityCutoff(Object.create(cutoff)),
    InvalidActionStageAuthorityCutoffError,
    "was not created by the validated factory",
  );
  assertThrows(
    () => assertActionStageAuthorityCutoff(structuredClone(cutoff)),
    InvalidActionStageAuthorityCutoffError,
    "was not created by the validated factory",
  );
  assertThrows(
    () => {
      (cutoff.authorization.authorizationLineageIds as string[]).push(
        "forged-lineage",
      );
    },
    TypeError,
  );
  assertThrows(
    () => {
      (cutoff.authorization.targets[0].matchedRules as unknown[]).push({});
    },
    TypeError,
  );

  await assertRejects(
    () =>
      createActionStageAuthorityCutoff(
        {
          authorization: authorizationCutoff,
          authorityFactsDigest: "authority-facts-digest",
          canonicalTargetDigest: "mismatched",
        },
        digestTarget,
      ),
    InvalidActionStageAuthorityCutoffError,
    "canonical target digest does not match",
  );

  assertEquals(
    await actionStageAuthority.persistAfterHooks(
      { operations: ["op"] },
      cutoff,
    ),
    { stageId: "stage" },
  );
});

Deno.test("repository ports cover changeset facts and query policy cutoffs", () => {
  assertEquals(Object.keys(changesets).toSorted(), [
    "approvals",
    "cancel",
    "create",
    "decideApproval",
    "inspect",
  ]);
  assertEquals(Object.keys(queryPolicy), ["query"]);
});
