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
const secondDeclaration: StageHookDeclaration = {
  ...declaration,
  attachment_id: "019b7a2e-7c10-7000-8000-000000000011",
  hook_revision_id: "019b7a2e-7c10-7000-8000-000000000012",
  hook: "operant/crm:validate",
  order: 1,
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

Deno.test("ordered multi-hook evidence reaches the real stage service", async () => {
  let persisted = false;
  const repository = fakeRepository(
    () => persisted = true,
    [declaration, secondDeclaration],
  );
  const service = makeStageChangesetService(repository, {
    async coordinate(input) {
      const first = await executionEvidence(input, emptyOutput(), declaration);
      const second = await executionEvidence(
        input,
        emptyOutput(),
        secondDeclaration,
        first.output_digest,
      );
      second.id = "019b7a2e-7c10-7000-8000-000000000013";
      return { hook_executions: [first, second] };
    },
  });
  const result = await service.stage(stageRequest(), auth);
  assertEquals(result.ok, true);
  assertEquals(persisted, true);
});

Deno.test("coordinator rejects duplicate and reordered multi-hook evidence", async () => {
  for (const mode of ["duplicate", "reordered"] as const) {
    let persisted = false;
    const repository = fakeRepository(
      () => persisted = true,
      [declaration, secondDeclaration],
    );
    const service = makeStageChangesetService(repository, {
      async coordinate(input) {
        const first = await executionEvidence(
          input,
          emptyOutput(),
          declaration,
        );
        const second = mode === "duplicate"
          ? structuredClone(first)
          : await executionEvidence(input, emptyOutput(), secondDeclaration);
        if (mode === "reordered") {
          return { hook_executions: [second, first] };
        }
        return { hook_executions: [first, second] };
      },
    });
    const result = await service.stage(stageRequest(), auth);
    assertEquals(result.ok, false, mode);
    if (!result.ok) assertEquals(result.error.code, "hook_rejected", mode);
    assertEquals(persisted, false, mode);
  }
});

Deno.test("coordinator rejects malformed immutable evidence without persistence", async () => {
  type Mutation = (result: Record<string, unknown>) => void;
  const digest = `sha256:${"9".repeat(64)}`;
  const cases: Array<[string, Mutation, boolean]> = [
    ["missing execution", (result) => result.hook_executions = [], true],
    ["extra execution", (result) => {
      const executions = result.hook_executions as unknown[];
      executions.push(structuredClone(executions[0]));
    }, true],
    [
      "aggregate supplied independently",
      (result) => result.warnings = [],
      true,
    ],
    ["invalid execution UUID", (result) => execution(result).id = "bad", true],
    [
      "wrong attachment",
      (result) => execution(result).attachment_id = auth.id,
      true,
    ],
    [
      "wrong hook",
      (result) => execution(result).hook_revision_id = auth.id,
      true,
    ],
    ["wrong phase", (result) => execution(result).phase = "action.stage", true],
    [
      "invalid input digest",
      (result) => execution(result).input_digest = digest,
      true,
    ],
    [
      "invalid output digest",
      (result) => execution(result).output_digest = digest,
      false,
    ],
    ["unknown output key", (result) => output(result).unknown = [], false],
    ["missing output key", (result) => delete output(result).effects, false],
    ["malformed stderr", (result) => execution(result).stderr = 1, true],
    [
      "malformed duration",
      (result) => execution(result).duration_ms = -1,
      true,
    ],
    ["arbitrary grant", (result) =>
      execution(result).grant_snapshot = {
        ...grantSnapshot,
        secret: "must-not-persist",
      }, true],
    ["secret-bearing grant", (result) =>
      execution(result).grant_snapshot = {
        ...grantSnapshot,
        policy_digest: "secret",
      }, true],
    ["duplicate reads", (result) =>
      output(result).read_dependencies = [
        validRead(),
        validRead(),
      ], false],
    [
      "malformed read",
      (result) => output(result).read_dependencies = [{}],
      false,
    ],
    ["malformed warning", (result) => output(result).warnings = [{}], false],
    ["duplicate approvals", (result) => {
      const requirement = {
        id: declaration.attachment_id,
        capability: "review",
      };
      output(result).approval_requirements = [requirement, requirement];
    }, false],
    [
      "malformed capability",
      (result) => output(result).required_capabilities = ["BAD"],
      false,
    ],
    [
      "duplicate effect",
      (result) => output(result).effects = ["valid", "valid"],
      false,
    ],
    [
      "duplicate event",
      (result) => output(result).planned_events = [{ id: "x" }, { id: "x" }],
      false,
    ],
    [
      "malformed delivery",
      (result) => output(result).planned_deliveries = [{}],
      false,
    ],
    ["patch conflict", (result) =>
      output(result).patch_outputs = [{
        operation_key: "lead",
        output: {
          patches: [
            { op: "replace", path: "/name", value: "B" },
            { op: "replace", path: "/name", value: "C" },
          ],
        },
      }], false],
    ["patch platform path", (result) =>
      output(result).patch_outputs = [{
        operation_key: "lead",
        output: {
          patches: [{ op: "add", path: "/object_id", value: auth.id }],
        },
      }], false],
    ["patch test failure", (result) =>
      output(result).patch_outputs = [{
        operation_key: "lead",
        output: { patches: [{ op: "test", path: "/name", value: "wrong" }] },
      }], false],
  ];
  for (const [name, mutate, preserveDigest] of cases) {
    let persisted = false;
    const repository = fakeRepository(() => persisted = true);
    const service = makeStageChangesetService(repository, {
      async coordinate(input) {
        const empty = emptyOutput();
        const result: Record<string, unknown> = {
          hook_executions: [await executionEvidence(input, empty)],
        };
        mutate(result);
        if (!preserveDigest && execution(result).output_digest !== digest) {
          execution(result).output_digest = `sha256:${await canonicalSha256(
            execution(result).output,
          )}`;
        }
        return result as never;
      },
    });
    const result = await service.stage(stageRequest(), auth);
    assertEquals(result.ok, false, name);
    if (!result.ok) assertEquals(result.error.code, "hook_rejected", name);
    assertEquals(persisted, false, name);
  }
});

Deno.test("coordinator-added operations fail closed before persistence", async () => {
  const additions: Array<[string, unknown[], string]> = [
    ["schema", [{}], "validation_failed"],
    ["bad ref", [{
      op: "create",
      key: "child",
      project_id: project,
      resource: "operant/crm:lead",
      fields: { parent_id: { $ref: "missing.object_id" } },
    }], "invalid_reference"],
    ["conflict", [{
      op: "create",
      key: "lead",
      project_id: project,
      resource: "operant/crm:lead",
      fields: { name: "duplicate" },
    }], "duplicate_key"],
    ["limit", Array.from({ length: 10_001 }, () => ({})), "hook_rejected"],
  ];
  for (const [name, addedOperations, expectedCode] of additions) {
    let persisted = false;
    const service = makeStageChangesetService(
      fakeRepository(() => persisted = true),
      {
        async coordinate(input) {
          const hookOutput = emptyOutput() as unknown as Record<
            string,
            unknown
          >;
          hookOutput.added_operations = addedOperations;
          return {
            hook_executions: [
              await executionEvidence(
                input,
                hookOutput as unknown as StageHookOutput,
              ),
            ],
          };
        },
      },
    );
    const result = await service.stage(stageRequest(), auth);
    assertEquals(result.ok, false, name);
    if (!result.ok) assertEquals(result.error.code, expectedCode, name);
    assertEquals(persisted, false, name);
  }
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

function stageRequest() {
  return {
    project_id: project,
    operations: [{
      op: "create" as const,
      key: "lead",
      resource: "operant/crm:lead",
      fields: { name: "A" },
    }],
  };
}

function emptyOutput(): StageHookOutput {
  return {
    added_operations: [],
    patch_outputs: [],
    read_dependencies: [],
    warnings: [],
    approval_requirements: [],
    required_capabilities: [],
    effects: [],
    planned_events: [],
    planned_deliveries: [],
  };
}

function execution(result: Record<string, unknown>): Record<string, unknown> {
  return (result.hook_executions as Record<string, unknown>[])[0];
}

function output(result: Record<string, unknown>): Record<string, unknown> {
  return execution(result).output as Record<string, unknown>;
}

function validRead() {
  return {
    kind: "policy",
    project_id: project,
    definition: "operant/crm:lead_policy",
    query_digest: `sha256:${"4".repeat(64)}`,
  };
}

async function executionEvidence(
  input: StageHookInput,
  output: StageHookOutput,
  pinnedDeclaration: StageHookDeclaration = declaration,
  previousOutputDigest: string | null = null,
) {
  return {
    id: "019b7a2e-7c10-7000-8000-000000000010",
    attachment_id: pinnedDeclaration.attachment_id,
    phase: pinnedDeclaration.phase,
    pack_revision_id: pinnedDeclaration.pack_revision_id,
    hook_revision_id: pinnedDeclaration.hook_revision_id,
    input_digest: `sha256:${await canonicalSha256({
      schema: "changeset.hook-input.v1",
      declaration: pinnedDeclaration,
      operations: input.operations,
      projects: input.projects,
      pack_revisions: input.pack_revisions,
      proposed_states: input.proposed_states,
      base_states: input.base_states,
      grant_snapshot: input.grant_snapshot,
      previous_output_digest: previousOutputDigest,
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
  declarations: StageHookDeclaration[] = [declaration],
): StageRepository {
  return {
    async hookInput(operations) {
      await Promise.resolve();
      return ok({
        operations,
        projects: [{ project_id: project }],
        pack_revisions: [{ revision_id: declaration.pack_revision_id }],
        hook_declarations: declarations,
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
