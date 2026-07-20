import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  stageDigest,
  type StageEvidence,
} from "../../../src/domain/changesets/stage.ts";

const base: StageEvidence = {
  operation_graph_digest: `sha256:${"0".repeat(64)}`,
  projects: [{ project_id: "project-a", version: 1, status: "active" }],
  pack_revisions: [{ id: "pack-a", digest: `sha256:${"1".repeat(64)}` }],
  operations: [{ op: "create", project_id: "project-a" }] as never,
  dependencies: [{ kind: "resource", component_revision_id: "component-a" }],
  hook_executions: [{
    id: "hook-a",
    output_digest: `sha256:${"2".repeat(64)}`,
  }],
  policy_decisions: [{ id: "policy-a", allowed: true }],
  approval_requirements: [{ id: "approval-a", capability: "review" }],
  required_capabilities: ["review"],
  effects: ["object.created"],
  planned_events: [{ id: "event-a" }],
  planned_deliveries: [{ id: "delivery-a" }],
};

Deno.test("stage digest includes every frozen evidence category", async () => {
  const original = await stageDigest(base);
  const changes: Array<[string, StageEvidence]> = [
    ["graph", { ...base, operation_graph_digest: `sha256:${"f".repeat(64)}` }],
    ["project", {
      ...base,
      projects: [{ project_id: "project-a", version: 2 }],
    }],
    ["pack", { ...base, pack_revisions: [{ id: "pack-b" }] }],
    ["component/dependency", {
      ...base,
      dependencies: [{
        kind: "resource",
        component_revision_id: "component-b",
      }],
    }],
    ["security/hook", {
      ...base,
      hook_executions: [{
        id: "hook-a",
        output_digest: `sha256:${"3".repeat(64)}`,
      }],
    }],
    ["policy", {
      ...base,
      policy_decisions: [{ id: "policy-a", allowed: false }],
    }],
    ["approval", {
      ...base,
      approval_requirements: [{ id: "approval-b", capability: "review" }],
    }],
    ["capability", { ...base, required_capabilities: ["admin"] }],
    ["effect", { ...base, effects: ["object.archived"] }],
    ["event", { ...base, planned_events: [{ id: "event-b" }] }],
    ["delivery", { ...base, planned_deliveries: [{ id: "delivery-b" }] }],
    ["operation", {
      ...base,
      operations: [{ op: "archive", project_id: "project-a" }] as never,
    }],
  ];
  for (const [category, changed] of changes) {
    assertNotEquals(await stageDigest(changed), original, category);
  }
});

Deno.test("stage digest ignores request, auth, clock, warning, and lifecycle facts", async () => {
  const original = await stageDigest(base);
  const withExcludedFacts = {
    ...base,
    id: "stage-id",
    request_id: "request-id",
    created_auth_context_id: "auth-id",
    created_at: "2099-01-01T00:00:00Z",
    warnings: [{ code: "warning" }],
    status: "committed",
    lifecycle_version: 99,
    cancellation: { reason: "later" },
    commit: { id: "commit-id" },
  };
  assertEquals(await stageDigest(withExcludedFacts), original);
});
