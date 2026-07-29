// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import {
  assertNoIdleClients,
  commitAfterObservedLifecycleBarrier,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production dependency facts mutate only after the commit lifecycle waiter is observed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const base = await createGraph(matrix, "observed-dependencies");
      const object = await matrix.stage([
        update(matrix.projectId, base.alpha, "observed-object"),
      ]);
      await assertObservedOutcome(
        matrix,
        object.id,
        async () => {
          await commitOne(matrix, [
            update(matrix.projectId, base.alpha, "object-current-mutated"),
          ]);
        },
        "stage_stale",
        "object_version_changed",
      );

      const actionBase = await createGraph(matrix, "observed-action", false);
      const action = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "action",
        "stage",
        "test/commitmatrix:generate",
        "--input",
        JSON.stringify({
          project_id: matrix.projectId,
          source_id: actionBase.alpha,
        }),
      ]);
      assertEquals(action.code, 0, action.stderr);
      const actionStage = JSON.parse(action.stdout).data.id as string;
      await assertObservedOutcome(
        matrix,
        actionStage,
        async () => {
          await commitOne(matrix, [
            update(matrix.projectId, actionBase.alpha, "action-read-current"),
          ]);
        },
        "stage_stale",
        "object_version_changed",
      );

      const relationshipBase = await createGraph(
        matrix,
        "observed-relationship",
      );
      const relationship = await matrix.stage([{
        op: "unlink",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        relationship_id: relationshipBase.relationship,
      }]);
      await assertObservedOutcome(
        matrix,
        relationship.id,
        async () => {
          await commitOne(matrix, [{
            op: "unlink",
            project_id: matrix.projectId,
            relationship: "test/commitmatrix:alpha_beta",
            relationship_id: relationshipBase.relationship,
          }]);
        },
        "stage_stale",
        "relationship_version_changed",
      );

      for (const endpoint of ["alpha", "beta"] as const) {
        const graph = await createGraph(
          matrix,
          `observed-link-${endpoint}`,
          false,
        );
        const link = await matrix.stage([{
          op: "link",
          project_id: matrix.projectId,
          relationship: "test/commitmatrix:alpha_beta",
          from: graph.alpha,
          to: graph.beta,
          fields: { label: endpoint },
        }]);
        await assertObservedOutcome(
          matrix,
          link.id,
          async () => {
            await commitOne(matrix, [
              endpoint === "alpha"
                ? update(matrix.projectId, graph.alpha, "endpoint-current")
                : updateBeta(matrix.projectId, graph.beta, "endpoint-current"),
            ]);
          },
          "stage_stale",
          "object_version_changed",
        );
      }

      const commentBase = await createGraph(matrix, "observed-comment", false);
      const comment = await matrix.stage([{
        op: "comment",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: commentBase.alpha,
        body: "observed comment target",
      }]);
      await assertObservedOutcome(
        matrix,
        comment.id,
        async () => {
          await commitOne(matrix, [
            update(matrix.projectId, commentBase.alpha, "comment-current"),
          ]);
        },
        "stage_stale",
        "object_version_changed",
      );

      const fkBase = await createGraph(matrix, "observed-fk", false);
      const foreignKey = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: {
          key: "observed-fk-child",
          status: "ready",
          beta_id: fkBase.beta,
        },
      }]);
      await assertObservedOutcome(
        matrix,
        foreignKey.id,
        async () => {
          await commitOne(matrix, [
            updateBeta(matrix.projectId, fkBase.beta, "fk-current"),
          ]);
        },
        "stage_stale",
        "object_version_changed",
      );

      const project = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "observed-project", status: "ready" },
      }]);
      await assertObservedOutcome(
        matrix,
        project.id,
        async () => {
          await query(
            matrix.harness.server.sql,
            "update projects set version=version+1 where id=$1",
            [matrix.projectId],
          );
        },
        "stage_stale",
        "project_changed",
      );

      const seed = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "seed",
        "stage",
        "test/commitmatrix",
        "--seed",
        "alpha",
      ]);
      assertEquals(seed.code, 0, seed.stderr);
      const seedStage = JSON.parse(seed.stdout).data.stage.id as string;
      await assertObservedActiveSeedConflict(matrix, seedStage, async () => {
        const winner = await matrix.harness.runOptctl([
          "--json",
          "--project",
          matrix.projectId,
          "seed",
          "stage",
          "test/commitmatrix",
          "--seed",
          "alpha",
        ]);
        assertEquals(winner.code, 0, winner.stderr);
        const committed = await matrix.commit(
          JSON.parse(winner.stdout).data.stage.id,
        );
        assertEquals(committed.ok, true);
      }, "commitmatrix_alpha_active_key");

      const revision = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "observed-revision", status: "ready" },
      }]);
      await assertObservedOutcome(
        matrix,
        revision.id,
        async () => {
          await Deno.writeTextFile(
            `${matrix.pack}/pack.yaml`,
            `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: commitmatrix, version: 1.0.9 }\nspec: { purpose: Production observed revision., axi: {} }\n`,
          );
          const applied = await matrix.harness.runOptctl([
            "--json",
            "pack",
            "apply",
            matrix.pack,
            "--safe",
          ]);
          assertEquals(applied.code, 0, applied.stderr);
        },
        "stage_stale",
        "pack_revision_changed",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit reports exact object relationship link and comment dependency staleness",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const base = await createGraph(matrix, "dependency");
      const objectStage = await matrix.stage([
        update(matrix.projectId, base.alpha, "object-stale"),
      ]);
      await commitOne(matrix, [
        update(matrix.projectId, base.alpha, "object-winner"),
      ]);
      await assertStale(matrix, objectStage.id, "object_version_changed");

      const unlinkStage = await matrix.stage([{
        op: "unlink",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        relationship_id: base.relationship,
      }]);
      await commitOne(matrix, [{
        op: "unlink",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        relationship_id: base.relationship,
      }]);
      await assertStale(matrix, unlinkStage.id, "relationship_version_changed");

      const commentStage = await matrix.stage([{
        op: "comment",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: base.alpha,
        body: "staged before target update",
      }]);
      await commitOne(matrix, [
        update(matrix.projectId, base.alpha, "comment-winner"),
      ]);
      await assertStale(matrix, commentStage.id, "object_version_changed");

      const endpointBase = await createGraph(matrix, "endpoint", false);
      const linkStage = await matrix.stage([{
        op: "link",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        from: endpointBase.alpha,
        to: endpointBase.beta,
        fields: { label: "staged" },
      }]);
      await commitOne(matrix, [
        updateBeta(matrix.projectId, endpointBase.beta, "endpoint-winner"),
      ]);
      await assertStale(matrix, linkStage.id, "object_version_changed");
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit reports exact Project and referenced pack staleness while unrelated packs are ignored",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const projectStage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "project-stale", status: "ready" },
      }]);
      await query(
        matrix.harness.server.sql,
        "update projects set version=version+1 where id=$1",
        [matrix.projectId],
      );
      await assertStale(matrix, projectStage.id, "project_changed");

      const revisionStage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "revision-stale", status: "ready" },
      }]);
      await Deno.writeTextFile(
        `${matrix.pack}/pack.yaml`,
        `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: commitmatrix, version: 1.0.1 }\nspec: { purpose: Production commit matrix revision., axi: {} }\n`,
      );
      const applied = await matrix.harness.runOptctl([
        "--json",
        "pack",
        "apply",
        matrix.pack,
        "--safe",
      ]);
      assertEquals(applied.code, 0, applied.stderr);
      await assertStale(matrix, revisionStage.id, "pack_revision_changed");

      const unrelated = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "unrelated-success", status: "ready" },
      }]);
      await query(
        matrix.harness.server.sql,
        "update pack_active_revisions set activated_at=activated_at where publisher='operant' and pack_name='crm'",
      );
      const success = await matrix.commit(unrelated.id);
      assertEquals(success.ok, true);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

