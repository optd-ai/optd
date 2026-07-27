// deno-lint-ignore-file no-import-prefix no-unversioned-import
import {
  assertEquals,
  assertFalse,
  assertNotEquals,
  assertThrows,
} from "jsr:@std/assert";
import {
  canonicalTargetDigestInput,
  type EffectManifest,
  InvalidReviewedTargetError,
  reviewedObjectEvidence,
} from "../../../src/application/ports/repair/targeted_action.ts";

Deno.test("target authority evidence canonicalizes exact reviewed targets", () => {
  const canonical = canonicalTargetDigestInput({
    actor: {
      id: "agent-principal",
      principal_type: "agent_user",
      human_user_id: "human-1",
    },
    authorizationRootId: "root-1",
    authorizationLineageIds: ["authorization-2", "authorization-1"],
    targets: [{
      target: {
        projectId: "project-b",
        resource: "publisher/crm:lead",
        object: {
          id: "lead-2",
          versionId: "019b1234-5678-7abc-8def-012345678902",
        },
      },
      policyDigest: "digest-b",
      matchedRules: [{
        policy: "publisher/crm:sales",
        policyVersionId: "version-2",
        policyVersion: 2,
        rule: "update",
      }, {
        policy: "publisher/crm:accounts",
        policyVersionId: "version-1",
        policyVersion: 1,
        rule: "viewer",
      }],
      roleAssignmentIds: ["role-2", "role-1"],
      relationshipIds: ["relationship-2", "relationship-1"],
    }, {
      target: {
        projectId: "project-a",
        resource: "publisher/crm:lead",
        object: {
          id: "lead-1",
          versionId: "019b1234-5678-7abc-8def-012345678901",
        },
      },
      policyDigest: "digest-a",
      matchedRules: [],
      roleAssignmentIds: [],
      relationshipIds: [],
    }],
  });

  assertEquals(canonical.authorization_lineage_ids, [
    "authorization-2",
    "authorization-1",
  ]);
  assertEquals(canonical.targets.map((target) => target.object_id), [
    "lead-2",
    "lead-1",
  ]);
  assertEquals(canonical.targets.map((target) => target.object_version_id), [
    "019b1234-5678-7abc-8def-012345678902",
    "019b1234-5678-7abc-8def-012345678901",
  ]);
  assertEquals(canonical.targets[0].matched_rules.map((rule) => rule.policy), [
    "publisher/crm:accounts",
    "publisher/crm:sales",
  ]);
  assertEquals(canonical.targets[0].role_assignment_ids, ["role-1", "role-2"]);
});

Deno.test("canonical target evidence preserves reviewed target and lineage order", () => {
  const actor = {
    id: "agent-principal",
    principal_type: "agent_user" as const,
    human_user_id: "human-1",
  };
  const target = (id: string) => ({
    target: {
      projectId: "project-1",
      resource: "publisher/crm:lead",
      object: { id, versionId: `version-${id}` },
    },
    policyDigest: `digest-${id}`,
    matchedRules: [],
    roleAssignmentIds: [],
    relationshipIds: [],
  });
  const first = canonicalTargetDigestInput({
    actor,
    authorizationRootId: "root-1",
    authorizationLineageIds: ["root-1", "child-1"],
    targets: [target("lead-1"), target("lead-2")],
  });
  const reversedTargets = canonicalTargetDigestInput({
    actor,
    authorizationRootId: "root-1",
    authorizationLineageIds: ["root-1", "child-1"],
    targets: [target("lead-2"), target("lead-1")],
  });
  const reversedLineage = canonicalTargetDigestInput({
    actor,
    authorizationRootId: "root-1",
    authorizationLineageIds: ["child-1", "root-1"],
    targets: [target("lead-1"), target("lead-2")],
  });

  assertNotEquals(JSON.stringify(first), JSON.stringify(reversedTargets));
  assertNotEquals(JSON.stringify(first), JSON.stringify(reversedLineage));
});

Deno.test("reviewed object evidence requires server UUIDv7 identities", () => {
  assertEquals(
    reviewedObjectEvidence(
      "019b1234-5678-7abc-8def-012345678901",
      "019b1234-5678-7abc-8def-012345678902",
    ),
    {
      id: "019b1234-5678-7abc-8def-012345678901",
      versionId: "019b1234-5678-7abc-8def-012345678902",
    },
  );
  assertThrows(
    () =>
      reviewedObjectEvidence(
        "object-1",
        "019b1234-5678-7abc-8def-012345678902",
      ),
    InvalidReviewedTargetError,
    "object.id",
  );
  assertThrows(
    () =>
      reviewedObjectEvidence(
        "019b1234-5678-7abc-8def-012345678901",
        "version-1",
      ),
    InvalidReviewedTargetError,
    "object.versionId",
  );
});

Deno.test("effect manifests cannot become authorization digest targets", () => {
  const effects: EffectManifest = {
    operationKinds: ["create"],
    resourceIdentities: ["publisher/crm:opportunity"],
  };
  const canonical = canonicalTargetDigestInput({
    actor: {
      id: "human-principal",
      principal_type: "human_user",
      human_user_id: "human-1",
    },
    authorizationRootId: "authorization-root",
    authorizationLineageIds: [],
    targets: [{
      target: {
        projectId: "project-1",
        resource: "publisher/crm:lead",
        object: {
          id: "lead-1",
          versionId: "019b1234-5678-7abc-8def-012345678901",
        },
      },
      policyDigest: "policy-digest",
      matchedRules: [],
      roleAssignmentIds: [],
      relationshipIds: [],
    }],
  });

  assertEquals(effects.resourceIdentities, ["publisher/crm:opportunity"]);
  assertEquals(canonical.targets[0].resource, "publisher/crm:lead");
  assertFalse("effects" in canonical);
});

Deno.test("definition-level reviewed targets omit object evidence canonically", () => {
  const canonical = canonicalTargetDigestInput({
    actor: {
      id: "human-principal",
      principal_type: "human_user",
      human_user_id: "human-1",
    },
    authorizationRootId: "authorization-root",
    authorizationLineageIds: [],
    targets: [{
      target: {
        projectId: "project-1",
        resource: "publisher/crm:lead",
      },
      policyDigest: "policy-digest",
      matchedRules: [],
      roleAssignmentIds: [],
      relationshipIds: [],
    }],
  });

  assertEquals(canonical.targets[0], {
    project_id: "project-1",
    resource: "publisher/crm:lead",
    policy_digest: "policy-digest",
    matched_rules: [],
    role_assignment_ids: [],
    relationship_ids: [],
  });
  assertFalse("object_id" in canonical.targets[0]);
  assertFalse("object_version_id" in canonical.targets[0]);
});
