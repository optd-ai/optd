// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  type AuthorizationLineageFact,
  validateActiveAuthorizationLineage,
} from "../../../src/domain/auth/authorization_lineage.ts";

const HUMAN = "human-anchor";

function fact(
  authorizationId: string,
  parentAuthorizationId: string | null,
  rootAuthorizationId = "root",
  overrides: Partial<AuthorizationLineageFact> = {},
): AuthorizationLineageFact {
  return {
    authorizationId,
    agentUserId: `agent-${authorizationId}`,
    authorizationHumanUserId: HUMAN,
    parentAuthorizationId,
    rootAuthorizationId,
    revoked: false,
    superseded: false,
    agentPrincipalId: `principal-${authorizationId}`,
    agentName: authorizationId,
    agentHumanUserId: HUMAN,
    agentPrincipalType: "agent_user",
    agentPrincipalActive: true,
    ...overrides,
  };
}

function validate(
  facts: readonly AuthorizationLineageFact[],
  currentAuthorizationId = "leaf",
) {
  return validateActiveAuthorizationLineage({
    currentAuthorizationId,
    expectedPrincipalId: `principal-${currentAuthorizationId}`,
    expectedHumanUserId: HUMAN,
    facts,
  });
}

Deno.test("authorization lineage accepts exact active root and delegated chains", () => {
  const root = fact("root", null);
  const leaf = fact("leaf", "root", "root");
  const rootResult = validate([root], "root");
  const delegated = validate([leaf, root]);

  assertEquals(rootResult.ok, true);
  assertEquals(
    delegated.ok &&
      delegated.value.ancestry.map((item) => item.authorizationId),
    [
      "root",
      "leaf",
    ],
  );
});

Deno.test("authorization lineage rejects revoked or superseded root, middle, and leaf facts", () => {
  const base = [
    fact("root", null),
    fact("middle", "root"),
    fact("leaf", "middle"),
  ];
  for (const index of [0, 1, 2]) {
    for (const status of ["revoked", "superseded"] as const) {
      const facts = base.map((entry, factIndex) =>
        factIndex === index ? { ...entry, [status]: true } : entry
      );
      assertEquals(validate(facts), { ok: false, reason: "inactive_fact" });
    }
  }
});

Deno.test("authorization lineage rejects missing, malformed, extra, and unrelated ancestry", () => {
  assertEquals(validate([fact("leaf", "missing")]), {
    ok: false,
    reason: "missing_fact",
  });
  assertEquals(
    validate([
      fact("root", null),
      fact("leaf", "root", "other-root"),
      fact("other-root", null, "other-root"),
    ]),
    { ok: false, reason: "root_mismatch" },
  );
  assertEquals(
    validate([
      fact("root", "extra"),
      fact("leaf", "root"),
      fact("extra", null),
    ]),
    { ok: false, reason: "root_mismatch" },
  );
  assertEquals(
    validate([
      fact("root", null),
      fact("leaf", "root"),
      fact("unrelated", null, "unrelated"),
    ]),
    { ok: false, reason: "unrelated_fact" },
  );
});

Deno.test("authorization lineage rejects anchor and current-principal mismatches", () => {
  assertEquals(
    validate([
      fact("root", null),
      fact("leaf", "root", "root", { agentHumanUserId: "other-human" }),
    ]),
    { ok: false, reason: "anchor_mismatch" },
  );
  assertEquals(
    validate([
      fact("root", null),
      fact("leaf", "root", "root", { agentPrincipalId: "other-principal" }),
    ]),
    { ok: false, reason: "principal_mismatch" },
  );
});

Deno.test("authorization lineage accepts a current root replacement but rejects its stale session", () => {
  const replacedRoot = fact("root", null, "root", {
    agentUserId: "same-agent",
    agentPrincipalId: "same-principal",
    superseded: true,
  });
  const replacement = fact("replacement", null, "root", {
    agentUserId: "same-agent",
    agentPrincipalId: "same-principal",
  });
  const result = validateActiveAuthorizationLineage({
    currentAuthorizationId: "replacement",
    expectedPrincipalId: "same-principal",
    expectedHumanUserId: HUMAN,
    facts: [replacedRoot, replacement],
  });
  assertEquals(
    result.ok && result.value.ancestry.map((item) => item.authorizationId),
    [
      "replacement",
    ],
  );
  assertEquals(
    validateActiveAuthorizationLineage({
      currentAuthorizationId: "root",
      expectedPrincipalId: "same-principal",
      expectedHumanUserId: HUMAN,
      facts: [replacedRoot],
    }),
    { ok: false, reason: "inactive_fact" },
  );
});
