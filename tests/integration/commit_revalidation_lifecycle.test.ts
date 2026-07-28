// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  assertNoIdleClients,
  commitRepository,
  observeWaiters,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production commit lifecycle queues two same-stage waiters and returns one exact DTO",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const blocker = matrix.client(),
      firstClient = matrix.client(),
      secondClient = matrix.client();
    try {
      const initial = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "same-stage", status: "ready" },
      }]);
      const before = await immutableStage(
        matrix.harness.server.sql,
        initial.id,
      );
      let release!: () => void, held!: (pid: number) => void;
      const releasePromise = new Promise<void>((resolve) => release = resolve);
      const heldPromise = new Promise<number>((resolve) => held = resolve);
      const lock = blocker.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
          [initial.id],
        );
        held(pid);
        await releasePromise;
      });
      const blockerPid = await heldPromise;
      const first = commitRepository(firstClient).commit(
        initial.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      const firstWaiter = await observeWaiters(
        matrix.harness.server.sql,
        "staged_changeset_lifecycle",
        1,
        blockerPid,
      );
      const second = commitRepository(secondClient).commit(
        initial.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      const waiters = await observeWaiters(
        matrix.harness.server.sql,
        "staged_changeset_lifecycle",
        2,
      );
      assertEquals(waiters[0].blockers.includes(blockerPid), true);
      assertEquals(waiters[1].blockers.includes(firstWaiter[0].pid), true);
      release();
      await lock;
      const [one, two] = await Promise.all([first, second]);
      assertEquals(one.ok, true);
      assertEquals(two.ok, true);
      if (!one.ok || !two.ok) throw new Error("commit failed");
      assertEquals(two.value, one.value);
      assertEquals(await factCounts(matrix.harness.server.sql, initial.id), {
        commits: 1,
        versions: 1,
        audits: 2,
        events: 2,
        lifecycleStatus: "committed",
        lifecycleVersion: 2,
      });
      assertEquals(
        await immutableStage(matrix.harness.server.sql, initial.id),
        before,
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await Promise.all(
        [blocker.end(), firstClient.end(), secondClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit and cancellation are FIFO in both observed lifecycle orders",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      for (const firstKind of ["commit", "cancel"] as const) {
        const blocker = matrix.client(),
          commitClient = matrix.client(),
          cancelClient = matrix.client();
        try {
          const stage = await matrix.stage([{
            op: "create",
            project_id: matrix.projectId,
            resource: "test/commitmatrix:alpha",
            fields: { key: `order-${firstKind}`, status: "ready" },
          }]);
          let release!: () => void, held!: (pid: number) => void;
          const releasePromise = new Promise<void>((resolve) =>
            release = resolve
          );
          const heldPromise = new Promise<number>((resolve) => held = resolve);
          const lock = blocker.begin(async (tx) => {
            const pid = Number(
              (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
            );
            await tx.unsafe(
              "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
              [stage.id],
            );
            held(pid);
            await releasePromise;
          });
          const blockerPid = await heldPromise;
          const commit = () =>
            commitRepository(commitClient).commit(stage.id, matrix.auth, {
              lockTimeoutMs: 5_000,
            });
          const cancel = () =>
            new PostgresStageRepository(cancelClient as unknown as Sql).cancel(
              stage.id,
              "ordered",
              matrix.auth,
            );
          const first = firstKind === "commit" ? commit() : cancel();
          const firstWaiter = await observeWaiters(
            matrix.harness.server.sql,
            "staged_changeset_lifecycle",
            1,
            blockerPid,
          );
          const second = firstKind === "commit" ? cancel() : commit();
          const waiters = await observeWaiters(
            matrix.harness.server.sql,
            "staged_changeset_lifecycle",
            2,
          );
          assertEquals(waiters[0].blockers.includes(blockerPid), true);
          assertEquals(waiters[1].blockers.includes(firstWaiter[0].pid), true);
          release();
          await lock;
          const [firstResult, secondResult] = await Promise.all([
            first,
            second,
          ]);
          if (firstKind === "commit") {
            assertEquals(firstResult.ok, true);
            assertEquals(secondResult.ok, false);
            if (!secondResult.ok) {
              assertEquals(secondResult.error.code, "already_committed");
            }
            assertEquals(
              (await factCounts(matrix.harness.server.sql, stage.id)).commits,
              1,
            );
          } else {
            assertEquals(firstResult.ok, true);
            assertEquals(secondResult.ok, false);
            if (!secondResult.ok) {
              assertEquals(secondResult.error.code, "stage_cancelled");
            }
            assertEquals(
              await factCounts(matrix.harness.server.sql, stage.id),
              {
                commits: 0,
                versions: 0,
                audits: 0,
                events: 0,
                lifecycleStatus: "cancelled",
                lifecycleVersion: 2,
              },
            );
          }
        } finally {
          await Promise.all(
            [blocker.end(), commitClient.end(), cancelClient.end()].map((
              value,
            ) => value.catch(() => undefined)),
          );
        }
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production final approval rejection and commit are FIFO in every observed lifecycle order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      await query(
        matrix.harness.server.sql,
        `insert into role_assignments(id,principal_id,role_id,boundary_type,active)
         values($1,$2,'test/commitmatrix:reviewer','system',true)`,
        [uuidV7(), matrix.auth.principalId],
      );
      for (const decision of ["approve", "reject"] as const) {
        for (const firstKind of ["decision", "commit"] as const) {
          const blocker = matrix.client(),
            decisionClient = matrix.client(),
            commitClient = matrix.client();
          let release: (() => void) | undefined;
          let lock: Promise<unknown> | undefined;
          try {
            const stage = await stageApproval(
              matrix,
              `${decision}-${firstKind}`,
            );
            let held!: (pid: number) => void;
            const releasePromise = new Promise<void>((resolve) =>
              release = resolve
            );
            const heldPromise = new Promise<number>((resolve) =>
              held = resolve
            );
            lock = blocker.begin(async (tx) => {
              const pid = Number(
                (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
              );
              await tx.unsafe(
                "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
                [stage.id],
              );
              held(pid);
              await releasePromise;
            });
            const blockerPid = await heldPromise;
            const decide = () =>
              new PostgresStageRepository(decisionClient as unknown as Sql)
                .decideApproval(stage.id, stage.requirementId, {
                  decision,
                  reason: decision === "reject" ? "matrix rejection" : null,
                }, matrix.auth);
            const commit = () =>
              commitRepository(commitClient).commit(stage.id, matrix.auth, {
                lockTimeoutMs: 5_000,
              });
            const first = firstKind === "decision" ? decide() : commit();
            const firstWaiter = await observeWaiters(
              matrix.harness.server.sql,
              "staged_changeset_lifecycle",
              1,
              blockerPid,
            );
            const second = firstKind === "decision" ? commit() : decide();
            const waiters = await observeWaiters(
              matrix.harness.server.sql,
              "staged_changeset_lifecycle",
              2,
            );
            const secondWaiter = waiters.find((waiter) =>
              waiter.pid !== firstWaiter[0].pid
            );
            assertEquals(
              secondWaiter?.blockers.includes(firstWaiter[0].pid),
              true,
            );
            release?.();
            await lock;
            const [firstResult, secondResult] = await Promise.all([
              first,
              second,
            ]);
            if (firstKind === "decision" && decision === "approve") {
              assertEquals(firstResult.ok, true);
              assertEquals(secondResult.ok, true);
              assertEquals(
                (await factCounts(matrix.harness.server.sql, stage.id)).commits,
                1,
              );
            } else if (firstKind === "decision") {
              assertEquals(firstResult.ok, true);
              assertEquals(secondResult.ok, false);
              if (!secondResult.ok) {
                assertEquals(secondResult.error.code, "approval_changed");
              }
              assertEquals(
                (await factCounts(matrix.harness.server.sql, stage.id)).commits,
                0,
              );
            } else {
              assertEquals(firstResult.ok, false);
              if (!firstResult.ok) {
                assertEquals(firstResult.error.code, "approval_changed");
              }
              assertEquals(secondResult.ok, true);
              assertEquals(
                (await factCounts(matrix.harness.server.sql, stage.id)).commits,
                0,
              );
            }
          } finally {
            release?.();
            await lock?.catch(() => undefined);
            await Promise.all(
              [blocker.end(), decisionClient.end(), commitClient.end()].map((
                value,
              ) => value.catch(() => undefined)),
            );
          }
        }
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

async function stageApproval(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  suffix: string,
) {
  const result = await matrix.harness.runJson(
    ["--json", "changeset", "stage"],
    {
      operations: [{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:approval_case",
        fields: { key: `approval-${suffix}` },
      }],
    },
  );
  assertEquals(result.code, 0, result.stderr);
  const dto = JSON.parse(result.stdout).data;
  assertEquals(dto.status, "awaiting_approval");
  return {
    id: dto.id as string,
    requirementId: dto.approval_requirements[0].id as string,
  };
}

async function immutableStage(sql: Sql, stageId: string) {
  const tables = [
    "staged_changesets",
    "staged_changeset_operations",
    "staged_changeset_dependencies",
    "staged_hook_executions",
    "staged_policy_decisions",
    "staged_approval_requirements",
  ];
  const result: Record<string, unknown> = {};
  for (const table of tables) {
    result[table] = (await query(
      sql,
      `select to_jsonb(row_value) value from ${table} row_value where ${
        table === "staged_changesets" ? "id" : "stage_id"
      }=$1 order by 1::text`,
      [stageId],
    )).rows;
  }
  return result;
}

async function factCounts(sql: Sql, stageId: string) {
  const row = (await query<{
    commits: string;
    versions: string;
    audits: string;
    events: string;
    lifecycle_status: string;
    lifecycle_version: string;
  }>(
    sql,
    `select
    (select count(*) from changeset_commits where stage_id=$1)::text commits,
    (select count(*) from object_versions where changeset_commit_id in (select id from changeset_commits where stage_id=$1))::text versions,
    (select count(*) from audit_events where changeset_commit_id in (select id from changeset_commits where stage_id=$1))::text audits,
    (select count(*) from events where changeset_commit_id in (select id from changeset_commits where stage_id=$1))::text events,
    lifecycle.status lifecycle_status,lifecycle.version::text lifecycle_version
    from staged_changeset_lifecycle lifecycle where lifecycle.stage_id=$1`,
    [stageId],
  )).rows[0];
  return {
    commits: Number(row.commits),
    versions: Number(row.versions),
    audits: Number(row.audits),
    events: Number(row.events),
    lifecycleStatus: row.lifecycle_status,
    lifecycleVersion: Number(row.lifecycle_version),
  };
}
