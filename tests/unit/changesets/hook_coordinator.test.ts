import { assertEquals } from "jsr:@std/assert@1";
import { makeStageChangesetService } from "../../../src/application/services/changesets/stage_changesets.ts";
import type { StageRepository } from "../../../src/application/ports/stage_repository.ts";
import type { AuthContext } from "../../../src/domain/auth/model.ts";
import type {
  StageHookDeclaration,
  StageHookInput,
  StageHookOutput,
} from "../../../src/domain/changesets/stage.ts";
import { canonicalSha256 } from "../../../src/domain/ids/canonical_json.ts";
import { ok } from "../../../src/domain/errors/result.ts";

const project = "019b7a2e-7c10-7000-8000-000000000001";
const declaration: StageHookDeclaration = {
  attachment_id: "019b7a2e-7c10-7000-8000-000000000006",
  hook_revision_id: "019b7a2e-7c10-7000-8000-000000000007",
  pack_revision_id: "019b7a2e-7c10-7000-8000-000000000008",
  hook: "operant/crm:normalize",
  phase: "changeset.validate",
  resource: "operant/crm:lead",
  order: 0,
  script_digest: `sha256:${"3".repeat(64)}`,
  declaration_digest: `sha256:${"2".repeat(64)}`,
};
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
const grantSnapshot = {
  principal_id: auth.principalId,
  auth_context_id: auth.id,
  assignment_digest: `sha256:${"5".repeat(64)}`,
  policy_digest: `sha256:${"6".repeat(64)}`,
};

Deno.test("injected stage coordinator runs once and ordered patches reach persistence", async () => {
  let calls = 0;
  let persisted: Parameters<StageRepository["create"]>[0] | undefined;
  const repository = fakeRepository((input) => persisted = input);
  const service = makeStageChangesetService(repository, {
    async coordinate(input) {
      calls++;
      const output: StageHookOutput = {
        added_operations: [{
          op: "create",
          key: "child",
          project_id: project,
          resource: "operant/crm:lead",
          fields: {
            name: "child",
            parent_id: { $ref: "lead.object_id" },
          },
        }],
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
        read_dependencies: [{
          kind: "policy" as const,
          project_id: project,
          definition: "operant/crm:lead_policy",
          query_digest: `sha256:${"4".repeat(64)}`,
        }],
        warnings: [{ path: "/name", code: "normalized", message: "changed" }],
        approval_requirements: [{
          id: "019b7a2e-7c10-7000-8000-000000000009",
          capability: "lead.review",
        }],
        required_capabilities: ["lead.update"],
        effects: ["lead.changed"],
        planned_events: [{ id: "event:lead" }],
        planned_deliveries: [],
      };
      return { hook_executions: [await executionEvidence(input, output)] };
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
  assertEquals(persisted?.operations.length, 2);
  assertEquals(
    (persisted?.operations[1].fields as Record<string, unknown>).parent_id,
    persisted?.operations[0].object_id,
  );
  assertEquals(persisted?.hookResult?.warnings.length, 1);
  assertEquals(persisted?.hookDeclarations, [declaration]);
});

Deno.test("malformed or failing coordinator patch never reaches persistence", async () => {
  let persisted = false;
  const repository = fakeRepository(() => persisted = true);
  const service = makeStageChangesetService(repository, {
    async coordinate(input) {
      const output: StageHookOutput = {
        added_operations: [],
        patch_outputs: [{
          operation_key: "lead",
          output: {
            patches: [{ op: "test", path: "/name", value: "wrong" }],
          },
        }],
        read_dependencies: [],
        warnings: [],
        approval_requirements: [],
        required_capabilities: [],
        effects: [],
        planned_events: [],
        planned_deliveries: [],
      };
      return { hook_executions: [await executionEvidence(input, output)] };
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

async function executionEvidence(
  input: StageHookInput,
  output: StageHookOutput,
) {
  return {
    id: "019b7a2e-7c10-7000-8000-000000000010",
    attachment_id: declaration.attachment_id,
    phase: declaration.phase,
    pack_revision_id: declaration.pack_revision_id,
    hook_revision_id: declaration.hook_revision_id,
    input_digest: `sha256:${await canonicalSha256({
      schema: "changeset.hook-input.v1",
      declaration,
      operations: input.operations,
      projects: input.projects,
      pack_revisions: input.pack_revisions,
      proposed_states: input.proposed_states,
      base_states: input.base_states,
      grant_snapshot: input.grant_snapshot,
      previous_output_digest: null,
    })}`,
    output_digest: `sha256:${await canonicalSha256(output)}`,
    output,
    stderr: "",
    duration_ms: 1,
    grant_snapshot: grantSnapshot,
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
        pack_revisions: [{ revision_id: declaration.pack_revision_id }],
        hook_declarations: [declaration],
        grant_snapshot: grantSnapshot,
        proposed_states: { lead: { name: "A" } },
        base_states: { lead: null },
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
