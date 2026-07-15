import { assertEquals } from "jsr:@std/assert";
import { CurrentPolicyAgentAuthorizationGrantability } from "../../../src/application/services/auth/grantability.ts";
import type {
  AgentAuthorizationGrantabilitySnapshot,
  AgentAuthorizationGrantabilityState,
} from "../../../src/application/ports/authentication.ts";
import type { AuthContext } from "../../../src/domain/auth/model.ts";

const auth: AuthContext = Object.freeze({
  id: "01900000-0000-7000-8000-000000000001",
  principalId: "01900000-0000-7000-8000-000000000002",
  principalType: "human_user",
  humanUserId: "01900000-0000-7000-8000-000000000003",
  sessionId: "01900000-0000-7000-8000-000000000004",
  credentialKind: "human_full",
  roles: Object.freeze(["system:admin"]),
  createdAt: new Date(0).toISOString(),
});
const snapshot: AgentAuthorizationGrantabilitySnapshot = {
  roleDefinitionVersions: [{
    role: "system:admin",
    versionId: "01900000-0000-7000-8000-000000000101",
    version: 1,
  }],
  policyDefinitionVersions: [{
    policy: "system:auth_decider",
    versionId: "01900000-0000-7000-8000-000000000102",
    version: 1,
  }],
  capabilitySummaryDigest: "digest",
};

Deno.test("generic grantability separates decide capability from approval role possession", async () => {
  const evaluator = new CurrentPolicyAgentAuthorizationGrantability();
  const allowed = state({
    superAdmin: false,
    canDecide: true,
    effectiveRoles: ["system:admin"],
  });
  assertEquals(
    (await evaluator.canDecide({
      auth,
      decision: "approved",
      roles: ["system:admin"],
      boundary: { type: "system" },
      state: allowed,
    })).ok,
    true,
  );
  assertEquals(
    (await evaluator.canDecide({
      auth,
      decision: "denied",
      roles: ["system:super_admin"],
      boundary: { type: "system" },
      state: allowed,
    })).ok,
    true,
  );
  const missingRole = await evaluator.canDecide({
    auth,
    decision: "approved",
    roles: ["system:super_admin"],
    boundary: { type: "system" },
    state: allowed,
  });
  assertEquals(missingRole.ok, false);
  if (!missingRole.ok) {
    assertEquals(missingRole.error.code, "authorization_insufficient");
  }
  const missingCapability = await evaluator.canDecide({
    auth,
    decision: "denied",
    roles: [],
    boundary: { type: "system" },
    state: state({ superAdmin: false, canDecide: false, effectiveRoles: [] }),
  });
  assertEquals(missingCapability.ok, false);
});

Deno.test("authenticated current super-admin bypass remains structural", async () => {
  const evaluator = new CurrentPolicyAgentAuthorizationGrantability();
  const result = await evaluator.canDecide({
    auth,
    decision: "approved",
    roles: ["system:super_admin"],
    boundary: { type: "all_projects" },
    state: state({ superAdmin: true, canDecide: false, effectiveRoles: [] }),
  });
  assertEquals(result, { ok: true, value: snapshot });
});

function state(
  value: { superAdmin: boolean; canDecide: boolean; effectiveRoles: string[] },
): AgentAuthorizationGrantabilityState {
  return {
    current: () =>
      Promise.resolve({ ok: true as const, value: { ...value, snapshot } }),
  };
}
