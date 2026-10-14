import { assert, assertEquals } from "@std/assert";
import { startCommitMatrix } from "../support/commit_revalidation_harness.ts";

Deno.test("historical import is explicit, validates lifecycle, and returns stable created identities", async () => {
  const matrix = await startCommitMatrix();
  try {
    const operation = {
      op: "create",
      key: "historical",
      workspace_id: matrix.workspaceId,
      resource: "test/commitmatrix:alpha",
      fields: { key: "historical", status: "done" },
    };
    const ordinary = await matrix.stageService.stage({
      operations: [operation],
    }, matrix.auth);
    assertEquals(ordinary.ok, false);
    const invalid = await matrix.stageService.stage({
      operations: [{
        ...operation,
        initial_state: "missing",
        import_reason: "Backfill",
      }],
    }, matrix.auth);
    assertEquals(invalid.ok, false);
    const stage = await matrix.stage([{
      ...operation,
      initial_state: "done",
      import_reason: "Imported completed work",
    }]);
    assertEquals(stage.status, "ready");
    const committed = await matrix.commit(stage.id);
    assert(committed.ok, JSON.stringify(committed));
    assertEquals(
      committed.value.created.historical,
      stage.operations[0].object_id,
    );
    const replay = await matrix.commit(stage.id);
    assertEquals(replay, committed);
  } finally {
    await matrix.close();
  }
});

Deno.test("super-admin approval bypass survives commit without the requirement role", async () => {
  const matrix = await startCommitMatrix();
  try {
    assertEquals(
      matrix.auth.roles.includes("test/commitmatrix:reviewer"),
      false,
    );
    const staged = await matrix.harness.runJson([
      "--json",
      "changeset",
      "stage",
    ], {
      operations: [{
        op: "create",
        key: "approval",
        workspace_id: matrix.workspaceId,
        resource: "test/commitmatrix:approval_case",
        fields: { key: "superadmin-parity" },
      }],
    });
    assertEquals(staged.code, 0, staged.stderr);
    const stage = JSON.parse(staged.stdout).data;
    assertEquals(stage.status, "awaiting_approval");
    const requirement = stage.approval_requirements[0] as { id: string };
    const decided = await matrix.stageRepository.decideApproval(
      stage.id,
      requirement.id,
      { decision: "approve", reason: "Reviewed" },
      matrix.auth,
    );
    assert(decided.ok, JSON.stringify(decided));
    assertEquals(decided.value.status, "ready");
    const committed = await matrix.commit(stage.id);
    assert(committed.ok, JSON.stringify(committed));
  } finally {
    await matrix.close();
  }
});
