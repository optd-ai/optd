import {
  type ActionStageHookDeclaration,
  TrustedStageHookCoordinator,
} from "../../../src/application/services/hooks/stage_hook_coordinator.ts";
import type {
  StageHookDeclaration,
  StageHookInput,
} from "../../../src/domain/changesets/stage.ts";

const IDS = {
  attachment1: "0198c4ba-42b8-7000-8000-000000000001",
  attachment2: "0198c4ba-42b8-7000-8000-000000000002",
  hook1: "0198c4ba-42b8-7000-8000-000000000003",
  hook2: "0198c4ba-42b8-7000-8000-000000000004",
  pack: "0198c4ba-42b8-7000-8000-000000000005",
};
const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;

function declaration(
  index: 1 | 2,
  script: string,
): StageHookDeclaration {
  return {
    attachment_id: index === 1 ? IDS.attachment1 : IDS.attachment2,
    hook_revision_id: index === 1 ? IDS.hook1 : IDS.hook2,
    pack_revision_id: IDS.pack,
    hook: `operant/test:hook_${index}`,
    phase: "changeset.before_stage",
    resource: "operant/test:item",
    operation_key: "item",
    order: index,
    script_digest: index === 1 ? SHA_A : SHA_B,
    security_digest: index === 1 ? SHA_B : SHA_A,
    script_content: script,
    timeout_ms: 5_000,
    output_schema: "patch.v1",
    permissions: { net: [], env: [] },
    secret_slots: [],
    input_mapping: { proposed: "$proposed" },
    condition: null,
    effects: [],
    declaration_digest: index === 1 ? SHA_A : SHA_B,
  };
}

Deno.test("trusted stage coordinator chains before-stage state in deterministic order", async () => {
  const first = declaration(
    1,
    `console.log(JSON.stringify({patches:[{op:"add",path:"/first",value:true}]}));`,
  );
  const second = declaration(
    2,
    `const value=JSON.parse(await new Response(Deno.stdin.readable).text());
     console.log(JSON.stringify({patches:[{op:"add",path:"/saw_first",value:value.input.proposed.first===true}]}));`,
  );
  const input: StageHookInput = {
    operations: [{
      key: "item",
      op: "create",
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      resource: "operant/test:item",
      fields: {},
    } as never],
    projects: [],
    pack_revisions: [],
    hook_declarations: [first, second],
    authority_snapshot: {
      principal_id: "0198c4ba-42b8-7000-8000-000000000011",
      auth_context_id: "0198c4ba-42b8-7000-8000-000000000012",
      assignment_digest: SHA_A,
      policy_digest: SHA_B,
    },
    proposed_states: { item: {} },
    base_states: { item: null },
  };
  const coordinator = new TrustedStageHookCoordinator({
    resolve() {
      return Promise.resolve({ values: {}, evidence: [] });
    },
  }, { cacheDir: await Deno.makeTempDir() });
  const result = await coordinator.coordinate(input);
  equals(result.hook_executions.length, 2);
  equals(
    result.hook_executions[1].output.patch_outputs[0].output.patches[0],
    { op: "add", path: "/saw_first", value: true },
  );
  equals(result.hook_executions[0].grant_snapshot, { grants: [] });
  equals(result.hook_executions[0].script_digest, SHA_A);
});