async function createGraph(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  prefix: string,
  link = true,
) {
  const operations: Record<string, unknown>[] = [{
    op: "create",
    key: "alpha",
    project_id: matrix.projectId,
    resource: "test/commitmatrix:alpha",
    fields: { key: `${prefix}-alpha`, status: "ready" },
  }, {
    op: "create",
    key: "beta",
    project_id: matrix.projectId,
    resource: "test/commitmatrix:beta",
    fields: { key: `${prefix}-beta`, status: "ready" },
  }];
  if (link) {
    operations.push({
      op: "link",
      key: "relationship",
      project_id: matrix.projectId,
      relationship: "test/commitmatrix:alpha_beta",
      from: { $ref: "alpha.object_id" },
      to: { $ref: "beta.object_id" },
      fields: { label: prefix },
    });
  }
  const stage = await matrix.stage(operations);
  const committed = await matrix.commit(stage.id);
  assertEquals(committed.ok, true);
  const find = (key: string, property: string) =>
    String(
      stage.operations.find((operation) => operation.key === key)?.[property] ??
        "",
    );
  return {
    alpha: find("alpha", "object_id"),
    beta: find("beta", "object_id"),
    relationship: link ? find("relationship", "relationship_id") : "",
  };
}

async function commitOne(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  operations: Record<string, unknown>[],
) {
  const stage = await matrix.stage(operations);
  const result = await matrix.commit(stage.id);
  assertEquals(result.ok, true);
}
function update(projectId: string, objectId: string, note: string) {
  return {
    op: "update",
    project_id: projectId,
    resource: "test/commitmatrix:alpha",
    object_id: objectId,
    set: { note },
  };
}
function updateBeta(projectId: string, objectId: string, note: string) {
  return {
    op: "update",
    project_id: projectId,
    resource: "test/commitmatrix:beta",
    object_id: objectId,
    set: { note },
  };
}
async function observedFailure(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  mutate: () => Promise<void>,
) {
  const result = await commitAfterObservedLifecycleBarrier(
    matrix,
    stageId,
    mutate,
  );
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected observed commit failure");
  assertEquals(
    (await query<{ count: string }>(
      matrix.harness.server.sql,
      "select count(*)::text count from changeset_commits where stage_id=$1",
      [stageId],
    )).rows[0].count,
    "0",
  );
  return result.error;
}

async function assertObservedOutcome(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  mutate: () => Promise<void>,
  code: string,
  reason?: string,
) {
  const error = await observedFailure(matrix, stageId, mutate);
  assertEquals(error.code, code);
  if (reason) {
    assertEquals(
      (error.details as Record<string, unknown>).reason,
      reason,
    );
  }
}

async function assertObservedActiveSeedConflict(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  mutate: () => Promise<void>,
  constraint: string,
) {
  const error = await observedFailure(matrix, stageId, mutate);
  assertEquals(error.code, "active_seed_key_conflict");
  assertEquals(error.details, { constraint });
}

async function assertStale(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
  reason: string,
) {
  const result = await matrix.commit(stageId);
  assertEquals(result.ok, false);
  if (result.ok) throw new Error("expected stale stage");
  assertEquals(result.error.code, "stage_stale");
  assertEquals(
    (result.error.details as Record<string, unknown>).reason,
    reason,
  );
  const facts = (await query<{ count: string }>(
    matrix.harness.server.sql,
    "select count(*)::text count from changeset_commits where stage_id=$1",
    [stageId],
  )).rows[0].count;
  assertEquals(facts, "0");
}
