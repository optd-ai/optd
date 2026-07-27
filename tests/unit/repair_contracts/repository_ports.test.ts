// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  ActionStageAuthorityPort,
  ChangesetFactRepository,
  HookSecretGrantRepository,
  QueryPolicyRepository,
  ReadSessionPort,
  SecretRepository,
} from "../../../src/application/ports/repair/repositories.ts";

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

const actionStageAuthority: ActionStageAuthorityPort<
  { projectId: string },
  { allowed: boolean },
  { operations: readonly string[] },
  { stageId: string }
> = {
  lockAndEvaluate: () =>
    Promise.resolve({
      authorizationRootId: "authorization-root",
      targetedResult: { allowed: true },
      authorityFactsDigest: "facts-digest",
    }),
  persistAfterHooks: () => Promise.resolve({ stageId: "stage" }),
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
  assertEquals(cutoff, {
    authorizationRootId: "authorization-root",
    targetedResult: { allowed: true },
    authorityFactsDigest: "facts-digest",
  });
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
