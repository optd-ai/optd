// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertThrows } from "jsr:@std/assert";
import {
  ApprovalContractError,
  canonicalizeApprovalRequirements,
} from "../../../src/domain/approvals/requirements.ts";
import { stageDigest } from "../../../src/domain/changesets/stage.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const now = new Date("2026-01-01T00:00:00.000Z");
const base = {
  key: "manager_discount",
  role: "optd/crm:sales_manager",
  boundary: { type: "project", project_id: project },
  reason: "reviewed customer impact",
};

Deno.test("approval requirements default, canonicalize, coalesce, and sort", () => {
  const result = canonicalizeApprovalRequirements(
    [
      { ...base, key: "second" },
      base,
      { ...base },
    ],
    new Set([project]),
    now,
  );
  assertEquals(result.map((value) => value.key), [
    "manager_discount",
    "second",
  ]);
  assertEquals(result[0].minimum, 1);
  assertEquals(result[0].principal_types, ["human_user"]);
  assertEquals(result[0].allow_initiator, false);
  assertEquals(result[0].expires_at, null);
});

Deno.test("approval requirements reject conflicting keys and invalid authority facts", () => {
  for (
    const value of [
      [{ ...base }, { ...base, minimum: 2 }],
      [{ ...base, role: "*" }],
      [{ ...base, minimum: 0 }],
      [{ ...base, principal_types: [] }],
      [{
        ...base,
        boundary: {
          type: "project",
          project_id: "019b7a2e-7c10-7000-8000-000000000002",
        },
      }],
      [{ ...base, expires_at: "2025-12-31T00:00:00Z" }],
      [{ ...base, reason: " " }],
    ]
  ) {
    assertThrows(
      () => canonicalizeApprovalRequirements(value, new Set([project]), now),
      ApprovalContractError,
    );
  }
});

Deno.test("approval decisions and lifecycle facts remain outside immutable digests", async () => {
  const evidence = {
    operation_graph_digest: `sha256:${"1".repeat(64)}`,
    projects: [],
    pack_revisions: [],
    operations: [],
    dependencies: [],
    hook_executions: [],
    policy_decisions: [],
    approval_requirements: canonicalizeApprovalRequirements(
      [base],
      new Set([project]),
      now,
    ),
    required_capabilities: [],
    effects: [],
    planned_events: [],
    planned_deliveries: [],
  };
  const before = await stageDigest(evidence);
  const representation = {
    evidence,
    approval_decisions: [{ decision: "approve" }],
    status: "ready",
  };
  assertEquals(await stageDigest(representation.evidence), before);
});

Deno.test("approval expiration is normalized and bounded", () => {
  const result = canonicalizeApprovalRequirements(
    [{
      ...base,
      expires_at: "2026-01-02T00:00:00Z",
      principal_types: ["agent_user", "human_user", "agent_user"],
    }],
    new Set([project]),
    now,
  );
  assertEquals(result[0].expires_at, "2026-01-02T00:00:00.000Z");
  assertEquals(result[0].principal_types, ["agent_user", "human_user"]);
});
