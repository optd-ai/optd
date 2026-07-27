// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertFalse } from "jsr:@std/assert";
import {
  canonicalTargetDigestInput,
  type EffectManifest,
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
        objectId: "lead-2",
        objectVersion: 7,
      },
      policyDigest: "digest-b",
      matchedRules: [{
        policy: "publisher/crm:sales",
        policyVersionId: "version-2",
        policyVersion: 2,
        rule: "update",
      }],
      roleAssignmentIds: ["role-2", "role-1"],
      relationshipIds: ["relationship-2", "relationship-1"],
    }, {
      target: {
        projectId: "project-a",
        resource: "publisher/crm:lead",
        objectId: "lead-1",
        objectVersion: 3,
      },
      policyDigest: "digest-a",
      matchedRules: [],
      roleAssignmentIds: [],
      relationshipIds: [],
    }],
  });

  assertEquals(canonical.authorization_lineage_ids, [
    "authorization-1",
    "authorization-2",
  ]);
  assertEquals(canonical.targets.map((target) => target.object_id), [
    "lead-1",
    "lead-2",
  ]);
  assertEquals(canonical.targets[1].role_assignment_ids, ["role-1", "role-2"]);
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
        objectId: "lead-1",
        objectVersion: 1,
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
