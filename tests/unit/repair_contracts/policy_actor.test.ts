// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  derivePolicyActor,
  InvalidPolicySubjectError,
  type ServerDerivedAuthorizationLineage,
} from "../../../src/application/ports/repair/policy_actor.ts";

const active = (
  id: string,
  parentAuthorizationId: string | null,
  rootAuthorizationId: string,
) => ({
  id,
  parentAuthorizationId,
  rootAuthorizationId,
  status: "active" as const,
});

function actorFor(
  principalId: string,
  authorization: ServerDerivedAuthorizationLineage,
) {
  return derivePolicyActor({
    principalType: "agent_user",
    principalId,
    humanUserId: "anchoring-human",
    authorization,
  });
}

Deno.test("policy actor preserves authenticated human principal and anchor", () => {
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
});

Deno.test("root and delegated agent lineages preserve their anchoring human", () => {
  assertEquals(
    actorFor("root-agent", {
      currentAuthorizationId: "authorization-root",
      rootAuthorizationId: "authorization-root",
      authorizationAncestryIds: ["authorization-root"],
      facts: [active("authorization-root", null, "authorization-root")],
    }),
    {
      id: "root-agent",
      principal_type: "agent_user",
      human_user_id: "anchoring-human",
    },
  );

  assertEquals(
    actorFor("delegated-agent", {
      currentAuthorizationId: "authorization-child",
      rootAuthorizationId: "authorization-root",
      authorizationAncestryIds: [
        "authorization-root",
        "authorization-child",
      ],
      facts: [
        active("authorization-root", null, "authorization-root"),
        active(
          "authorization-child",
          "authorization-root",
          "authorization-root",
        ),
      ],
    }),
    {
      id: "delegated-agent",
      principal_type: "agent_user",
      human_user_id: "anchoring-human",
    },
  );
});

Deno.test("replacement agent requires exact replaced authorization facts", () => {
  assertEquals(
    actorFor("replacement-agent", {
      currentAuthorizationId: "authorization-new",
      rootAuthorizationId: "authorization-root",
      authorizationAncestryIds: [
        "authorization-root",
        "authorization-new",
      ],
      replacesAuthorizationId: "authorization-old",
      facts: [
        active("authorization-root", null, "authorization-root"),
        {
          id: "authorization-old",
          parentAuthorizationId: "authorization-root",
          rootAuthorizationId: "authorization-root",
          status: "replaced",
          replacedByAuthorizationId: "authorization-new",
        },
        active(
          "authorization-new",
          "authorization-root",
          "authorization-root",
        ),
      ],
    }),
    {
      id: "replacement-agent",
      principal_type: "agent_user",
      human_user_id: "anchoring-human",
    },
  );
});

Deno.test("policy actor rejects missing anchors and revoked ancestors", () => {
  assertThrows(
    () =>
      derivePolicyActor({
        principalType: "agent_user",
        principalId: "agent",
        humanUserId: "",
        authorization: {
          currentAuthorizationId: "authorization",
          rootAuthorizationId: "authorization",
          authorizationAncestryIds: ["authorization"],
          facts: [active("authorization", null, "authorization")],
        },
      }),
    InvalidPolicySubjectError,
    "humanUserId is required",
  );

  assertThrows(
    () =>
      actorFor("delegated-agent", {
        currentAuthorizationId: "authorization-child",
        rootAuthorizationId: "authorization-root",
        authorizationAncestryIds: [
          "authorization-root",
          "authorization-child",
        ],
        facts: [
          {
            id: "authorization-root",
            parentAuthorizationId: null,
            rootAuthorizationId: "authorization-root",
            status: "revoked",
          },
          active(
            "authorization-child",
            "authorization-root",
            "authorization-root",
          ),
        ],
      }),
    InvalidPolicySubjectError,
    "lineage is not active",
  );
});

Deno.test("policy actor rejects mismatched ancestry and replacement claims", () => {
  assertThrows(
    () =>
      actorFor("agent", {
        currentAuthorizationId: "authorization-child",
        rootAuthorizationId: "authorization-root",
        authorizationAncestryIds: ["authorization-child"],
        facts: [active(
          "authorization-child",
          "authorization-root",
          "authorization-root",
        )],
      }),
    InvalidPolicySubjectError,
    "ancestry is invalid",
  );
  assertThrows(
    () =>
      actorFor("replacement-agent", {
        currentAuthorizationId: "authorization-new",
        rootAuthorizationId: "authorization-root",
        authorizationAncestryIds: [
          "authorization-root",
          "authorization-new",
        ],
        replacesAuthorizationId: "authorization-old",
        facts: [
          active("authorization-root", null, "authorization-root"),
          active(
            "authorization-new",
            "authorization-root",
            "authorization-root",
          ),
        ],
      }),
    InvalidPolicySubjectError,
    "replacement authorization is invalid",
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
