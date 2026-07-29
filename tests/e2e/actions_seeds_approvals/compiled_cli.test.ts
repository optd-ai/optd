// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  query,
  type Sql,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { isUuidV7, uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { makePostgresSeedStageRepository } from "../../../src/adapters/outbound/postgres/repositories/seed_stage_repository.ts";
import { startHttpProvider } from "../../support/http_provider.ts";
import {
  seedRead,
  writePack,
} from "../../integration/hook_secret_action_stage.test.ts";

for (const trace of [false, true]) {
  Deno.test({
    name: `forced-fresh compiled CLI action and seed canonical E2E (${
      trace ? "trace" : "default"
    })`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const provider = startHttpProvider([{
        kind: "success",
        body: { ok: true },
      }, { kind: "success", body: { ok: true } }]);
      const harness = await startLiveHarness({
        environment: {
          ...(trace ? { OPERANT_LOG_LEVEL: "trace" } : {}),
          OPERANT_COMMIT_LOCK_TIMEOUT: "100ms",
        },
      });
      const pack = await Deno.makeTempDir({
        prefix: "operant-actions-seeds-e2e-",
      });
      let actor: CliLauncher | undefined;
      let reviewer: CliLauncher | undefined;
      try {
        assertEquals(
          (await harness.bootstrap({
            username: "acceptance-admin",
            password: "acceptance bootstrap password",
            displayName: "Acceptance Administrator",
          })).code,
          0,
        );
        await writePack(pack, provider.url);
        assertEquals(
          (await harness.runOptctl(["--json", "pack", "apply", pack, "--safe"]))
            .code,
          0,
        );
        const project = await harness.runOptctl([
          "--json",
          "project",
          "create",
          "acceptance-project",
          "--display-name",
          "Acceptance Project",
        ]);
        assertEquals(project.code, 0, project.stderr);
        const projectId = JSON.parse(project.stdout).data.id as string;
        const read = await seedRead(harness, projectId);
        actor = await provisionOrdinary(
          harness,
          `actor-${trace ? "trace" : "default"}`,
          "all_projects",
        );
        reviewer = await provisionOrdinary(
          harness,
          `reviewer-${trace ? "trace" : "default"}`,
          "system",
        );

        const action = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ source_id: read.id }),
        ]);
        assertEquals(action.code, 0, action.stderr);
        const actionData = JSON.parse(action.stdout).data;
        assertEquals(actionData.source.kind, "action");
        assertEquals(
          actionData.source.identity.action,
          "test/actionproof:generate",
        );
        const authority = actionData.source.identity.authority_evidence;
        assertEquals(authority.targets.length, 1);
        assertEquals(authority.targets[0].project_id, projectId);
        assertEquals(
          authority.targets[0].resource,
          "test/actionproof:source",
        );
        assertEquals(authority.targets[0].object_id, read.id);
        assertEquals(
          authority.targets[0].object_version_id,
          read.object_version_id,
        );
        assertEquals(authority.targets[0].matched_rules.length, 1);
        assertEquals(authority.targets[0].role_assignment_ids.length, 1);
        assertEquals(
          /^sha256:[0-9a-f]{64}$/.test(authority.canonical_target_digest),
          true,
        );
        assertEquals(
          actionData.hook_executions.filter((item: { phase: string }) =>
            item.phase === "action.stage"
          ).length,
          1,
        );
        const inspect = await actor!.runOptctl([
          "--json",
          "changeset",
          "inspect",
          actionData.id,
        ]);
        assertEquals(
          JSON.parse(inspect.stdout).data.operation_graph_digest,
          actionData.operation_graph_digest,
        );
        const actionCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          actionData.id,
        ]);
        assertEquals(actionCommit.code, 0, actionCommit.stderr);
        const repeatedActionCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          actionData.id,
        ]);
        assertEquals(repeatedActionCommit.code, 0, repeatedActionCommit.stderr);
        assertEquals(
          JSON.parse(repeatedActionCommit.stdout).data,
          JSON.parse(actionCommit.stdout).data,
        );

        const missingRead = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          "test/actionproof:generate",
          "--input",
          JSON.stringify({ source_id: uuidV7() }),
        ]);
        assertEquals(missingRead.code, 1);
        const beforeSeed = await stageCount(harness.server.sql);
        const seed = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(seed.code, 0, seed.stderr);
        const seedData = JSON.parse(seed.stdout).data;
        assertEquals(seedData.stage.source.kind, "seed");
        assertEquals(await stageCount(harness.server.sql), beforeSeed + 1);
        const seedCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          seedData.stage.id,
        ]);
        assertEquals(seedCommit.code, 0, seedCommit.stderr);
        const repeatedSeedCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          seedData.stage.id,
        ]);
        assertEquals(repeatedSeedCommit.code, 0, repeatedSeedCommit.stderr);
        assertEquals(
          JSON.parse(repeatedSeedCommit.stdout).data,
          JSON.parse(seedCommit.stdout).data,
        );
        const unchanged = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(unchanged.code, 0, unchanged.stderr);
        assertEquals(JSON.parse(unchanged.stdout).data.stage, null);
        assertEquals(await stageCount(harness.server.sql), beforeSeed + 1);
        const seedObjectId = seedData.stage.operations[0].object_id;
        const targetTable = await runtimeTable(harness.server.sql, "target");
        await query(
          harness.server.sql,
          `update "${targetTable}" set status='stale',note='preserved extra' where project_id=$1 and id=$2`,
          [projectId, seedObjectId],
        );
        const changed = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(changed.code, 0, changed.stderr);
        const changedOperation =
          JSON.parse(changed.stdout).data.stage.operations[0];
        assertEquals(changedOperation.op, "update");
        assertEquals(changedOperation.object_id, seedObjectId);
        assertEquals(changedOperation.set, { status: "ready" });
        assertEquals(
          (await query<{ note: string }>(
            harness.server.sql,
            `select note from "${targetTable}" where id=$1`,
            [seedObjectId],
          )).rows[0].note,
          "preserved extra",
        );
        const toon = await actor!.runOptctl([
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(toon.code, 0, toon.stderr);
        assertEquals(toon.stdout.includes("status: staged"), true);

        const archivedVersionBefore = (await query<{
          current_object_version_id: string;
        }>(
          harness.server.sql,
          `select current_object_version_id from "${targetTable}" where id=$1`,
          [seedObjectId],
        )).rows[0].current_object_version_id;
        const archiveStage = await harness.runJson(
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "archive",
              project_id: projectId,
              resource: "test/actionproof:target",
              object_id: seedObjectId,
              expected_version: 1,
            }],
          },
        );
        assertEquals(archiveStage.code, 0, archiveStage.stderr);
        const archiveStageId = JSON.parse(archiveStage.stdout).data.id;
        const archiveCommit = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          archiveStageId,
        ]);
        assertEquals(archiveCommit.code, 0, archiveCommit.stderr);
        const firstHistoryBeforeLaterReplacement = await objectHistory(
          harness,
          projectId,
          seedObjectId,
        );
        assertCompleteArchivedHistory(
          firstHistoryBeforeLaterReplacement,
          seedObjectId,
        );
        const replacement = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(replacement.code, 0, replacement.stderr);
        const replacementStage = JSON.parse(replacement.stdout).data.stage;
        assertEquals(replacementStage.operations[0].op, "create");
        const replacementId = replacementStage.operations[0].object_id;
        assertEquals(isUuidV7(seedObjectId), true);
        assertEquals(isUuidV7(replacementId), true);
        assertEquals(replacementId === seedObjectId, false);
        const replacementCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          replacementStage.id,
        ]);
        assertEquals(replacementCommit.code, 0, replacementCommit.stderr);
        const replacementRepeat = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(replacementRepeat.code, 0, replacementRepeat.stderr);
        assertEquals(JSON.parse(replacementRepeat.stdout).data.stage, null);
        const secondArchiveStage = await harness.runJson(
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "archive",
              project_id: projectId,
              resource: "test/actionproof:target",
              object_id: replacementId,
              expected_version: 1,
            }],
          },
        );
        assertEquals(secondArchiveStage.code, 0, secondArchiveStage.stderr);
        const secondArchiveCommit = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          JSON.parse(secondArchiveStage.stdout).data.id,
        ]);
        assertEquals(secondArchiveCommit.code, 0, secondArchiveCommit.stderr);
        const secondHistoryBeforeLaterReplacement = await objectHistory(
          harness,
          projectId,
          replacementId,
        );
        assertCompleteArchivedHistory(
          secondHistoryBeforeLaterReplacement,
          replacementId,
        );
        const secondReplacement = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(secondReplacement.code, 0, secondReplacement.stderr);
        const secondReplacementStage = JSON.parse(secondReplacement.stdout).data
          .stage;
        const secondReplacementId = secondReplacementStage.operations[0]
          .object_id;
        assertEquals(isUuidV7(secondReplacementId), true);
        assertEquals(secondReplacementId === replacementId, false);
        assertEquals(secondReplacementId === seedObjectId, false);
        const secondReplacementCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          secondReplacementStage.id,
        ]);
        assertEquals(
          secondReplacementCommit.code,
          0,
          secondReplacementCommit.stderr,
        );
        const secondReplacementRepeat = await actor!.runOptctl([
          "--json",
          "--project",
          projectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(secondReplacementRepeat.code, 0);
        assertEquals(
          JSON.parse(secondReplacementRepeat.stdout).data.stage,
          null,
        );
        const generations = (await query<{
          id: string;
          version: number;
          archived_at: Date | null;
          current_object_version_id: string;
        }>(
          harness.server.sql,
          `select id,version::int version,archived_at,current_object_version_id from "${targetTable}" where project_id=$1 and name='Seeded Target' order by created_at,id`,
          [projectId],
        )).rows;
        assertEquals(generations.length, 3);
        assertEquals(
          generations.every((generation) => isUuidV7(generation.id)),
          true,
        );
        assertEquals(
          generations.every((generation) =>
            isUuidV7(generation.current_object_version_id)
          ),
          true,
        );
        assertEquals(generations[0].id, seedObjectId);
        assertEquals(generations[0].version, 2);
        assertEquals(generations[0].archived_at instanceof Date, true);
        assertEquals(generations[1].id, replacementId);
        assertEquals(generations[1].version, 2);
        assertEquals(generations[1].archived_at instanceof Date, true);
        assertEquals(generations[2].id, secondReplacementId);
        assertEquals(generations[2].version, 1);
        assertEquals(generations[2].archived_at, null);
        assertEquals(
          (await query<{ count: number }>(
            harness.server.sql,
            `select count(*)::int count from object_versions where object_id=$1 and id=$2`,
            [seedObjectId, archivedVersionBefore],
          )).rows[0].count,
          1,
        );
        const publicActive = await querySeedGenerations(
          harness,
          projectId,
          false,
        );
        assertEquals(publicActive.map((item) => item.id), [
          secondReplacementId,
        ]);
        const publicAll = await querySeedGenerations(harness, projectId, true);
        assertEquals(
          publicAll.map((item) => item.id).sort(),
          [seedObjectId, replacementId, secondReplacementId].sort(),
        );
        const firstArchivedHistory = await objectHistory(
          harness,
          projectId,
          seedObjectId,
        );
        const secondArchivedHistory = await objectHistory(
          harness,
          projectId,
          replacementId,
        );
        assertCompleteArchivedHistory(firstArchivedHistory, seedObjectId);
        assertCompleteArchivedHistory(secondArchivedHistory, replacementId);
        assertEquals(
          firstArchivedHistory,
          firstHistoryBeforeLaterReplacement,
        );
        assertEquals(
          secondArchivedHistory,
          secondHistoryBeforeLaterReplacement,
        );

        const concurrentProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `concurrent-${trace ? "trace" : "default"}`,
          "--display-name",
          "Concurrent Seed Project",
        ]);
        assertEquals(concurrentProject.code, 0, concurrentProject.stderr);
        const concurrentId = JSON.parse(concurrentProject.stdout).data
          .id as string;
        const concurrentStages = await Promise.all(
          [0, 1].map(() =>
            actor!.runOptctl([
              "--json",
              "--project",
              concurrentId,
              "seed",
              "stage",
              "test/actionproof",
              "--seed",
              "targets",
            ])
          ),
        );
        assertEquals(concurrentStages.map((result) => result.code), [0, 0]);
        const concurrentData = concurrentStages.map((result) =>
          JSON.parse(result.stdout).data.stage
        );
        assertEquals(
          concurrentData[0].operations[0].object_id ===
            concurrentData[1].operations[0].object_id,
          false,
        );
        const winnerStage = concurrentData[0];
        const loserStage = concurrentData[1];
        const loserLifecycle = holdRow(
          harness.server.sql,
          "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
          [loserStage.id],
        );
        await loserLifecycle.locked;
        const blockedLoserCommit = actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          loserStage.id,
          "--timeout",
          "30s",
        ]);
        await observeBlockedCommit(harness.server.sql);
        const winnerCommit = await harness.runOptctl([
          "--json",
          "changeset",
          "commit",
          winnerStage.id,
        ]);
        assertEquals(winnerCommit.code, 0, winnerCommit.stderr);
        loserLifecycle.release();
        await loserLifecycle.done;
        const rejectedCommit = await blockedLoserCommit;
        assertEquals(rejectedCommit.code, 1);
        const rejectedError = JSON.parse(rejectedCommit.stderr).error;
        assertEquals(
          rejectedError.code,
          "active_seed_key_conflict",
          rejectedCommit.stderr,
        );
        assertEquals(rejectedError.details, {
          constraint: "actionproof_target_active_name",
        });
        await assertNoAppliedFacts(
          harness.server.sql,
          targetTable,
          loserStage.id,
          loserStage.operations[0].object_id,
        );

        for (const seedWins of [true, false]) {
          await assertDirectSeedRace(
            harness,
            actor!,
            targetTable,
            trace,
            seedWins,
          );
        }

        await assertSeedRevisionBarriers(
          harness,
          actor!,
          pack,
          targetTable,
          trace,
        );
        await assertMultipleActiveFailsClosed(
          harness,
          actor!,
          targetTable,
          trace,
        );

        const sameStageProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `same-stage-${trace ? "trace" : "default"}`,
          "--display-name",
          "Same Stage Commit Project",
        ]);
        assertEquals(sameStageProject.code, 0, sameStageProject.stderr);
        const sameStageProjectId = JSON.parse(sameStageProject.stdout).data.id;
        const sameStage = await actor!.runOptctl([
          "--json",
          "--project",
          sameStageProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(sameStage.code, 0, sameStage.stderr);
        const sameStageId = JSON.parse(sameStage.stdout).data.stage.id;
        const sameStageCommits = await Promise.all(
          [0, 1].map(() =>
            actor!.runOptctl([
              "--json",
              "changeset",
              "commit",
              sameStageId,
            ])
          ),
        );
        assertEquals(sameStageCommits.map((result) => result.code), [0, 0]);
        assertEquals(
          JSON.parse(sameStageCommits[0].stdout).data,
          JSON.parse(sameStageCommits[1].stdout).data,
        );

        const retryProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `retry-${trace ? "trace" : "default"}`,
          "--display-name",
          "Commit Retry Project",
        ]);
        assertEquals(retryProject.code, 0, retryProject.stderr);
        const retryProjectId = JSON.parse(retryProject.stdout).data.id;
        const retryStage = await actor!.runOptctl([
          "--json",
          "--project",
          retryProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(retryStage.code, 0, retryStage.stderr);
        const retryStageId = JSON.parse(retryStage.stdout).data.stage.id;
        const hookFactsBeforeRetry = Number(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from staged_hook_executions",
          )).rows[0].count,
        );
        await query(
          harness.server.sql,
          "create sequence commit_retry_fault_sequence",
        );
        await query(
          harness.server.sql,
          `create function inject_commit_serialization_failure() returns trigger language plpgsql as $$
           begin
             if nextval('commit_retry_fault_sequence') <= 1 then
               raise exception 'injected serialization failure' using errcode='40001';
             end if;
             return new;
           end $$`,
        );
        await query(
          harness.server.sql,
          `create trigger inject_commit_serialization_failure before insert on changeset_commits
           for each row execute function inject_commit_serialization_failure()`,
        );
        const retriedCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          retryStageId,
        ]);
        assertEquals(retriedCommit.code, 0, retriedCommit.stderr);
        assertEquals(
          Number(
            (await query<{ count: string }>(
              harness.server.sql,
              "select count(*)::text count from staged_hook_executions",
            )).rows[0].count,
          ),
          hookFactsBeforeRetry,
        );
        const exhaustedProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `retry-exhausted-${trace ? "trace" : "default"}`,
          "--display-name",
          "Commit Retry Exhaustion Project",
        ]);
        assertEquals(exhaustedProject.code, 0, exhaustedProject.stderr);
        const exhaustedProjectId = JSON.parse(exhaustedProject.stdout).data.id;
        const exhaustedStage = await actor!.runOptctl([
          "--json",
          "--project",
          exhaustedProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(exhaustedStage.code, 0, exhaustedStage.stderr);
        const exhaustedStageId =
          JSON.parse(exhaustedStage.stdout).data.stage.id;
        const hookFactsBeforeExhaustion = Number(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from staged_hook_executions",
          )).rows[0].count,
        );
        await query(
          harness.server.sql,
          "select setval('commit_retry_fault_sequence',1,false)",
        );
        await query(
          harness.server.sql,
          `create or replace function inject_commit_serialization_failure() returns trigger language plpgsql as $$
           begin
             if nextval('commit_retry_fault_sequence') <= 100 then
               raise exception 'injected serialization failure' using errcode='40001';
             end if;
             return new;
           end $$`,
        );
        const exhaustedCommit = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          exhaustedStageId,
        ]);
        assertEquals(exhaustedCommit.code, 1);
        const exhaustedError = JSON.parse(exhaustedCommit.stderr).error;
        assertEquals(exhaustedError.code, "commit_retry_exhausted");
        assertEquals(exhaustedError.details.attempts, 4);
        assertEquals(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from changeset_commits where stage_id=$1",
            [exhaustedStageId],
          )).rows[0].count,
          "0",
        );
        assertEquals(
          Number(
            (await query<{ count: string }>(
              harness.server.sql,
              "select count(*)::text count from staged_hook_executions",
            )).rows[0].count,
          ),
          hookFactsBeforeExhaustion,
        );
        await query(
          harness.server.sql,
          "drop trigger inject_commit_serialization_failure on changeset_commits",
        );
        await query(
          harness.server.sql,
          "drop function inject_commit_serialization_failure()",
        );
        await query(
          harness.server.sql,
          "drop sequence commit_retry_fault_sequence",
        );

        const deadlockProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `deadlock-${trace ? "trace" : "default"}`,
          "--display-name",
          "Commit Deadlock Project",
        ]);
        assertEquals(deadlockProject.code, 0, deadlockProject.stderr);
        const deadlockProjectId = JSON.parse(deadlockProject.stdout).data.id;
        const deadlockStage = await actor!.runOptctl([
          "--json",
          "--project",
          deadlockProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(deadlockStage.code, 0, deadlockStage.stderr);
        const deadlockStageId = JSON.parse(deadlockStage.stdout).data.stage.id;
        const hookFactsBeforeDeadlock = Number(
          (await query<{ count: string }>(
            harness.server.sql,
            "select count(*)::text count from staged_hook_executions",
          )).rows[0].count,
        );
        await query(
          harness.server.sql,
          "create table commit_deadlock_barrier(id integer primary key, touched integer not null default 0)",
        );
        await query(
          harness.server.sql,
          "insert into commit_deadlock_barrier(id) select generate_series(1,1000)",
        );
        await query(
          harness.server.sql,
          "create sequence commit_deadlock_attempts",
        );
        await query(
          harness.server.sql,
          `create function inject_commit_deadlock() returns trigger language plpgsql as $$
           begin
             perform nextval('commit_deadlock_attempts');
             perform set_config('deadlock_timeout','50ms',true);
             update commit_deadlock_barrier set touched=touched+1 where id=1;
             return new;
           end $$`,
        );
        await query(
          harness.server.sql,
          `create trigger inject_commit_deadlock before insert on changeset_commits
           for each row execute function inject_commit_deadlock()`,
        );
        let blockerReady!: () => void;
        let beginCycle!: () => void;
        const ready = new Promise<void>((resolve) => blockerReady = resolve);
        const cycle = new Promise<void>((resolve) => beginCycle = resolve);
        const deadlockBlocker = harness.server.sql.begin(async (tx) => {
          await query(tx, "select set_config('deadlock_timeout','5s',true)");
          await query(
            tx,
            "update commit_deadlock_barrier set touched=touched+1",
          );
          blockerReady();
          await cycle;
          await query(
            tx,
            "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
            [deadlockStageId],
          );
        });
        await ready;
        const deadlockedCommit = actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          deadlockStageId,
          "--timeout",
          "2s",
        ]);
        await observeBlockedQuery(
          harness.server.sql,
          "insert into changeset_commits",
        );
        beginCycle();
        const [blockerOutcome, commitOutcome] = await Promise.allSettled([
          deadlockBlocker,
          deadlockedCommit,
        ]);
        if (blockerOutcome.status === "rejected") throw blockerOutcome.reason;
        if (commitOutcome.status === "rejected") throw commitOutcome.reason;
        const deadlockedResult = commitOutcome.value;
        assertEquals(deadlockedResult.code, 0, deadlockedResult.stderr);
        assertEquals(
          Number(
            (await query<{ last_value: string }>(
              harness.server.sql,
              "select last_value::text last_value from commit_deadlock_attempts",
            )).rows[0].last_value,
          ) >= 2,
          true,
        );
        assertEquals(
          Number(
            (await query<{ count: string }>(
              harness.server.sql,
              "select count(*)::text count from staged_hook_executions",
            )).rows[0].count,
          ),
          hookFactsBeforeDeadlock,
        );
        await query(
          harness.server.sql,
          "drop trigger inject_commit_deadlock on changeset_commits",
        );
        await query(
          harness.server.sql,
          "drop function inject_commit_deadlock()",
        );
        await query(
          harness.server.sql,
          "drop sequence commit_deadlock_attempts",
        );
        await query(harness.server.sql, "drop table commit_deadlock_barrier");

        const timeoutProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `timeout-${trace ? "trace" : "default"}`,
          "--display-name",
          "Commit Timeout Project",
        ]);
        assertEquals(timeoutProject.code, 0, timeoutProject.stderr);
        const timeoutProjectId = JSON.parse(timeoutProject.stdout).data.id;
        const timeoutStage = await actor!.runOptctl([
          "--json",
          "--project",
          timeoutProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
        ]);
        assertEquals(timeoutStage.code, 0, timeoutStage.stderr);
        const timeoutStageId = JSON.parse(timeoutStage.stdout).data.stage.id;
        let releaseLifecycle!: () => void;
        let lifecycleLocked!: () => void;
        const release = new Promise<void>((resolve) =>
          releaseLifecycle = resolve
        );
        const locked = new Promise<void>((resolve) =>
          lifecycleLocked = resolve
        );
        const blocker = harness.server.sql.begin(async (tx) => {
          await query(
            tx,
            "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
            [timeoutStageId],
          );
          lifecycleLocked();
          await release;
        });
        await locked;
        const defaultTimeout = await actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          timeoutStageId,
        ]);
        assertEquals(defaultTimeout.code, 1);
        assertEquals(
          JSON.parse(defaultTimeout.stderr).error.code,
          "commit_busy",
        );
        const longCommit = actor!.runOptctl([
          "--json",
          "changeset",
          "commit",
          timeoutStageId,
          "--timeout",
          "30s",
        ]);
        await observeBlockedCommit(harness.server.sql);
        releaseLifecycle();
        await blocker;
        const longResult = await longCommit;
        assertEquals(longResult.code, 0, longResult.stderr);

        const multiProject = await harness.runOptctl([
          "--json",
          "project",
          "create",
          `multi-${trace ? "trace" : "default"}`,
          "--display-name",
          "Multi Seed Project",
        ]);
        assertEquals(multiProject.code, 0, multiProject.stderr);
        const multiProjectId = JSON.parse(multiProject.stdout).data
          .id as string;
        const multiSeed = await actor!.runOptctl([
          "--json",
          "--project",
          multiProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets_alt",
          "--seed",
          "targets",
        ]);
        assertEquals(multiSeed.code, 0, multiSeed.stderr);
        const multiData = JSON.parse(multiSeed.stdout).data.stage;
        assertEquals(multiData.source.identity.seed_names, [
          "targets",
          "targets_alt",
        ]);
        assertEquals(
          [
            ...new Set(
              multiData.policy_decisions.map((decision: { action: string }) =>
                decision.action
              ),
            ),
          ].sort(),
          [
            "seed:test/actionproof:targets",
            "seed:test/actionproof:targets_alt",
          ],
        );
        const limited = await provisionOrdinary(
          harness,
          `limited-${trace ? "trace" : "default"}`,
          "all_projects",
          ["targets"],
        );
        const deniedMulti = await limited.runOptctl([
          "--json",
          "--project",
          multiProjectId,
          "seed",
          "stage",
          "test/actionproof",
          "--seed",
          "targets",
          "--seed",
          "targets_alt",
        ]);
        assertEquals(deniedMulti.code, 1);
        await limited.close();

        const approval = await insertApprovalFixture(harness.server.sql);
        const listed = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "approvals",
          approval.stageId,
        ]);
        assertEquals(listed.code, 0, listed.stderr);
        const approved = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "approve",
          approval.stageId,
          approval.requirementId,
          "--reason",
          "reviewed",
        ]);
        assertEquals(approved.code, 0, approved.stderr);
        const approvedData = JSON.parse(approved.stdout).data;
        assertEquals(approvedData.status, "ready");
        assertEquals(approvedData.operation_graph_digest, approval.digest);
        const duplicate = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "reject",
          approval.stageId,
          approval.requirementId,
          "--reason",
          "opposite duplicate",
        ]);
        assertEquals(duplicate.code, 0, duplicate.stderr);
        assertEquals(
          JSON.parse(duplicate.stdout).data.approval_decisions.length,
          1,
        );
        const rejectedFixture = await insertApprovalFixture(harness.server.sql);
        const rejected = await reviewer!.runOptctl([
          "--json",
          "changeset",
          "reject",
          rejectedFixture.stageId,
          rejectedFixture.requirementId,
          "--reason",
          "unsafe",
        ]);
        assertEquals(rejected.code, 0, rejected.stderr);
        assertEquals(JSON.parse(rejected.stdout).data.status, "rejected");
        assertEquals(
          (await reviewer!.runOptctl([
            "--json",
            "changeset",
            "approve",
            rejectedFixture.stageId,
            rejectedFixture.requirementId,
          ])).code,
          0,
        );

        for (
          const legacy of [
            ["action", "preview", "test/actionproof:generate", "--input", "{}"],
          ]
        ) {
          assertEquals(
            (await reviewer!.runOptctl([
              "--json",
              "--project",
              projectId,
              ...legacy,
            ])).code,
            2,
          );
        }
      } finally {
        await actor?.close();
        await reviewer?.close();
        await harness.close();
        await provider.close();
        await Deno.remove(pack, { recursive: true }).catch(() => undefined);
      }
    },
  });
}

