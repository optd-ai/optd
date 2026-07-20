import { assertEquals } from "jsr:@std/assert@1";
import { makeStageChangesetService } from "../../../src/application/services/changesets/stage_changesets.ts";
import type { StageRepository } from "../../../src/application/ports/stage_repository.ts";
import type { AuthContext } from "../../../src/domain/auth/model.ts";
import { ok } from "../../../src/domain/errors/result.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const auth: AuthContext = Object.freeze({
  id: "019b7a2e-7c10-7000-8000-000000000002",
  principalId: "019b7a2e-7c10-7000-8000-000000000003",
  principalType: "human_user",
  humanUserId: "019b7a2e-7c10-7000-8000-000000000004",
  sessionId: "019b7a2e-7c10-7000-8000-000000000005",
  credentialKind: "human_full",
  roles: [],
  createdAt: "2026-01-01T00:00:00Z",
});

Deno.test("injected stage coordinator runs once and ordered patches reach persistence", async () => {
  let calls = 0;
  let persisted: Parameters<StageRepository["create"]>[0] | undefined;
  const repository = fakeRepository((input) => persisted = input);
  const service = makeStageChangesetService(repository, {
    async coordinate(input) {
      await Promise.resolve();
      calls++;
      return {
        operations: structuredClone(input.operations) as never,
        patch_outputs: [{
          operation_key: "lead",
          output: {
            patches: [
              { op: "replace", path: "/name", value: "B" },
              { op: "add", path: "/score", value: 2 },
            ],
            warnings: [],
          },
        }],
        dependencies: [{ kind: "policy", fake_read: true }],
        hook_executions: [executionEvidence()],
        warnings: [{ path: "/name", code: "normalized", message: "changed" }],
        approval_requirements: [{ id: "019b7a2e-7c10-7000-8000-000000000006" }],
        required_capabilities: ["lead.update"],
        effects: ["lead.changed"],
        planned_events: [{ id: "event:lead" }],
        planned_deliveries: [],
      };
    },
  });
  const result = await service.stage({
    project_id: project,
    operations: [{
      op: "create",
      key: "lead",
      resource: "operant/crm:lead",
      fields: { name: "A" },
    }],
  }, auth);
  assertEquals(calls, 1);
  assertEquals(result.ok, true);
  assertEquals(persisted?.operations[0].fields, { name: "B", score: 2 });
  assertEquals(persisted?.hookResult?.warnings.length, 1);
});

Deno.test("malformed or failing coordinator patch never reaches persistence", async () => {
  let persisted = false;
  const repository = fakeRepository(() => persisted = true);
  const service = makeStageChangesetService(repository, {
    async coordinate(input) {
      await Promise.resolve();
      return {
        operations: structuredClone(input.operations) as never,
        patch_outputs: [{
          operation_key: "lead",
          output: {
            patches: [{ op: "test", path: "/name", value: "wrong" }],
          },
        }],
        dependencies: [],
        hook_executions: [executionEvidence()],
        warnings: [],
        approval_requirements: [],
        required_capabilities: [],
        effects: [],
        planned_events: [],
        planned_deliveries: [],
      };
    },
  });
  const result = await service.stage({
    project_id: project,
    operations: [{
      op: "create",
      key: "lead",
      resource: "operant/crm:lead",
      fields: { name: "A" },
    }],
  }, auth);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "hook_rejected");
  assertEquals(persisted, false);
});

function executionEvidence() {
  return {
    phase: "changeset.validate",
    pack_revision_id: "019b7a2e-7c10-7000-8000-000000000007",
    hook_revision_id: "019b7a2e-7c10-7000-8000-000000000008",
    input_digest: `sha256:${"1".repeat(64)}`,
    output_digest: `sha256:${"2".repeat(64)}`,
    output: {},
    stderr: "",
    duration_ms: 1,
    grant_snapshot: {},
  };
}

function fakeRepository(
  onCreate: (input: Parameters<StageRepository["create"]>[0]) => void,
): StageRepository {
  return {
    async hookInput(operations) {
      await Promise.resolve();
      return ok({
        operations,
        projects: [{ project_id: project }],
        pack_revisions: [{ matching_hooks: [{ hook: "normalize" }] }],
      });
    },
    async create(input) {
      await Promise.resolve();
      onCreate(input);
      return ok({ id: "stage" } as never);
    },
    async inspect() {
      await Promise.resolve();
      return ok({ id: "stage" } as never);
    },
    async cancel() {
      await Promise.resolve();
      return ok({ id: "stage" } as never);
    },
  };
}
