// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  derivePolicyActor,
  InvalidPolicySubjectError,
} from "../../../src/application/ports/repair/policy_actor.ts";

Deno.test("policy actor preserves authenticated principal and anchoring human", () => {
  assertEquals(
    derivePolicyActor({
      principalType: "human_user",
      principalId: "principal-human",
      humanUserId: "human-1",
    }),
    {
      id: "principal-human",
      principal_type: "human_user",
      human_user_id: "human-1",
    },
  );

  for (
    const principalId of ["root-agent", "delegated-agent", "replacement-agent"]
  ) {
    assertEquals(
      derivePolicyActor({
        principalType: "agent_user",
        principalId,
        humanUserId: "anchoring-human",
        authorizationId: `authorization-${principalId}`,
        authorizationActive: true,
      }),
      {
        id: principalId,
        principal_type: "agent_user",
        human_user_id: "anchoring-human",
      },
    );
  }
});

Deno.test("policy actor rejects missing anchors and revoked agent lineage", () => {
  assertThrows(
    () =>
      derivePolicyActor({
        principalType: "agent_user",
        principalId: "agent",
        humanUserId: "",
        authorizationId: "authorization",
        authorizationActive: true,
      }),
    InvalidPolicySubjectError,
    "humanUserId is required",
  );

  assertThrows(
    () =>
      derivePolicyActor({
        principalType: "agent_user",
        principalId: "agent",
        humanUserId: "human",
        authorizationId: "authorization",
        authorizationActive: false,
      }),
    InvalidPolicySubjectError,
    "lineage is not active",
  );
});

Deno.test("only a system subject has no human anchor", () => {
  assertEquals(
    derivePolicyActor({
      principalType: "system",
      principalId: "system:outbox",
    }),
    {
      id: "system:outbox",
      principal_type: "system",
      human_user_id: null,
    },
  );
});