async function provisionOrdinary(
  harness: LiveHarness,
  username: string,
  boundary: "all_projects" | "system",
  seedNames: string[] = ["targets", "targets_alt"],
): Promise<CliLauncher> {
  const password = `ordinary password ${username}`;
  const created = await harness.runOptctl([
    "--json",
    "auth",
    "user",
    "create",
    "--username",
    username,
    "--display-name",
    username,
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(created.code, 0, created.stderr);
  const principalId = (await query<{ principal_id: string }>(
    harness.server.sql,
    "select principal_id from human_users where username=$1",
    [username],
  )).rows[0].principal_id;
  const role = boundary === "system"
    ? "system:admin"
    : `system:${username.replaceAll("-", "_")}`;
  if (boundary !== "system") {
    await query(
      harness.server.sql,
      "insert into system_roles(id,display_name,active) values($1,$2,true)",
      [role, username],
    );
    await query(
      harness.server.sql,
      "insert into role_definition_versions(id,role_id,version,active) values($1,$2,1,true)",
      [uuidV7(), role],
    );
  }
  await query(
    harness.server.sql,
    "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,$3,$4,true)",
    [uuidV7(), principalId, role, boundary],
  );
  const version = uuidV7();
  await query(
    harness.server.sql,
    "insert into policy_definition_versions(id,policy_id,version,active) values($1,$2,1,true)",
    [version, `system:${username.replaceAll("-", "_")}`],
  );
  const capabilities = boundary === "system"
    ? [["changeset.approval.decide", "system:changeset-approval"]]
    : [
      ["action:test/actionproof:generate", "test/actionproof:source"],
      ...seedNames.map((
        name,
      ) => [`seed:test/actionproof:${name}`, `seed:test/actionproof:${name}`]),
      ["changeset.inspect", "changeset"],
      ["project.read", "*"],
    ];
  for (const [capability, resource] of capabilities) {
    await query(
      harness.server.sql,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind) values($1,$2,$3,$4,$5,'unconditional')",
      [uuidV7(), version, role, capability, resource],
    );
  }
  await query(
    harness.server.sql,
    "insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,$3,true)",
    [uuidV7(), version, boundary],
  );
  const launcher = await harness.createProcessTreeLauncher("human");
  const login = await launcher.runOptctl([
    "--json",
    "auth",
    "login",
    "--username",
    username,
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(login.code, 0, login.stderr);
  return launcher;
}

async function insertApprovalFixture(sql: Sql) {
  const auth = (await query<{ id: string; principal_id: string }>(
    sql,
    "select id,principal_id from auth_contexts order by created_at desc limit 1",
  )).rows[0];
  const stageId = uuidV7(),
    requirementId = uuidV7(),
    digest = `sha256:${"d".repeat(64)}`;
  await query(
    sql,
    `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json) values($1,1,'direct','{}',$2,$3,'{}',$4,$4,'{"schema":"changeset.operations.v1","operations":[]}','[]','[]','[]','[]','[]')`,
    [stageId, auth.id, auth.principal_id, digest],
  );
  await query(
    sql,
    `insert into staged_approval_requirements(id,stage_id,ordinal,requirement_json) values($1,$2,0,$3::jsonb)`,
    [requirementId, stageId, {
      id: requirementId,
      key: "acceptance_review",
      role: "system:admin",
      boundary: { type: "system" },
      minimum: 1,
      principal_types: ["human_user"],
      allow_initiator: true,
      expires_at: null,
      reason: "acceptance review",
    }],
  );
  await query(
    sql,
    "insert into staged_changeset_lifecycle(stage_id,status,version) values($1,'awaiting_approval',1)",
    [stageId],
  );
  return { stageId, requirementId, digest };
}

async function stageCount(sql: Parameters<typeof query>[0]) {
  return Number(
    (await query<{ count: string }>(
      sql,
      "select count(*)::text count from staged_changesets",
    )).rows[0].count,
  );
}
async function observeBlockedCommit(sql: Sql): Promise<void> {
  await observeBlockedQuery(sql, "staged_changeset_lifecycle");
}
async function observeBlockedQuery(sql: Sql, fragment: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const blocked = (await query<{ present: boolean }>(
      sql,
      `select exists(select 1 from pg_stat_activity
       where cardinality(pg_blocking_pids(pid))>0
         and position($1 in query)>0) present`,
      [fragment],
    )).rows[0]?.present;
    if (blocked) return;
    await Promise.resolve();
  }
  throw new Error(`bounded waiter observation failed for ${fragment}`);
}

async function runtimeTable(sql: Sql, name: string) {
  return (await query<{ table_name: string }>(
    sql,
    `select table_name from pack_runtime_tables where publisher='test' and pack_name='actionproof' and definition_kind='resource' and definition_name=$1`,
    [name],
  )).rows[0].table_name;
}

async function querySeedGenerations(
  harness: LiveHarness,
  projectId: string,
  includeArchived: boolean,
): Promise<Array<{ id: string }>> {
  const result = await harness.runOptctl([
    "--json",
    "--project",
    projectId,
    "query",
    "test/actionproof:target",
    "--where",
    'name == "Seeded Target"',
    "--sort",
    "created_at:asc",
    "--include-total",
    ...(includeArchived ? ["--include-archived"] : []),
  ]);
  assertEquals(result.code, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assertEquals(envelope.meta.total, envelope.data.items.length);
  return envelope.data.items;
}

async function objectHistory(
  harness: LiveHarness,
  projectId: string,
  objectId: string,
): Promise<Array<Record<string, unknown>>> {
  const result = await harness.runOptctl([
    "--json",
    "--project",
    projectId,
    "history",
    "test/actionproof:target",
    objectId,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.items;
}

function assertCompleteArchivedHistory(
  history: Array<Record<string, unknown>>,
  objectId: string,
) {
  assertEquals(isUuidV7(objectId), true);
  assertEquals(history.map((item) => item.kind), [
    "object_version",
    "object_version",
  ]);
  assertEquals(history.map((item) => item.version), [2, 1]);
  assertEquals(history.map((item) => item.operation), ["archive", "create"]);
  assertEquals(
    history.every((item) => isUuidV7(item.object_version_id)),
    true,
  );
}

async function assertNoAppliedFacts(
  sql: Sql,
  table: string,
  stageId: string,
  objectId: string,
) {
  const facts = (await query<Record<string, number>>(
    sql,
    `select
       (select count(*)::int from "${table}" where id::text=$2) objects,
       (select count(*)::int from changeset_commits where stage_id=$1) commits,
       (select count(*)::int from object_versions v where v.object_id::text=$2) versions,
       (select count(*)::int from audit_events a where a.changeset_commit_id in
          (select id from changeset_commits where stage_id=$1)) audits,
       (select count(*)::int from events e where e.changeset_commit_id in
          (select id from changeset_commits where stage_id=$1)) events,
       (select count(*)::int from outbox_deliveries d where d.changeset_commit_id in
          (select id from changeset_commits where stage_id=$1)) outbox`,
    [stageId, objectId],
  )).rows[0];
  assertEquals(facts, {
    objects: 0,
    commits: 0,
    versions: 0,
    audits: 0,
    events: 0,
    outbox: 0,
  });
}

function holdRow(
  sql: Sql,
  statement: string,
  params: unknown[],
) {
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const done = sql.begin(async (tx) => {
    await query(tx, statement, params);
    locked.resolve();
    await release.promise;
  });
  return { locked: locked.promise, release: release.resolve, done };
}

async function assertDirectSeedRace(
  harness: LiveHarness,
  actor: CliLauncher,
  targetTable: string,
  trace: boolean,
  seedWins: boolean,
) {
  const orientation = seedWins ? "seed-wins" : "direct-wins";
  const project = await harness.runOptctl([
    "--json",
    "project",
    "create",
    `${orientation}-${trace ? "trace" : "default"}`,
    "--display-name",
    `Direct Seed ${orientation}`,
  ]);
  assertEquals(project.code, 0, project.stderr);
  const projectId = JSON.parse(project.stdout).data.id as string;
  const seed = await actor.runOptctl([
    "--json",
    "--project",
    projectId,
    "seed",
    "stage",
    "test/actionproof",
    "--seed",
    "targets",
  ]);
  assertEquals(seed.code, 0, seed.stderr);
  const seedStage = JSON.parse(seed.stdout).data.stage;
  const direct = await harness.runJson(
    ["--json", "changeset", "stage"],
    {
      project_id: projectId,
      operations: [{
        op: "create",
        resource: "test/actionproof:target",
        fields: { name: "Seeded Target", status: "ready" },
      }],
    },
  );
  assertEquals(direct.code, 0, direct.stderr);
  const directStage = JSON.parse(direct.stdout).data;
  assertEquals(isUuidV7(seedStage.operations[0].object_id), true);
  assertEquals(isUuidV7(directStage.operations[0].object_id), true);

  const loser = seedWins ? directStage : seedStage;
  const winner = seedWins ? seedStage : directStage;
  const held = holdRow(
    harness.server.sql,
    "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
    [loser.id],
  );
  await held.locked;
  const loserCommit = (seedWins ? harness : actor).runOptctl([
    "--json",
    "changeset",
    "commit",
    loser.id,
    "--timeout",
    "30s",
  ]);
  await observeBlockedQuery(harness.server.sql, "staged_changeset_lifecycle");
  const winnerCommit = await (seedWins ? actor : harness).runOptctl([
    "--json",
    "changeset",
    "commit",
    winner.id,
  ]);
  assertEquals(winnerCommit.code, 0, winnerCommit.stderr);
  held.release();
  await held.done;
  const rejected = await loserCommit;
  assertEquals(rejected.code, 1);
  const error = JSON.parse(rejected.stderr).error;
  assertEquals(
    error.code,
    seedWins ? "constraint_conflict" : "active_seed_key_conflict",
  );
  assertEquals(
    error.details,
    seedWins ? {} : { constraint: "actionproof_target_active_name" },
  );
  await assertNoAppliedFacts(
    harness.server.sql,
    targetTable,
    loser.id,
    loser.operations[0].object_id,
  );
  const active = (await query<{ id: string }>(
    harness.server.sql,
    `select id from "${targetTable}" where project_id=$1 and name='Seeded Target' and archived_at is null`,
    [projectId],
  )).rows;
  assertEquals(active, [{ id: winner.operations[0].object_id }]);
}

async function stagedFactCounts(sql: Sql) {
  return (await query<Record<string, number>>(
    sql,
    `select
       (select count(*)::int from staged_changesets) stages,
       (select count(*)::int from staged_changeset_operations) operations,
       (select count(*)::int from staged_changeset_dependencies) dependencies,
       (select count(*)::int from staged_hook_executions) hooks,
       (select count(*)::int from staged_policy_decisions) policies,
       (select count(*)::int from staged_changeset_lifecycle) lifecycles`,
  )).rows[0];
}

async function assertSeedRevisionBarriers(
  harness: LiveHarness,
  actor: CliLauncher,
  pack: string,
  targetTable: string,
  trace: boolean,
) {
  const alternate = await Deno.makeTempDir({
    prefix: "operant-seed-revision-barrier-",
  });
  const active = (await query<{ id: string }>(
    harness.server.sql,
    `select candidate_revision_id id from pack_active_revisions where publisher='test' and pack_name='actionproof'`,
  )).rows[0].id;
  try {
    await copyTree(pack, alternate);
    const manifestPath = `${alternate}/pack.yaml`;
    await Deno.writeTextFile(
      manifestPath,
      (await Deno.readTextFile(manifestPath)).replace(
        "version: 1.0.0",
        "version: 1.0.1",
      ),
    );
    const preview = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      alternate,
    ]);
    assertEquals(preview.code, 0, preview.stderr);
    const alternateRevision = (await query<{ id: string }>(
      harness.server.sql,
      `select id from pack_candidate_revisions where publisher='test' and pack_name='actionproof' and version='1.0.1'`,
    )).rows[0].id;
    assertEquals(alternateRevision === active, false);

    const lookupProject = await harness.runOptctl([
      "--json",
      "project",
      "create",
      `seed-lookup-revision-${trace ? "trace" : "default"}`,
      "--display-name",
      "Seed Lookup Revision Barrier",
    ]);
    assertEquals(lookupProject.code, 0, lookupProject.stderr);
    const lookupProjectId = JSON.parse(lookupProject.stdout).data.id;
    const beforeStage = await stagedFactCounts(harness.server.sql);
    const projectHold = holdRow(
      harness.server.sql,
      "select id from projects where id=$1 for update",
      [lookupProjectId],
    );
    await projectHold.locked;
    const blockedStage = actor.runOptctl([
      "--json",
      "--project",
      lookupProjectId,
      "seed",
      "stage",
      "test/actionproof",
      "--seed",
      "targets",
    ]);
    await observeBlockedQuery(harness.server.sql, "projects where id");
    await query(
      harness.server.sql,
      `update pack_active_revisions set candidate_revision_id=$1 where publisher='test' and pack_name='actionproof'`,
      [alternateRevision],
    );
    projectHold.release();
    await projectHold.done;
    const stageResult = await blockedStage;
    assertEquals(stageResult.code, 1);
    assertEquals(JSON.parse(stageResult.stderr).error, {
      code: "project_conflict",
      message: "Semantic source revision changed before persistence",
      details: {},
    });
    assertEquals(await stagedFactCounts(harness.server.sql), beforeStage);
    await query(
      harness.server.sql,
      `update pack_active_revisions set candidate_revision_id=$1 where publisher='test' and pack_name='actionproof'`,
      [active],
    );

    const commitProject = await harness.runOptctl([
      "--json",
      "project",
      "create",
      `seed-commit-revision-${trace ? "trace" : "default"}`,
      "--display-name",
      "Seed Commit Revision Barrier",
    ]);
    assertEquals(commitProject.code, 0, commitProject.stderr);
    const commitProjectId = JSON.parse(commitProject.stdout).data.id;
    const staged = await actor.runOptctl([
      "--json",
      "--project",
      commitProjectId,
      "seed",
      "stage",
      "test/actionproof",
      "--seed",
      "targets",
    ]);
    assertEquals(staged.code, 0, staged.stderr);
    const stage = JSON.parse(staged.stdout).data.stage;
    const lifecycleHold = holdRow(
      harness.server.sql,
      "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
      [stage.id],
    );
    await lifecycleHold.locked;
    const blockedCommit = actor.runOptctl([
      "--json",
      "changeset",
      "commit",
      stage.id,
      "--timeout",
      "30s",
    ]);
    await observeBlockedQuery(
      harness.server.sql,
      "staged_changeset_lifecycle",
    );
    await query(
      harness.server.sql,
      `update pack_active_revisions set candidate_revision_id=$1 where publisher='test' and pack_name='actionproof'`,
      [alternateRevision],
    );
    lifecycleHold.release();
    await lifecycleHold.done;
    const firstFailure = await blockedCommit;
    const repeatedFailure = await actor.runOptctl([
      "--json",
      "changeset",
      "commit",
      stage.id,
    ]);
    for (const failure of [firstFailure, repeatedFailure]) {
      assertEquals(failure.code, 1);
      assertEquals(JSON.parse(failure.stderr).error.code, "stage_stale");
    }
    assertEquals(
      JSON.parse(firstFailure.stderr).error,
      JSON.parse(repeatedFailure.stderr).error,
    );
    await assertNoAppliedFacts(
      harness.server.sql,
      targetTable,
      stage.id,
      stage.operations[0].object_id,
    );
  } finally {
    await query(
      harness.server.sql,
      `update pack_active_revisions set candidate_revision_id=$1 where publisher='test' and pack_name='actionproof'`,
      [active],
    ).catch(() => undefined);
    await Deno.remove(alternate, { recursive: true }).catch(() => undefined);
  }
  assertEquals(
    (await query<{ id: string }>(
      harness.server.sql,
      `select candidate_revision_id id from pack_active_revisions where publisher='test' and pack_name='actionproof'`,
    )).rows[0].id,
    active,
  );
}

async function assertMultipleActiveFailsClosed(
  harness: LiveHarness,
  actor: CliLauncher,
  targetTable: string,
  trace: boolean,
) {
  const project = await harness.runOptctl([
    "--json",
    "project",
    "create",
    `multiple-active-${trace ? "trace" : "default"}`,
    "--display-name",
    "Multiple Active Corruption",
  ]);
  assertEquals(project.code, 0, project.stderr);
  const projectId = JSON.parse(project.stdout).data.id;
  const auth = (await query<{ id: string }>(
    harness.server.sql,
    "select id from auth_contexts order by created_at desc limit 1",
  )).rows[0].id;
  const objectIds = [uuidV7(), uuidV7()];
  const before = await stagedFactCounts(harness.server.sql);
  await query(
    harness.server.sql,
    "drop index actionproof_target_active_name",
  );
  try {
    await query(
      harness.server.sql,
      `insert into "${targetTable}"(id,project_id,created_by,updated_by,name,status)
       values($1,$3,$4,$4,'Seeded Target','ready'),($2,$3,$4,$4,'Seeded Target','ready')`,
      [objectIds[0], objectIds[1], projectId, auth],
    );
    const repository = makePostgresSeedStageRepository(
      harness.server.sql,
      { stageSource: () => Promise.reject(new Error("must not stage")) },
      {} as never,
    );
    await assertRejects(
      () =>
        repository.findActiveRow({
          publisher: "test",
          pack: "actionproof",
          resourceName: "target",
          projectId,
          key: "name",
          value: "Seeded Target",
        }),
      Error,
      "active-only seed uniqueness is violated",
    );
    const failed = await actor.runOptctl([
      "--json",
      "--project",
      projectId,
      "seed",
      "stage",
      "test/actionproof",
      "--seed",
      "targets",
    ]);
    assertEquals(failed.code, 1);
    assertEquals(JSON.parse(failed.stderr).error.code, "internal_error");
    assertEquals(await stagedFactCounts(harness.server.sql), before);
  } finally {
    await query(
      harness.server.sql,
      `delete from "${targetTable}" where id=any($1::uuid[])`,
      [objectIds],
    );
    await query(
      harness.server.sql,
      `create unique index actionproof_target_active_name on "${targetTable}" (project_id, name) where archived_at is null`,
    );
  }
  assertEquals(
    (await query<{ indexdef: string }>(
      harness.server.sql,
      `select indexdef from pg_indexes where schemaname='public' and tablename=$1 and indexname='actionproof_target_active_name'`,
      [targetTable],
    )).rows,
    [{
      indexdef:
        `CREATE UNIQUE INDEX actionproof_target_active_name ON public.${targetTable} USING btree (project_id, name) WHERE (archived_at IS NULL)`,
    }],
  );
  assertEquals(
    (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from "${targetTable}" where id=any($1::uuid[])`,
      [objectIds],
    )).rows[0].count,
    0,
  );
}

async function copyTree(source: string, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const from = `${source}/${entry.name}`;
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory) {
      await Deno.mkdir(to);
      await copyTree(from, to);
    } else {
      await Deno.copyFile(from, to);
    }
  }
}
