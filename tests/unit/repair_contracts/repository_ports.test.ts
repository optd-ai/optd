// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  ActionStageAuthorityCutoff,
  ActionStageAuthorityPort,
  ChangesetFactRepository,
  HookSecretGrantRepository,
  QueryPolicyRepository,
  ReadSessionPort,
  SecretRepository,
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
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> = {
  persistPreview: () => Promise.resolve({}),
  commitFacts: () => Promise.resolve({}),
  view: () => Promise.resolve(null),
  history: () => Promise.resolve({}),
};

const readSession: ReadSessionPort<
  string,
  string,
  string,
  string,
  string,
  { authContextId: string },
  { projectId: string; objectId: string }
> = {
  async execute(auth, address, work) {
    assertEquals(auth.authContextId, "auth-context");
    assertEquals(address, { projectId: "project", objectId: "object" });
    return await work({
      reader: {
        read: () => Promise.resolve("object"),
        history: () => Promise.resolve("history"),
      },
      authorization: { authorize: () => Promise.resolve(true) },
      authorizationRootId: "authorization-root",
    });
  },
};

const exactStageCutoff: ActionStageAuthorityCutoff = {
  authorization: authorizationCutoff,
  targetDigestInput,
  canonicalTargetDigest: "canonical-target-digest",
  authorityFactsDigest: "authority-facts-digest",
};

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

const queryPolicy: QueryPolicyRepository<
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown,
  unknown
> = {
  lockReadAuthority: () => Promise.resolve(),
  definition: () => Promise.resolve(null),
  roleFacts: () => Promise.resolve({}),
  policyFacts: () => Promise.resolve({}),
  relationshipFacts: () => Promise.resolve({}),
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

Deno.test("read session preserves address, root anchor and repeated same-session policy", async () => {
  const result = await readSession.execute(
    { authContextId: "auth-context" },
    { projectId: "project", objectId: "object" },
    async ({ reader, authorization, authorizationRootId }) => ({
      object: await reader.read("read"),
      first: await authorization.authorize("first"),
      second: await authorization.authorize("second"),
      authorizationRootId,
    }),
  );
  assertEquals(result, {
    object: "object",
    first: true,
    second: true,
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
  assertEquals(cutoff.targetDigestInput, targetDigestInput);
  assertEquals(cutoff.canonicalTargetDigest, "canonical-target-digest");
  assertEquals(cutoff.authorityFactsDigest, "authority-facts-digest");

  // @ts-expect-error a boolean decision cannot substitute exact target evidence.
  const incompleteCutoff: ActionStageAuthorityCutoff = { allowed: true };
  assertEquals(Boolean(incompleteCutoff), true);
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
    "commitFacts",
    "history",
    "persistPreview",
    "view",
  ]);
  assertEquals(Object.keys(queryPolicy).toSorted(), [
    "definition",
    "lockReadAuthority",
    "policyFacts",
    "relationshipFacts",
    "roleFacts",
  ]);
});
