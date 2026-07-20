import {
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

function equals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}
