// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import type { AuthContext } from "../../../src/domain/auth/model.ts";
import {
  InvalidAuthContextActorError,
  policyActorFromAuthContext,
} from "../../../src/domain/auth/policy_actor.ts";

const human = Object.freeze<AuthContext>({
  id: "context-human",
  principalId: "principal-human",
  principalType: "human_user",
  humanUserId: "human-1",
  sessionId: "session-human",
  credentialKind: "human_full",
  roles: Object.freeze(["system:super_admin"]),
  createdAt: "2026-07-27T00:00:00.000Z",
});

const agent = Object.freeze<AuthContext>({
  id: "context-agent",
  principalId: "principal-agent",
  principalType: "agent_user",
  humanUserId: "human-1",
  sessionId: "session-agent",
  authorizationId: "authorization-agent",
  credentialKind: "agent_authorization",
  roles: Object.freeze(["example:worker"]),
  createdAt: "2026-07-27T00:00:00.000Z",
});

Deno.test("policy actor derives human and agent identity only from AuthContext", () => {
  assertEquals(policyActorFromAuthContext(human), {
    id: "principal-human",
    principal_type: "human_user",
    human_user_id: "human-1",
  });
  assertEquals(policyActorFromAuthContext(agent), {
    id: "principal-agent",
    principal_type: "agent_user",
    human_user_id: "human-1",
  });
});

Deno.test("policy actor rejects missing anchors and contradictory credentials", () => {
  assertThrows(
    () => policyActorFromAuthContext({ ...agent, humanUserId: "" }),
    InvalidAuthContextActorError,
    "humanUserId is required",
  );
  assertThrows(
    () =>
      policyActorFromAuthContext({
        ...agent,
        credentialKind: "human_full",
      }),
    InvalidAuthContextActorError,
    "inconsistent",
  );
  assertThrows(
    () =>
      policyActorFromAuthContext({
        ...human,
        authorizationId: "caller-injected-authorization",
      }),
    InvalidAuthContextActorError,
    "inconsistent",
  );
});