Deno.test("trusted action-stage seam enforces declared operation effects", async () => {
  const coordinator = new TrustedStageHookCoordinator({
    resolve() {
      return Promise.resolve({ values: {}, evidence: [] });
    },
  }, { cacheDir: await Deno.makeTempDir() });
  const action = {
    ...declaration(
      1,
      `console.log(JSON.stringify({operations:[{op:"create",resource:"operant/test:item",fields:{name:"generated"}}]}));`,
    ),
    phase: "action.stage",
    operation_key: null,
    output_schema: "changeset.operations.v1",
    effects: [{ resource: "operant/test:item", ops: ["create"] }],
    input_mapping: {
      request: "$action.input",
      actor: "$actor",
      record: "$reads.item",
    },
  } as ActionStageHookDeclaration;
  const second = {
    ...action,
    attachment_id: "0198c4ba-42b8-7000-8000-000000000031",
    hook_revision_id: "0198c4ba-42b8-7000-8000-000000000032",
    order: 2,
    script_content:
      `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text()); const input=envelope.input; if (input.request.name !== "generated" || input.request.actor.id !== "spoofed" || input.record.id !== "0198c4ba-42b8-7000-8000-000000000020" || JSON.stringify(input.actor) !== '{"id":"0198c4ba-42b8-7000-8000-000000000011","principal_type":"human_user"}' || Object.keys(input.actor).sort().join(",") !== "id,principal_type" || input.authority_snapshot !== undefined || envelope.authority_snapshot !== undefined || envelope.grant_snapshot !== undefined) throw new Error("uncurated input"); console.log(JSON.stringify({operations:[{op:"update",project_id:"0198c4ba-42b8-7000-8000-000000000010",resource:"operant/test:item",object_id:{$ref:"op_000001.object_id"},set:{status:"ready"}}]}));`,
    effects: [{ resource: "operant/test:item", ops: ["update"] }],
  } as ActionStageHookDeclaration;
  const result = await coordinator.runActionStage({
    action: "operant/test:generate",
    actor: {
      id: "0198c4ba-42b8-7000-8000-000000000011",
      principal_type: "human_user",
    },
    project_id: "0198c4ba-42b8-7000-8000-000000000010",
    input: { name: "generated", actor: { id: "spoofed", roles: ["admin"] } },
    reads: { item: { id: "0198c4ba-42b8-7000-8000-000000000020" } },
    read_dependencies: [{
      name: "item",
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      resource_identity: "operant/test:item",
      object_id: "0198c4ba-42b8-7000-8000-000000000020",
      object_version_id: "0198c4ba-42b8-7000-8000-000000000021",
    }],
    declarations: [second, action],
    authority_snapshot: {
      principal_id: "0198c4ba-42b8-7000-8000-000000000011",
      auth_context_id: "0198c4ba-42b8-7000-8000-000000000012",
      assignment_digest: SHA_A,
      policy_digest: SHA_B,
    },
  });
  equals(result.added_operations.length, 1);
  equals(result.hook_executions.length, 2);
  equals(
    result.hook_executions[1].added_operations[0].object_id,
    result.added_operations[0].object_id,
  );
  equals(result.added_operations[0].fields, {
    name: "generated",
    status: "ready",
  });
  equals(result.hook_executions[0].output_schema, "changeset.operations.v1");
  equals(
    Object.hasOwn(
      (result.hook_executions[0].output.operations as Record<
        string,
        unknown
      >[])[0],
      "project_id",
    ),
    false,
  );
  equals(
    result.hook_executions[0].added_operations[0].project_id,
    "0198c4ba-42b8-7000-8000-000000000010",
  );
  equals(result.hook_executions[0].added_operations.length, 1);
  equals(
    result.read_dependencies[0].object_version_id,
    "0198c4ba-42b8-7000-8000-000000000021",
  );

  let denied = false;
  try {
    await coordinator.runActionStage({
      action: "operant/test:generate",
      actor: {
        id: "0198c4ba-42b8-7000-8000-000000000011",
        principal_type: "human_user",
      },
      input: {},
      reads: { item: {} },
      read_dependencies: [{
        name: "item",
        project_id: "0198c4ba-42b8-7000-8000-000000000010",
        resource_identity: "operant/test:item",
        object_id: "0198c4ba-42b8-7000-8000-000000000020",
        object_version_id: "0198c4ba-42b8-7000-8000-000000000021",
      }],
      declarations: [{ ...action, effects: [] }],
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      authority_snapshot: result.hook_executions[0].authority_snapshot,
    });
  } catch (error) {
    denied = error instanceof Error && "code" in error &&
      error.code === "hook_effect_denied";
  }
  equals(denied, true);

  let limited = false;
  try {
    await coordinator.runActionStage({
      action: "operant/test:generate",
      actor: {
        id: "0198c4ba-42b8-7000-8000-000000000011",
        principal_type: "human_user",
      },
      input: {},
      reads: { item: {} },
      read_dependencies: [{
        name: "item",
        project_id: "0198c4ba-42b8-7000-8000-000000000010",
        resource_identity: "operant/test:item",
        object_id: "0198c4ba-42b8-7000-8000-000000000020",
        object_version_id: "0198c4ba-42b8-7000-8000-000000000021",
      }],
      declarations: [action],
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      authority_snapshot: result.hook_executions[0].authority_snapshot,
      limits: {
        maxOperations: 0,
        maxDepth: 64,
        maxGraphBytes: 1024,
        maxStringBytes: 1024,
      },
    });
  } catch (error) {
    limited = error instanceof Error && "code" in error &&
      error.code === "hook_invalid_output";
  }
  equals(limited, true);

  let undeclaredRead = false;
  try {
    await coordinator.runActionStage({
      action: "operant/test:generate",
      actor: {
        id: "0198c4ba-42b8-7000-8000-000000000011",
        principal_type: "human_user",
      },
      input: {},
      reads: {},
      declarations: [{
        ...action,
        input_mapping: { missing: "$reads.missing" },
      }],
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      authority_snapshot: result.hook_executions[0].authority_snapshot,
    });
  } catch (error) {
    undeclaredRead = error instanceof Error && "code" in error &&
      error.code === "hook_input_invalid";
  }
  equals(undeclaredRead, true);

  let crossProject = false;
  try {
    await coordinator.runActionStage({
      action: "operant/test:generate",
      actor: {
        id: "0198c4ba-42b8-7000-8000-000000000011",
        principal_type: "human_user",
      },
      project_id: "0198c4ba-42b8-7000-8000-000000000010",
      input: {},
      reads: { item: {} },
      read_dependencies: [{
        name: "item",
        project_id: "0198c4ba-42b8-7000-8000-000000000010",
        resource_identity: "operant/test:item",
        object_id: "0198c4ba-42b8-7000-8000-000000000020",
        object_version_id: "0198c4ba-42b8-7000-8000-000000000021",
      }],
      declarations: [{
        ...action,
        script_content:
          `console.log(JSON.stringify({operations:[{op:"create",project_id:"0198c4ba-42b8-7000-8000-000000000099",resource:"operant/test:item",fields:{name:"wrong project"}}]}));`,
      }],
      authority_snapshot: result.hook_executions[0].authority_snapshot,
    });
  } catch (error) {
    crossProject = error instanceof Error && "code" in error &&
      error.code === "hook_invalid_output";
  }
  equals(crossProject, true);
});

function equals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
