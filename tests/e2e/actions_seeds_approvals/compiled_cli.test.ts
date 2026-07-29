// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  type Sql,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";
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
        const concurrentCommits = await Promise.all(
          concurrentData.map((stage) =>
            actor!.runOptctl([
              "--json",
              "changeset",
              "commit",
              stage.id,
            ])
          ),
        );
        assertEquals(
          concurrentCommits.map((result) => result.code).sort(),
          [0, 1],
        );
        const rejectedCommit = concurrentCommits.find((result) =>
          result.code !== 0
        )!;
        assertEquals(
          JSON.parse(rejectedCommit.stderr).error.code,
          "active_seed_key_conflict",
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
