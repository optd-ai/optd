// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import type {
  ChangesetFactRepository,
  HookSecretGrantRepository,
  QueryPolicyRepository,
  SecretRepository,
} from "../../../src/application/ports/repair/repositories.ts";

const secretRepository: SecretRepository<unknown, unknown, unknown> = {
  list: () => Promise.resolve([]),
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
    "list",
    "lockForUpdate",
    "resolveActive",
    "rotate",
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
