// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "jsr:@std/assert@1";
import { makeStageChangesetService } from "../../../src/application/services/changesets/stage_changesets.ts";
import type { StageRepository } from "../../../src/application/ports/stage_repository.ts";
import type { AuthContext } from "../../../src/domain/auth/model.ts";
import type { StageHookCoordinator } from "../../../src/domain/changesets/stage.ts";

Deno.test("failed pre-spawn authority never invokes hook coordinator or persistence", async () => {
  let coordinatorCalls = 0;
  let createCalls = 0;
  const repository = {
    hasHooks: () => Promise.resolve(true),
    hookInput: () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "forbidden",
          message: "current Project authority is unavailable",
          severity: "forbidden" as const,
        },
      }),
    create() {
      createCalls++;
      throw new Error("persistence must not run");
    },
  } as unknown as StageRepository;
  const coordinator = {
    coordinate() {
      coordinatorCalls++;
      throw new Error("child/provider must not run");
    },
  } as StageHookCoordinator;
  const service = makeStageChangesetService(repository, coordinator);
  const projectId = "0198c4ba-42b8-7000-8000-000000000010";
  const result = await service.stage({
    project_id: projectId,
    operations: [{
      op: "create",
      resource: "optd/test:item",
      fields: { name: "denied" },
    }],
  }, auth());
  assertEquals(result.ok, false);
  assertEquals(coordinatorCalls, 0);
  assertEquals(createCalls, 0);
});

function auth(): AuthContext {
  return {
    id: "0198c4ba-42b8-7000-8000-000000000001",
    principalId: "0198c4ba-42b8-7000-8000-000000000002",
    principalType: "human_user",
    humanUserId: "0198c4ba-42b8-7000-8000-000000000003",
    sessionId: "0198c4ba-42b8-7000-8000-000000000004",
    credentialKind: "human_full",
    roles: [],
    createdAt: "2026-07-20T00:00:00.000Z",
  };
}
