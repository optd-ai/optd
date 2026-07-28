// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { isUuidV7, uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { startHttpProvider } from "../../support/http_provider.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

for (const logLevel of ["info", "trace"] as const) {
  Deno.test({
    name:
      `forced-fresh CLI and automatic durable outbox use real provider (${logLevel})`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const provider = startHttpProvider();
      const host = new URL(provider.url).host;
      const secretV1 = `outbox-private-v1-${crypto.randomUUID()}`;
      const secretV2 = `outbox-private-v2-${crypto.randomUUID()}`;
      const secretKey = btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      );
      const harness = await startLiveHarness({
        forceFreshCompile: true,
        environment: {
          OPERANT_LOG_LEVEL: logLevel,
          OPERANT_SECRET_MASTER_KEY: secretKey,
          OPERANT_HOOK_NET_ALLOW: host,
          OPERANT_OUTBOX_POLL_INTERVAL_MS: "10",
          OPERANT_OUTBOX_BATCH_SIZE: "4",
          OPERANT_OUTBOX_LEASE_MARGIN_MS: "1000",
          OPERANT_OUTBOX_INITIAL_BACKOFF_MS: "10",
          OPERANT_OUTBOX_MAX_BACKOFF_MS: "100",
          OPERANT_OUTBOX_MAX_RETRY_AFTER_MS: "1000",
          OPERANT_OUTBOX_SHUTDOWN_GRACE_MS: "3000",
        },
      });
      const pack = await Deno.makeTempDir({ prefix: "durable-outbox-pack-" });
      const outputs: string[] = [];
      try {
        assertStringIncludes(harness.binaryPath, harness.binarySourceDigest);
        assertStringIncludes(harness.binaryPath, harness.rootDir);
        await successful(
          harness.bootstrap({
            username: "outbox-admin",
            password: "durable outbox bootstrap password",
            displayName: "Outbox Administrator",
          }),
          outputs,
        );
        const project = json(
          await successful(
            harness.runOptctl([
              "--json",
              "project",
              "create",
              `outbox-${crypto.randomUUID().slice(0, 8)}`,
              "--display-name",
              "Durable Outbox",
            ]),
            outputs,
          ),
        );
        const projectId = String(project.data.id);

        await writePack(pack, provider.url, "1.0.0", "V1");
        await successful(
          harness.runOptctl([
            "--json",
            "pack",
            "apply",
            pack,
            "--safe",
          ]),
          outputs,
        );
        const validHookYaml = await Deno.readTextFile(
          `${pack}/hooks/deliver.yaml`,
        );
        for (const invalid of ["version ==", 'version == "one"']) {
          await Deno.writeTextFile(
            `${pack}/hooks/deliver.yaml`,
            validHookYaml.replace(
              `active() && event_type == "object.created" && version == 1 && object_version_id != null && actor.id != null`,
              invalid,
            ),
          );
          const rejectedPreview = await harness.runOptctl([
            "--json",
            "pack",
            "preview",
            pack,
          ]);
          assertNotEquals(rejectedPreview.code, 0);
          outputs.push(rejectedPreview.stdout, rejectedPreview.stderr);
        }
        await Deno.writeTextFile(`${pack}/hooks/deliver.yaml`, validHookYaml);
        await successful(
          harness.runOptctl([
            "--json",
            "secret",
            "create",
            "outbox_token",
            "--stdin",
            "--description",
            "durable outbox provider token",
          ], `${secretV1}\n`),
          outputs,
        );
        await successful(
          harness.runOptctl([
            "--json",
            "secret",
            "grant",
            "outbox_token",
            "--hook",
            "test/durableoutbox:deliver",
            "--slot",
            "token",
          ]),
          outputs,
        );
        const grantId = String(
          (await query<{ grant_id: string }>(
            harness.server.sql,
            `select head.grant_id from hook_secret_grant_heads head
           join pack_component_revisions hook on hook.id=head.hook_revision_id
           where hook.definition_kind='hook' and hook.definition_name='deliver'
             and head.slot='token' order by hook.id desc limit 1`,
          )).rows[0].grant_id,
        );
        provider.enqueue({ kind: "success" });
        const normal = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "normal",
        );
        const normalDelivery = await deliveryForStage(harness, normal.stageId);
        await waitStatus(harness, normalDelivery.id, "succeeded");
        const normalRequests = provider.attempts.filter((attempt) =>
          attempt.idempotencyKey === normalDelivery.id
        );
        assert(normalRequests.length >= 1);
        const normalBody = JSON.parse(normalRequests[0].body);
        assertEquals(normalBody.actor_keys, [
          "auth_context_id",
          "human_user_id",
          "id",
        ]);
        assertEquals(normalBody.object_version_present, true);
        assertEquals(
          JSON.stringify(normalBody).match(
            /token|bearer|session|roles|capabilities|credential/i,
          ),
          null,
        );
        assert(normal.commit.data);
        provider.enqueue(
          { kind: "success", body: { directive: "retry" } },
          { kind: "success" },
        );
        const ambiguous = await stageCommit(
          harness,
          pack,
          projectId,
          "ambiguous",
          "ambiguous",
        );
        const ambiguousDelivery = await deliveryForStage(
          harness,
          ambiguous.stageId,
        );
        await provider.waitForKeyAttempts(ambiguousDelivery.id, 2, 10_000);
        await waitStatus(harness, ambiguousDelivery.id, "succeeded");
        const ambiguousRequests = provider.attempts.filter((item) =>
          item.idempotencyKey === ambiguousDelivery.id
        );
        assert(ambiguousRequests.length >= 2);
        assertEquals(
          new Set(ambiguousRequests.map((item) => item.idempotencyKey)).size,
          1,
        );
        assertEquals(
          provider.effects.filter((item) =>
            item.idempotencyKey === ambiguousDelivery.id
          ).length,
          1,
        );
        const ambiguousAttempts = await attemptRows(
          harness,
          ambiguousDelivery.id,
        );
        assert(ambiguousAttempts.length >= 2);
        assertNotEquals(ambiguousAttempts[0].id, ambiguousAttempts[1].id);
        await installPauseTrigger(harness);
        const delayed = await stageCommit(
          harness,
          pack,
          projectId,
          "retry_after",
          "retry-after",
        );
        const delayedDelivery = await deliveryForStage(
          harness,
          delayed.stageId,
        );
        provider.enqueueForKey(
          delayedDelivery.id,
          { kind: "retry", retryAfterSeconds: 60 },
          { kind: "success" },
        );
        await releasePaused(harness, delayedDelivery.id);
        await provider.waitForKeyAttempts(delayedDelivery.id, 1, 10_000);
        const retryWait = await waitStatus(
          harness,
          delayedDelivery.id,
          "retry_wait",
        );
        const inspected = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "inspect",
              delayedDelivery.id,
            ]),
            outputs,
          ),
        );
        assertEquals(retryWait.status, "retry_wait");
        assertEquals(inspected.data.id, delayedDelivery.id);
        const beforeCount = provider.attempts.length;
        if (Date.now() < new Date(String(retryWait.available_at)).getTime()) {
          assertEquals(provider.attempts.length, beforeCount);
        }
        await query(
          harness.server.sql,
          "update outbox_deliveries set available_at=now() where id=$1 and status='retry_wait'",
          [delayedDelivery.id],
        );
        await waitStatus(harness, delayedDelivery.id, "succeeded");
        provider.enqueue({ kind: "permanent_failure" });
        const permanent = await stageCommit(
          harness,
          pack,
          projectId,
          "permanent",
          "permanent",
        );
        const permanentDelivery = await deliveryForStage(
          harness,
          permanent.stageId,
        );
        await waitStatus(harness, permanentDelivery.id, "dead_letter");
        const permanentHistory = await attemptRows(
          harness,
          permanentDelivery.id,
        );
        assertEquals(permanentHistory.length, 1);
        const repairedToken = `repaired-${permanentDelivery.id}`;
        provider.enqueueForKey(permanentDelivery.id, {
          kind: "hold",
          token: repairedToken,
        });
        await successful(
          harness.runOptctl([
            "--json",
            "outbox",
            "retry",
            permanentDelivery.id,
            "--reason",
            "provider destination repaired",
          ]),
          outputs,
        );
        await provider.waitForKeyAttempts(permanentDelivery.id, 2);
        provider.release(repairedToken);
        await waitStatus(harness, permanentDelivery.id, "succeeded");
        const repaired = await deliveryAggregate(harness, permanentDelivery.id);
        assertEquals(repaired.retry_generation, 1);
        assertEquals(repaired.attempts_in_generation, 1);
        assertEquals(repaired.total_attempts, 2);
        provider.enqueue({ kind: "hold", token: "crash" });
        const crashing = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "crash",
        );
        const crashDelivery = await deliveryForStage(harness, crashing.stageId);
        await waitStatus(harness, crashDelivery.id, "running");
        const runningCancel = await harness.runOptctl([
          "--json",
          "outbox",
          "cancel",
          crashDelivery.id,
          "--reason",
          "cannot recall running request",
        ]);
        assertNotEquals(runningCancel.code, 0);
        assertStringIncludes(runningCancel.stderr, "delivery_in_progress");
        outputs.push(runningCancel.stdout, runningCancel.stderr);
        await provider.waitForKeyAttempts(crashDelivery.id, 1, 10_000);
        await harness.crash();
        provider.release("crash");
        const stillRunning = await delivery(harness, crashDelivery.id);
        assertEquals(stillRunning.status, "running");
        await harness.restart();
        await waitStatus(harness, crashDelivery.id, "succeeded", 40_000);
        const crashAttempts = await attemptRows(harness, crashDelivery.id);
        assertEquals(
          crashAttempts.some((item) => item.outcome === "lease_expired"),
          true,
        );
        assertEquals(
          new Set(crashAttempts.map((item) => item.idempotency_key)).size,
          1,
        );
        await installPauseTrigger(harness);
        const providerBeforeCancel = provider.attempts.length;
        const pendingCancel = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "pending-cancel",
        );
        const pendingCancelDelivery = await deliveryForStage(
          harness,
          pendingCancel.stageId,
        );
        await successful(
          harness.runOptctl([
            "--json",
            "outbox",
            "cancel",
            pendingCancelDelivery.id,
            "--reason",
            "destination retired",
          ]),
          outputs,
        );
        assertEquals(
          (await delivery(harness, pendingCancelDelivery.id)).status,
          "cancelled",
        );
        assertEquals(provider.attempts.length, providerBeforeCancel);
        const queued = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "pinned-v1",
        );
        const queuedDelivery = await deliveryForStage(harness, queued.stageId);
        assertEquals(
          (await delivery(harness, queuedDelivery.id)).status,
          "pending",
        );
        await writePack(pack, provider.url, "2.0.0", "V2");
        await successful(
          harness.runOptctl([
            "--json",
            "pack",
            "apply",
            pack,
            "--reviewed",
          ]),
          outputs,
        );
        await successful(
          harness.runOptctl([
            "--json",
            "secret",
            "rotate",
            "outbox_token",
            "--stdin",
          ], `${secretV2}\n`),
          outputs,
        );
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, queuedDelivery.id);
        await waitStatus(harness, queuedDelivery.id, "succeeded");
        const pinnedRequest = provider.attempts.find((item) =>
          item.idempotencyKey === queuedDelivery.id
        );
        assert(pinnedRequest);
        const pinnedBody = JSON.parse(pinnedRequest.body);
        assertEquals(pinnedBody.script, "V1");
        assertEquals(pinnedBody.secret_version, "v2");
        const evidence = await attemptRows(harness, queuedDelivery.id);
        assertEquals(
          evidence.at(-1)?.grant_evidence_json?.[0]?.grant_id,
          grantId,
        );
        assertEquals(
          Number(evidence.at(-1)?.grant_evidence_json?.[0]?.value_version),
          2,
        );
        await successful(
          harness.runOptctl([
            "--json",
            "secret",
            "grant",
            "outbox_token",
            "--hook",
            "test/durableoutbox:deliver",
            "--slot",
            "token",
          ]),
          outputs,
        );

        await installPauseTrigger(harness);
        const drainWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "concurrent-drain",
        );
        const drainDelivery = await deliveryForStage(
          harness,
          drainWork.stageId,
        );
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, drainDelivery.id);
        await harness.runConcurrent([
          { args: ["--json", "outbox", "drain", "--limit", "1"] },
          { args: ["--json", "outbox", "drain", "--limit", "1"] },
        ]);
        await waitStatus(harness, drainDelivery.id, "succeeded");
        assert(
          (await provider.waitForKeyAttempts(drainDelivery.id, 1, 10_000))
            .length >= 1,
        );

        await installPauseTrigger(harness);
        const slow = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "slow-earlier",
        );
        const slowDelivery = await deliveryForStage(harness, slow.stageId);
        const fast = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "fast-later",
        );
        const fastDelivery = await deliveryForStage(harness, fast.stageId);
        provider.enqueue(
          { kind: "hold", token: "slow-earlier" },
          { kind: "success" },
        );
        await releasePaused(harness, slowDelivery.id);
        await provider.waitForKeyAttempts(slowDelivery.id, 1, 10_000);
        await makeReady(harness, fastDelivery.id);
        await successful(
          harness.runOptctl([
            "--json",
            "outbox",
            "drain",
            "--limit",
            "1",
          ]),
          outputs,
        );
        await provider.waitForKeyAttempts(fastDelivery.id, 1, 10_000);
        await waitStatus(harness, fastDelivery.id, "succeeded");
        assertEquals(
          (await delivery(harness, slowDelivery.id)).status,
          "running",
        );
        provider.release("slow-earlier");
        await waitStatus(harness, slowDelivery.id, "succeeded");

        await addHookB(pack, provider.url);
        await successful(
          harness.runOptctl(["--json", "pack", "apply", pack, "--safe"]),
          outputs,
        );
        const normalObjectId = String(
          (await query<{ object_id: string }>(
            harness.server.sql,
            "select object_id from events where id=$1",
            [normalDelivery.event_id],
          )).rows[0].object_id,
        );
        provider.enqueue({ kind: "success" });
        const hookBUpdate = await stageUpdateCommit(
          harness,
          pack,
          projectId,
          normalObjectId,
        );
        const hookBDelivery = await deliveryForStage(
          harness,
          hookBUpdate.stageId,
        );
        await waitStatus(harness, hookBDelivery.id, "succeeded");
        const hookBIdentity = String(
          (await query<{ hook_identity: string }>(
            harness.server.sql,
            "select hook_identity from outbox_deliveries where id=$1",
            [hookBDelivery.id],
          )).rows[0].hook_identity,
        );
        assertEquals(hookBIdentity, "test/durableoutbox:deliver_b");
        const tiedDeliveries = (await query<{
          id: string;
          created_at: string;
        }>(
          harness.server.sql,
          `select delivery.id,delivery.created_at::text
           from outbox_deliveries delivery
           join changeset_commits commit on commit.id=delivery.changeset_commit_id
           where commit.stage_id=$1 order by delivery.id desc`,
          [hookBUpdate.stageId],
        )).rows;
        assertEquals(tiedDeliveries.length, 2);
        assertEquals(
          tiedDeliveries[0].created_at,
          tiedDeliveries[1].created_at,
        );
        for (const tied of tiedDeliveries) {
          await waitStatus(harness, tied.id, "succeeded");
        }
        const tiedJsonPages = await collectListPages(
          harness,
          true,
          ["--hook", "test/durableoutbox:deliver_b", "--limit", "1"],
          outputs,
        );
        const tiedToonPages = await collectListPages(
          harness,
          false,
          ["--hook", "test/durableoutbox:deliver_b", "--limit", "1"],
          outputs,
        );
        const tiedExpected = tiedDeliveries.map((row) => row.id);
        assertEquals(tiedJsonPages.pageCount, 2);
        assertEquals(tiedToonPages.pageCount, 2);
        assertEquals(tiedJsonPages.ids, tiedExpected);
        assertEquals(tiedToonPages.ids, tiedExpected);
        assertEquals(tiedToonPages.items, tiedJsonPages.items);
        assertEquals(tiedJsonPages.terminalCursor, null);
        assertEquals(tiedToonPages.terminalCursor, null);

        await installPauseTrigger(harness);
        const statusPending = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-pending",
        );
        const statusPendingDelivery = await deliveryForStage(
          harness,
          statusPending.stageId,
        );
        const statusCancelled = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-cancelled",
        );
        const statusCancelledDelivery = await deliveryForStage(
          harness,
          statusCancelled.stageId,
        );
        await successful(
          harness.runOptctl([
            "--json",
            "outbox",
            "cancel",
            statusCancelledDelivery.id,
            "--reason",
            "status fixture",
          ]),
          outputs,
        );
        const statusSucceeded = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-succeeded",
        );
        const statusSucceededDelivery = await deliveryForStage(
          harness,
          statusSucceeded.stageId,
        );
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, statusSucceededDelivery.id);
        await waitStatus(harness, statusSucceededDelivery.id, "succeeded");

        await installPauseTrigger(harness);
        const statusDead = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-dead",
        );
        const statusDeadDelivery = await deliveryForStage(
          harness,
          statusDead.stageId,
        );
        provider.enqueue({ kind: "permanent_failure" });
        await releasePaused(harness, statusDeadDelivery.id);
        await waitStatus(harness, statusDeadDelivery.id, "dead_letter");

        await installPauseTrigger(harness);
        const statusRetry = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-retry",
        );
        const statusRetryDelivery = await deliveryForStage(
          harness,
          statusRetry.stageId,
        );
        provider.enqueue({ kind: "retry", retryAfterSeconds: 60 });
        await releasePaused(harness, statusRetryDelivery.id);
        await waitStatus(harness, statusRetryDelivery.id, "retry_wait");
        await query(
          harness.server.sql,
          "update outbox_deliveries set available_at=now()+interval '1 day' where id=$1",
          [statusRetryDelivery.id],
        );

        await installPauseTrigger(harness);
        const statusRunning = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "status-running",
        );
        const statusRunningDelivery = await deliveryForStage(
          harness,
          statusRunning.stageId,
        );
        provider.enqueueForKey(statusRunningDelivery.id, {
          kind: "hold",
          token: "status-running",
        });
        await releasePaused(harness, statusRunningDelivery.id);
        await waitStatus(harness, statusRunningDelivery.id, "running");
        const statusFixtures: Record<string, string> = {
          pending: statusPendingDelivery.id,
          running: statusRunningDelivery.id,
          retry_wait: statusRetryDelivery.id,
          succeeded: statusSucceededDelivery.id,
          dead_letter: statusDeadDelivery.id,
          cancelled: statusCancelledDelivery.id,
        };
        for (
          const status of [
            "pending",
            "running",
            "retry_wait",
            "succeeded",
            "dead_letter",
            "cancelled",
          ]
        ) {
          const result = toon(
            await successful(
              harness.runOptctl(["outbox", "list", "--status", status]),
              outputs,
            ),
          );
          assert(result.data.items.length > 0, `${status} list was empty`);
          assertEquals(
            result.data.items.every((item: Record<string, unknown>) =>
              item.status === status
            ),
            true,
          );
          assertEquals(
            result.data.items.some((item: Record<string, unknown>) =>
              item.id === statusFixtures[status]
            ),
            true,
          );
        }
        provider.release("status-running");
        await waitStatus(harness, statusRunningDelivery.id, "succeeded");

        const listed = await successful(
          harness.runOptctl([
            "--json",
            "outbox",
            "list",
            "--status",
            "succeeded",
            "--limit",
            "1",
          ]),
          outputs,
        );
        assertStringIncludes(listed.stdout, "next_cursor");
        const listedJson = json(listed);
        const firstListItem = listedJson.data.items[0];
        for (
          const field of [
            "id",
            "event_id",
            "hook_identity",
            "status",
            "retry_generation",
            "attempts_in_generation",
            "total_attempts",
            "max_attempts",
            "available_at",
            "created_at",
            "updated_at",
          ]
        ) assert(Object.hasOwn(firstListItem, field), `list omitted ${field}`);
        const toonListed = toon(
          await successful(
            harness.runOptctl([
              "outbox",
              "list",
              "--status",
              "succeeded",
              "--limit",
              "1",
            ]),
            outputs,
          ),
        );
        assertEquals(toonListed.data, listedJson.data);
        const nextCursor = listedJson.data.page?.next_cursor;
        if (typeof nextCursor === "string") {
          const jsonContinuation = json(
            await successful(
              harness.runOptctl([
                "--json",
                "outbox",
                "list",
                "--status",
                "succeeded",
                "--limit",
                "1",
                "--cursor",
                nextCursor,
              ]),
              outputs,
            ),
          );
          const toonContinuation = toon(
            await successful(
              harness.runOptctl([
                "outbox",
                "list",
                "--status",
                "succeeded",
                "--limit",
                "1",
                "--cursor",
                nextCursor,
              ]),
              outputs,
            ),
          );
          assertEquals(toonContinuation.data, jsonContinuation.data);
          assertNotEquals(
            jsonContinuation.data.items[0]?.id,
            firstListItem.id,
          );
          const pageIds = [
            firstListItem.id,
            ...jsonContinuation.data.items.map((
              item: Record<string, unknown>,
            ) => item.id),
          ];
          assertEquals(new Set(pageIds).size, pageIds.length);
          assertEquals(
            new Date(firstListItem.created_at).getTime() >=
              new Date(jsonContinuation.data.items[0].created_at).getTime(),
            true,
          );
          for (const asJson of [true, false]) {
            const mismatch = await harness.runOptctl([
              ...asJson ? ["--json"] : [],
              "outbox",
              "list",
              "--status",
              "dead_letter",
              "--cursor",
              nextCursor,
            ]);
            assertNotEquals(mismatch.code, 0);
            const mismatchEnvelope = errorOutput(mismatch, asJson);
            assertEquals(mismatchEnvelope.error.code, "invalid_cursor");
            assertEquals(mismatchEnvelope.error.details, {});
            outputs.push(mismatch.stdout, mismatch.stderr);
          }
        }
        const expectedSucceededIds = (await query<{ id: string }>(
          harness.server.sql,
          `select id from outbox_deliveries
           where status='succeeded' order by created_at desc,id desc`,
        )).rows.map((row) => row.id);
        const jsonListPages = await collectListPages(
          harness,
          true,
          ["--status", "succeeded", "--limit", "2"],
          outputs,
        );
        const toonListPages = await collectListPages(
          harness,
          false,
          ["--status", "succeeded", "--limit", "2"],
          outputs,
        );
        assert(jsonListPages.pageCount >= 3);
        assert(toonListPages.pageCount >= 3);
        assertEquals(jsonListPages.terminalCursor, null);
        assertEquals(toonListPages.terminalCursor, null);
        assertEquals(jsonListPages.ids, expectedSucceededIds);
        assertEquals(toonListPages.ids, expectedSucceededIds);
        assertEquals(toonListPages.items, jsonListPages.items);
        assertEquals(new Set(jsonListPages.ids).size, jsonListPages.ids.length);
        assertEquals(
          jsonListPages.items.map((item: Record<string, unknown>) => [
            item.created_at,
            item.id,
          ]),
          [...jsonListPages.items].sort(compareDeliveryRows).map(
            (item: Record<string, unknown>) => [item.created_at, item.id],
          ),
        );

        const insideInstant = new Date(statusSucceededDelivery.created_at)
          .getTime();
        const insideFrom = new Date(insideInstant - 1).toISOString();
        const insideTo = new Date(insideInstant + 1).toISOString();
        const filterCases = [
          {
            args: ["--status", "succeeded"],
            target: statusSucceededDelivery.id,
            contrasts: [statusPendingDelivery.id],
            predicate: (row: Record<string, any>) => row.status === "succeeded",
          },
          {
            args: ["--hook", "test/durableoutbox:deliver"],
            target: normalDelivery.id,
            contrasts: [tiedDeliveries[0].id],
            predicate: (row: Record<string, any>) =>
              row.hook_identity === "test/durableoutbox:deliver",
          },
          {
            args: ["--hook", "test/durableoutbox:deliver_b"],
            target: tiedDeliveries[0].id,
            contrasts: [normalDelivery.id],
            predicate: (row: Record<string, any>) =>
              row.hook_identity === "test/durableoutbox:deliver_b",
          },
          {
            args: ["--event", normalDelivery.event_id],
            target: normalDelivery.id,
            contrasts: [hookBDelivery.id, statusSucceededDelivery.id],
            predicate: (row: Record<string, any>) =>
              row.event_id === normalDelivery.event_id,
          },
          {
            args: ["--event", hookBDelivery.event_id],
            target: tiedDeliveries[0].id,
            contrasts: [normalDelivery.id],
            predicate: (row: Record<string, any>) =>
              row.event_id === hookBDelivery.event_id,
          },
          {
            args: ["--from", insideFrom],
            target: statusSucceededDelivery.id,
            contrasts: [normalDelivery.id],
            predicate: (row: Record<string, any>) =>
              Date.parse(row.created_at) >= Date.parse(insideFrom),
          },
          {
            args: ["--to", insideTo],
            target: statusSucceededDelivery.id,
            contrasts: [statusDeadDelivery.id],
            predicate: (row: Record<string, any>) =>
              Date.parse(row.created_at) <= Date.parse(insideTo),
          },
          {
            args: ["--from", insideFrom, "--to", insideTo],
            target: statusSucceededDelivery.id,
            contrasts: [normalDelivery.id, statusDeadDelivery.id],
            predicate: (row: Record<string, any>) =>
              Date.parse(row.created_at) >= Date.parse(insideFrom) &&
              Date.parse(row.created_at) <= Date.parse(insideTo),
          },
          {
            args: [
              "--status",
              "succeeded",
              "--hook",
              "test/durableoutbox:deliver",
              "--event",
              statusSucceededDelivery.event_id,
              "--from",
              insideFrom,
              "--to",
              insideTo,
            ],
            target: statusSucceededDelivery.id,
            contrasts: [
              statusPendingDelivery.id,
              tiedDeliveries[0].id,
              normalDelivery.id,
              statusDeadDelivery.id,
            ],
            dimensionContrasts: {
              status: statusPendingDelivery.id,
              hook: tiedDeliveries[0].id,
              event: normalDelivery.id,
              before_from: normalDelivery.id,
              after_to: statusDeadDelivery.id,
            },
            predicate: (row: Record<string, any>) =>
              row.status === "succeeded" &&
              row.hook_identity === "test/durableoutbox:deliver" &&
              row.event_id === statusSucceededDelivery.event_id &&
              Date.parse(row.created_at) >= Date.parse(insideFrom) &&
              Date.parse(row.created_at) <= Date.parse(insideTo),
          },
        ];
        for (const testCase of filterCases) {
          const jsonFiltered = json(
            await successful(
              harness.runOptctl([
                "--json",
                "outbox",
                "list",
                ...testCase.args,
              ]),
              outputs,
            ),
          );
          const toonFiltered = toon(
            await successful(
              harness.runOptctl(["outbox", "list", ...testCase.args]),
              outputs,
            ),
          );
          assertEquals(toonFiltered.data, jsonFiltered.data);
          assertEquals(jsonFiltered.data.page.limit, 50);
          assertEquals(
            jsonFiltered.data.filters,
            expectedFilters(testCase.args),
          );
          const rows = jsonFiltered.data.items as Array<Record<string, any>>;
          assert(rows.length > 0);
          const ids = rows.map((row) => row.id);
          assertEquals(ids.includes(testCase.target), true);
          for (const contrast of testCase.contrasts) {
            assertEquals(ids.includes(contrast), false);
          }
          for (
            const contrast of Object.values(testCase.dimensionContrasts ?? {})
          ) assertEquals(ids.includes(contrast), false);
          assertEquals(rows.every(testCase.predicate), true);
        }
        const deliveryInspection = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "inspect",
              queuedDelivery.id,
            ]),
            outputs,
          ),
        ).data;
        for (
          const field of [
            "attachment_id",
            "hook_identity",
            "hook_revision_id",
            "candidate_revision_id",
            "script_digest",
            "security_digest",
            "attachment_digest",
            "config_digest",
            "envelope_schema",
            "output_schema",
            "event_id",
            "object_version_id",
            "attempts_summary",
            "available_actions",
            "help",
          ]
        ) {
          assert(
            Object.hasOwn(deliveryInspection, field),
            `inspect omitted ${field}`,
          );
        }
        const toonInspection = toon(
          await successful(
            harness.runOptctl(["outbox", "inspect", queuedDelivery.id]),
            outputs,
          ),
        ).data;
        assertEquals(toonInspection, deliveryInspection);
        assertEquals(
          JSON.stringify(toonInspection).match(
            /ciphertext|nonce|key_id|secret_value|bearer|session|roles|capabilities/i,
          ),
          null,
        );

        provider.enqueue(
          { kind: "success", body: { directive: "retry" } },
          { kind: "success", body: { directive: "retry" } },
          { kind: "success" },
        );
        const pagedAttemptWork = await stageCommit(
          harness,
          pack,
          projectId,
          "ambiguous",
          "attempt-pagination",
        );
        const pagedAttemptDelivery = await deliveryForStage(
          harness,
          pagedAttemptWork.stageId,
        );
        await waitStatus(harness, pagedAttemptDelivery.id, "succeeded");
        const expectedAttemptIds = (await query<{ id: string }>(
          harness.server.sql,
          `select id from outbox_attempts where delivery_id=$1
           order by total_attempt_number,id`,
          [pagedAttemptDelivery.id],
        )).rows.map((row) => row.id);
        assert(expectedAttemptIds.length >= 3);
        const jsonAttemptPages = await collectAttemptPages(
          harness,
          true,
          pagedAttemptDelivery.id,
          outputs,
        );
        const toonAttemptPages = await collectAttemptPages(
          harness,
          false,
          pagedAttemptDelivery.id,
          outputs,
        );
        assert(jsonAttemptPages.pageCount >= 3);
        assert(toonAttemptPages.pageCount >= 3);
        assertEquals(jsonAttemptPages.terminalCursor, null);
        assertEquals(toonAttemptPages.terminalCursor, null);
        assertEquals(jsonAttemptPages.ids, expectedAttemptIds);
        assertEquals(toonAttemptPages.ids, expectedAttemptIds);
        assertEquals(toonAttemptPages.items, jsonAttemptPages.items);
        assertEquals(
          new Set(jsonAttemptPages.ids).size,
          jsonAttemptPages.ids.length,
        );
        assertEquals(
          jsonAttemptPages.items.map((item: Record<string, unknown>) =>
            item.total_attempt_number
          ),
          [1, 2, 3],
        );

        const firstAttempts = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "attempts",
              pagedAttemptDelivery.id,
              "--limit",
              "1",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(firstAttempts.items.length, 1);
        const safeAttempt = firstAttempts.items[0];
        for (
          const field of [
            "id",
            "retry_generation",
            "attempt_number",
            "total_attempt_number",
            "worker_instance_id",
            "hook_revision_id",
            "started_at",
            "lease_expires_at",
            "completed_at",
            "outcome",
            "hook_execution_id",
            "state",
            "grants",
          ]
        ) assert(Object.hasOwn(safeAttempt, field), `attempt omitted ${field}`);
        assertEquals(safeAttempt.total_attempt_number, 1);
        assertEquals(safeAttempt.attempt_number, 1);
        assertEquals(safeAttempt.retry_generation, 0);
        assertEquals(typeof safeAttempt.worker_instance_id, "string");
        assertEquals(typeof safeAttempt.hook_revision_id, "string");
        assertEquals(Array.isArray(safeAttempt.grants), true);
        assertEquals(safeAttempt.grants.length, 1);
        assertEquals(typeof safeAttempt.grants[0].grant_id, "string");
        assertEquals(safeAttempt.grants[0].slot, "token");
        assertEquals(typeof safeAttempt.grants[0].secret_id, "string");
        assertEquals(safeAttempt.grants[0].value_version, 2);
        assertEquals(
          JSON.stringify(safeAttempt).match(
            /"(?:env|name|value|ciphertext|nonce|key_id)"/i,
          ),
          null,
        );
        const toonFirstAttempts = toon(
          await successful(
            harness.runOptctl([
              "outbox",
              "attempts",
              pagedAttemptDelivery.id,
              "--limit",
              "1",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(toonFirstAttempts, firstAttempts);
        const attemptCursor = firstAttempts.page.next_cursor;
        assertEquals(typeof attemptCursor, "string");
        const secondAttempts = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "attempts",
              pagedAttemptDelivery.id,
              "--limit",
              "1",
              "--cursor",
              attemptCursor,
            ]),
            outputs,
          ),
        ).data;
        assertEquals(secondAttempts.items.length, 1);
        assertNotEquals(secondAttempts.items[0].id, safeAttempt.id);
        assertEquals(secondAttempts.items[0].total_attempt_number, 2);
        const toonSecondAttempts = toon(
          await successful(
            harness.runOptctl([
              "outbox",
              "attempts",
              pagedAttemptDelivery.id,
              "--limit",
              "1",
              "--cursor",
              attemptCursor,
            ]),
            outputs,
          ),
        ).data;
        assertEquals(toonSecondAttempts, secondAttempts);
        for (const asJson of [true, false]) {
          const mismatchedAttemptCursor = await harness.runOptctl([
            ...(asJson ? ["--json"] : []),
            "outbox",
            "attempts",
            queuedDelivery.id,
            "--cursor",
            attemptCursor,
          ]);
          assertNotEquals(mismatchedAttemptCursor.code, 0);
          assertEquals(
            errorOutput(mismatchedAttemptCursor, asJson).error.code,
            "invalid_cursor",
          );
          outputs.push(
            mismatchedAttemptCursor.stdout,
            mismatchedAttemptCursor.stderr,
          );
        }
        const attemptsAlias = await harness.runOptctl([
          "--json",
          "outbox",
          "attempts",
          ambiguousDelivery.id,
          "--after",
          "1",
        ]);
        assertNotEquals(attemptsAlias.code, 0);
        assertStringIncludes(attemptsAlias.stderr, "unknown option --after");
        outputs.push(attemptsAlias.stdout, attemptsAlias.stderr);

        await installPauseTrigger(harness);
        const toonCancelWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "toon-cancel",
        );
        const toonCancelDelivery = await deliveryForStage(
          harness,
          toonCancelWork.stageId,
        );
        const toonCancelled = toon(
          await successful(
            harness.runOptctl([
              "outbox",
              "cancel",
              toonCancelDelivery.id,
              "--reason",
              "TOON cancellation proof",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(toonCancelled.status, "cancelled");
        assertEquals(toonCancelled.total_attempts, 0);

        const toonRetryWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "toon-retry",
        );
        const toonRetryDelivery = await deliveryForStage(
          harness,
          toonRetryWork.stageId,
        );
        provider.enqueue({ kind: "permanent_failure" });
        await releasePaused(harness, toonRetryDelivery.id);
        await waitStatus(harness, toonRetryDelivery.id, "dead_letter");
        provider.enqueue({ kind: "success" });
        const toonRetried = toon(
          await successful(
            harness.runOptctl([
              "outbox",
              "retry",
              toonRetryDelivery.id,
              "--reason",
              "TOON retry proof",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(toonRetried.status, "pending");
        assertEquals(toonRetried.retry_generation, 1);
        await waitStatus(harness, toonRetryDelivery.id, "succeeded");
        const toonRetryHistory = await attemptRows(
          harness,
          toonRetryDelivery.id,
        );
        assertEquals(toonRetryHistory.length, 2);
        assertEquals(toonRetryHistory[1].retry_generation, 1);

        const toonDrain = toon(
          await successful(
            harness.runOptctl(["outbox", "drain", "--limit", "1"]),
            outputs,
          ),
        ).data;
        assertEquals(typeof toonDrain.worker_id, "string");
        assertEquals(toonDrain.claimed, 0);
        assertEquals(toonDrain.processed, 0);
        assertEquals(toonDrain.succeeded, 0);
        assertEquals(toonDrain.retried, 0);
        assertEquals(toonDrain.dead_lettered, 0);
        assertEquals(toonDrain.executions, []);

        await harness.restart({
          environment: { OPERANT_OUTBOX_POLL_INTERVAL_MS: "60000" },
        });
        await installPauseTrigger(harness);
        const drainOneWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "drain-exact-one",
        );
        const drainOneDelivery = await deliveryForStage(
          harness,
          drainOneWork.stageId,
        );
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, drainOneDelivery.id);
        const drainOne = toon(
          await successful(
            harness.runOptctl(["outbox", "drain", "--limit", "1"]),
            outputs,
          ),
        ).data;
        assertEquals(drainOne.claimed, 1);
        assertEquals(drainOne.processed, 1);
        assertEquals(drainOne.succeeded, 1);
        assertEquals(drainOne.retried, 0);
        assertEquals(drainOne.dead_lettered, 0);
        assertEquals(drainOne.executions.length, 1);
        await waitStatus(harness, drainOneDelivery.id, "succeeded");
        await assertExactDrain(
          harness,
          provider,
          drainOne,
          drainOneDelivery.id,
        );
        await installPauseTrigger(harness);
        const jsonDrainWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "json-drain-exact-one",
        );
        const jsonDrainDelivery = await deliveryForStage(
          harness,
          jsonDrainWork.stageId,
        );
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, jsonDrainDelivery.id);
        const jsonDrainOne = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "drain",
              "--limit",
              "1",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(jsonDrainOne.claimed, 1);
        assertEquals(jsonDrainOne.processed, 1);
        assertEquals(jsonDrainOne.succeeded, 1);
        assertEquals(jsonDrainOne.retried, 0);
        assertEquals(jsonDrainOne.dead_lettered, 0);
        assertEquals(jsonDrainOne.executions.length, 1);
        await waitStatus(harness, jsonDrainDelivery.id, "succeeded");
        await assertExactDrain(
          harness,
          provider,
          jsonDrainOne,
          jsonDrainDelivery.id,
        );
        const jsonDrain = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "drain",
              "--limit",
              "1",
            ]),
            outputs,
          ),
        ).data;
        const toonEmptyDrain = toon(
          await successful(
            harness.runOptctl(["outbox", "drain", "--limit", "1"]),
            outputs,
          ),
        ).data;
        for (const emptyDrain of [jsonDrain, toonEmptyDrain]) {
          assertEquals(emptyDrain.claimed, 0);
          assertEquals(emptyDrain.processed, 0);
          assertEquals(emptyDrain.succeeded, 0);
          assertEquals(emptyDrain.retried, 0);
          assertEquals(emptyDrain.dead_lettered, 0);
          assertEquals(emptyDrain.executions, []);
        }
        await harness.restart({
          environment: { OPERANT_OUTBOX_POLL_INTERVAL_MS: "10" },
        });
        for (const asJson of [true, false]) {
          const legacy = await harness.runOptctl([
            ...(asJson ? ["--json"] : []),
            "outbox",
            "status",
          ]);
          assertNotEquals(legacy.code, 0);
          if (asJson) {
            assertEquals(errorOutput(legacy, true).error.code, "usage_error");
          } else assertStringIncludes(legacy.stderr, "usage_error");
          const unknown = await harness.runOptctl([
            ...(asJson ? ["--json"] : []),
            "outbox",
            "list",
            "--unknown",
            "value",
          ]);
          assertNotEquals(unknown.code, 0);
          if (asJson) {
            assertEquals(errorOutput(unknown, true).error.code, "usage_error");
          } else {
            assertStringIncludes(unknown.stderr, "usage_error");
            assertStringIncludes(unknown.stderr, "unknown option --unknown");
          }
          outputs.push(
            legacy.stdout,
            legacy.stderr,
            unknown.stdout,
            unknown.stderr,
          );
        }
        const legacyHttp = await fetch(`${harness.baseUrl}/outbox`);
        assertEquals([401, 404].includes(legacyHttp.status), true);
        const legacyHttpText = await legacyHttp.text();
        assertEquals(legacyHttpText.includes(secretV1), false);

        const ordinaryPassword = `ordinary-outbox-${crypto.randomUUID()}`;
        const ordinaryUsername = `ordinary-outbox-${
          crypto.randomUUID().slice(0, 8)
        }`;
        await successful(
          harness.runOptctl([
            "--json",
            "auth",
            "user",
            "create",
            "--username",
            ordinaryUsername,
            "--password-stdin",
          ], `${ordinaryPassword}\n`),
          outputs,
        );
        const ordinaryPrincipal = String(
          (await query<{ principal_id: string }>(
            harness.server.sql,
            "select principal_id from human_users where username=$1",
            [ordinaryUsername],
          )).rows[0].principal_id,
        );
        const ordinaryAssignment = crypto.randomUUID();
        await query(
          harness.server.sql,
          `insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active)
           values($1,$2,'system:admin','system',null,true)`,
          [ordinaryAssignment, ordinaryPrincipal],
        );
        await query(
          harness.server.sql,
          `insert into policy_assignments(
             id,policy_definition_version_id,boundary_type,project_id,active)
           values($1,'01900000-0000-7000-8000-000000000201','system',null,true)
           on conflict do nothing`,
          [crypto.randomUUID()],
        );
        const ordinaryLogin = await harness.loginProcess({
          username: ordinaryUsername,
          password: ordinaryPassword,
        });
        assertEquals(
          ordinaryLogin.result.code,
          0,
          ordinaryLogin.result.stderr,
        );
        const ordinary = ordinaryLogin.launcher;
        const ordinaryJsonInspect = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "inspect",
              normalDelivery.id,
            ]),
            outputs,
          ),
        );
        assertEquals(
          toon(
            await successful(
              ordinary.runOptctl([
                "outbox",
                "inspect",
                normalDelivery.id,
              ]),
              outputs,
            ),
          ).data,
          ordinaryJsonInspect.data,
        );
        const ordinaryJsonAttempts = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "attempts",
              ambiguousDelivery.id,
            ]),
            outputs,
          ),
        );
        assertEquals(
          toon(
            await successful(
              ordinary.runOptctl([
                "outbox",
                "attempts",
                ambiguousDelivery.id,
              ]),
              outputs,
            ),
          ).data,
          ordinaryJsonAttempts.data,
        );
        const ordinaryJsonList = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "list",
              "--status",
              "succeeded",
              "--hook",
              "test/durableoutbox:deliver",
              "--event",
              normalDelivery.event_id,
              "--from",
              "2000-01-01T00:00:00Z",
              "--to",
              "2100-01-01T00:00:00Z",
            ]),
            outputs,
          ),
        );
        assertEquals(
          toon(
            await successful(
              ordinary.runOptctl([
                "outbox",
                "list",
                "--status",
                "succeeded",
                "--hook",
                "test/durableoutbox:deliver",
                "--event",
                normalDelivery.event_id,
                "--from",
                "2000-01-01T00:00:00Z",
                "--to",
                "2100-01-01T00:00:00Z",
              ]),
              outputs,
            ),
          ).data,
          ordinaryJsonList.data,
        );
        const ordinaryJsonDrain = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "drain",
              "--limit",
              "1",
            ]),
            outputs,
          ),
        );
        const ordinaryToonDrain = toon(
          await successful(
            ordinary.runOptctl(["outbox", "drain", "--limit", "1"]),
            outputs,
          ),
        );
        assertEquals(typeof ordinaryJsonDrain.data.claimed, "number");
        assertEquals(typeof ordinaryToonDrain.data.claimed, "number");
        await installPauseTrigger(harness);
        const ordinaryMutation = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "ordinary-mutation",
        );
        const ordinaryDelivery = await deliveryForStage(
          harness,
          ordinaryMutation.stageId,
        );
        const ordinaryJsonCancelled = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "cancel",
              ordinaryDelivery.id,
              "--reason",
              "ordinary JSON cancel",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(ordinaryJsonCancelled.status, "cancelled");
        const ordinaryToonCancelWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "ordinary-toon-cancel",
        );
        const ordinaryToonCancelDelivery = await deliveryForStage(
          harness,
          ordinaryToonCancelWork.stageId,
        );
        const ordinaryToonCancelled = toon(
          await successful(
            ordinary.runOptctl([
              "outbox",
              "cancel",
              ordinaryToonCancelDelivery.id,
              "--reason",
              "ordinary TOON cancel",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(ordinaryToonCancelled.status, "cancelled");
        const ordinaryRetryWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "ordinary-retry",
        );
        const ordinaryRetryDelivery = await deliveryForStage(
          harness,
          ordinaryRetryWork.stageId,
        );
        const ordinaryToonRetryWork = await stageCommit(
          harness,
          pack,
          projectId,
          "normal",
          "ordinary-toon-retry",
        );
        const ordinaryToonRetryDelivery = await deliveryForStage(
          harness,
          ordinaryToonRetryWork.stageId,
        );
        provider.enqueue(
          { kind: "permanent_failure" },
          { kind: "permanent_failure" },
        );
        await releasePausedMany(harness, [
          ordinaryRetryDelivery.id,
          ordinaryToonRetryDelivery.id,
        ]);
        await waitStatus(harness, ordinaryRetryDelivery.id, "dead_letter");
        await waitStatus(
          harness,
          ordinaryToonRetryDelivery.id,
          "dead_letter",
        );
        provider.enqueue({ kind: "success" }, { kind: "success" });
        const ordinaryJsonRetried = json(
          await successful(
            ordinary.runOptctl([
              "--json",
              "outbox",
              "retry",
              ordinaryRetryDelivery.id,
              "--reason",
              "ordinary JSON retry",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(ordinaryJsonRetried.retry_generation, 1);
        const ordinaryToonRetried = toon(
          await successful(
            ordinary.runOptctl([
              "outbox",
              "retry",
              ordinaryToonRetryDelivery.id,
              "--reason",
              "ordinary TOON retry",
            ]),
            outputs,
          ),
        ).data;
        assertEquals(ordinaryToonRetried.retry_generation, 1);
        await waitStatus(harness, ordinaryRetryDelivery.id, "succeeded");
        await waitStatus(
          harness,
          ordinaryToonRetryDelivery.id,
          "succeeded",
        );
        await query(
          harness.server.sql,
          "update role_assignments set active=false,disabled_at=now() where id=$1",
          [ordinaryAssignment],
        );
        const nonexistentDelivery = uuidV7();
        for (const asJson of [true, false]) {
          for (
            const [command, existing] of [
              ["inspect", normalDelivery.id],
              ["attempts", ambiguousDelivery.id],
              ["retry", ordinaryRetryDelivery.id],
              ["cancel", normalDelivery.id],
            ]
          ) {
            const existingDenied = await ordinary.runOptctl([
              ...(asJson ? ["--json"] : []),
              "outbox",
              command,
              existing,
            ]);
            const missingDenied = await ordinary.runOptctl([
              ...(asJson ? ["--json"] : []),
              "outbox",
              command,
              nonexistentDelivery,
            ]);
            assertNotEquals(existingDenied.code, 0);
            assertEquals(existingDenied.code, missingDenied.code);
            const existingError = withoutRequestId(
              errorOutput(existingDenied, asJson),
            );
            const missingError = withoutRequestId(
              errorOutput(missingDenied, asJson),
            );
            assertEquals(existingError, missingError);
            assertEquals(existingError.error.code, "policy_denied");
            assertEquals(existingError.error.details.resource, "system:outbox");
            assertEquals(
              JSON.stringify(existingError.error.details).match(
                /auth_context|session|principal|request|token/i,
              ),
              null,
            );
            outputs.push(
              existingDenied.stdout,
              existingDenied.stderr,
              missingDenied.stdout,
              missingDenied.stderr,
            );
          }
          for (const command of ["list", "drain"]) {
            const args = command === "drain"
              ? ["outbox", "drain", "--limit", "1"]
              : ["outbox", "list"];
            const denied = await ordinary.runOptctl([
              ...(asJson ? ["--json"] : []),
              ...args,
            ]);
            assertNotEquals(denied.code, 0);
            assertEquals(
              errorOutput(denied, asJson).error.code,
              "policy_denied",
            );
            outputs.push(denied.stdout, denied.stderr);
          }
        }
        await ordinary.close();

        const diagnostics = await harness.diagnostics();
        const databaseText = JSON.stringify(
          (await query(
            harness.server.sql,
            `select last_error_code,last_error_message from outbox_deliveries
           union all select error_code,error_message from outbox_attempts`,
          )).rows,
        );
        const scanned = [
          ...outputs,
          diagnostics.server,
          diagnostics.hooks,
          databaseText,
        ].join("\n");
        for (
          const forbidden of [
            secretV1,
            secretV2,
            secretKey,
            "ciphertext",
            "nonce",
            "Bearer ",
          ]
        ) {
          assertEquals(
            scanned.includes(forbidden),
            false,
            `leaked ${forbidden}`,
          );
        }
        await assertNoIdleTransactions(harness);
      } finally {
        await provider.close().catch(() => undefined);
        await harness.close().catch(() => undefined);
        await Deno.remove(pack, { recursive: true }).catch(() => undefined);
      }
    },
  });
}

async function writePack(
  root: string,
  providerUrl: string,
  version: string,
  marker: string,
) {
  await Deno.remove(root, { recursive: true }).catch(() => undefined);
  await Deno.mkdir(`${root}/resources`, { recursive: true });
  await Deno.mkdir(`${root}/hooks`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: durableoutbox, version: ${version} }\nspec: { purpose: Durable outbox E2E., axi: {} }\n`,
  );
  await Deno.writeTextFile(
    `${root}/resources/item.yaml`,
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: item }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n    mode: { type: string, required: true }\n  axi: {}\n`,
  );
  const host = new URL(providerUrl).host;
  await Deno.writeTextFile(
    `${root}/hooks/deliver.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: deliver }\nspec:\n  script: deliver.ts\n  timeout: ${
      marker === "V2" ? "10s" : "1s"
    }\n  permissions: { net: [${host}], env: false, read: false, write: false, run: false }\n  secrets: [{ slot: token, env: OUTBOX_TOKEN }]\n  effects: { operations: [] }\n  output: { schema: delivery.v1 }\n  attachments:\n    - phase: event.after_commit\n      event: object.created\n      order: 10\n      condition: 'active() && event_type == "object.created" && version == 1 && object_version_id != null && actor.id != null'\n      input: { event: '$event', object_version: '$object_version', actor: '$actor' }\n    - phase: event.after_commit\n      event: object.created\n      order: 11\n      condition: 'false && event_type == "object.created"'\n      input: { event: '$event' }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/deliver.ts`,
    `
const envelope=JSON.parse(await new Response(Deno.stdin.readable).text());
const delivery=envelope.metadata.delivery;
const token=Deno.env.get("OUTBOX_TOKEN") ?? "";
const response=await fetch(${
      JSON.stringify(`${providerUrl}/effect`)
    },{method:"POST",headers:{"content-type":"application/json","idempotency-key":delivery.idempotency_key},body:JSON.stringify({script:${
      JSON.stringify(marker)
    },secret_version:token.includes("v2-")?"v2":"v1",attempt_id:delivery.attempt_id,actor_keys:Object.keys(envelope.input.actor).sort(),object_version_present:envelope.input.object_version!==null})});
const responseBody=await response.json();
if(responseBody.directive==="retry") console.log(JSON.stringify({outcome:"retry",code:"ambiguous",message:"effect may have completed"}));
else if(response.status===503) console.log(JSON.stringify({outcome:"retry",code:"provider_unavailable",message:"provider unavailable",retry_after:(response.headers.get("retry-after")??"1")+"s"}));
else if(response.status>=400) console.log(JSON.stringify({outcome:"dead_letter",code:"provider_rejected",message:"provider rejected request"}));
else console.log(JSON.stringify({outcome:"succeeded",external_id:"provider-effect"}));
`,
  );
}

async function addHookB(root: string, providerUrl: string) {
  for await (const entry of Deno.readDir(root)) {
    if (entry.isFile && entry.name.startsWith("operation-")) {
      await Deno.remove(`${root}/${entry.name}`);
    }
  }
  const manifest = await Deno.readTextFile(`${root}/pack.yaml`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    manifest.replace(/version: [^ }]+/, "version: 3.0.0"),
  );
  const host = new URL(providerUrl).host;
  await Deno.writeTextFile(
    `${root}/hooks/deliver_b.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: deliver_b }\nspec:\n  script: deliver_b.ts\n  timeout: 10s\n  permissions: { net: [${host}], env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: delivery.v1 }\n  attachments:\n    - phase: event.after_commit\n      event: object.updated\n      order: 20\n      condition: 'event_type == "object.updated"'\n      input: { event: '$event' }\n    - phase: event.after_commit\n      event: object.updated\n      order: 21\n      condition: 'event_type == "object.updated"'\n      input: { event: '$event' }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/deliver_b.ts`,
    `const envelope=JSON.parse(await new Response(Deno.stdin.readable).text());\nconst delivery=envelope.metadata.delivery;\nawait fetch(${
      JSON.stringify(`${providerUrl}/effect`)
    },{method:"POST",headers:{"content-type":"application/json","idempotency-key":delivery.idempotency_key},body:JSON.stringify({script:"B",attempt_id:delivery.attempt_id})});\nconsole.log(JSON.stringify({outcome:"succeeded",external_id:"provider-effect-b"}));\n`,
  );
}

async function stageUpdateCommit(
  harness: LiveHarness,
  pack: string,
  projectId: string,
  objectId: string,
) {
  const file = `${pack}/operation-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      operations: [{
        op: "update",
        project_id: projectId,
        resource: "test/durableoutbox:item",
        object_id: objectId,
        set: { mode: "updated-for-hook-b" },
      }],
    }),
  );
  const staged = json(
    await successful(harness.runOptctl(["--json", "changeset", "stage", file])),
  );
  const stageId = String(staged.data.id);
  const commit = json(
    await successful(
      harness.runOptctl(["--json", "changeset", "commit", stageId]),
    ),
  );
  return { stageId, commit };
}

async function stageCommit(
  harness: LiveHarness,
  pack: string,
  projectId: string,
  mode: string,
  key: string,
) {
  const file = `${pack}/operation-${crypto.randomUUID()}.json`;
  await Deno.writeTextFile(
    file,
    JSON.stringify({
      operations: [{
        op: "create",
        project_id: projectId,
        resource: "test/durableoutbox:item",
        fields: { key, mode },
      }],
    }),
  );
  const staged = json(
    await successful(harness.runOptctl(["--json", "changeset", "stage", file])),
  );
  const stageId = String(staged.data.id);
  const commitResult = await harness.runOptctl([
    "--json",
    "changeset",
    "commit",
    stageId,
  ]);
  if (commitResult.code !== 0) {
    const diagnostics = await harness.diagnostics();
    throw new Error(`${commitResult.stderr}\n${diagnostics.server}`);
  }
  const commit = json(commitResult);
  return { stageId, commit };
}

async function successful(
  promise: Promise<{ code: number; stdout: string; stderr: string }>,
  outputs: string[] = [],
) {
  const result = await promise;
  outputs.push(result.stdout, result.stderr);
  assertEquals(result.code, 0, result.stderr);
  return result;
}
function json(result: { stdout: string }) {
  return JSON.parse(result.stdout);
}
function toon(result: { stdout: string }) {
  return decodeToon(result.stdout) as Record<string, any>;
}
function errorOutput(
  result: { stderr: string },
  asJson: boolean,
): Record<string, any> {
  return (asJson
    ? JSON.parse(result.stderr)
    : decodeToon(result.stderr)) as Record<string, any>;
}
async function assertExactDrain(
  harness: LiveHarness,
  provider: ReturnType<typeof startHttpProvider>,
  result: Record<string, any>,
  deliveryId: string,
) {
  assertEquals(result.executions.length, 1);
  const execution = result.executions[0];
  assertEquals(execution.delivery_id, deliveryId);
  assertEquals(execution.status, "succeeded");
  assertEquals(isUuidV7(execution.attempt_id), true);
  const attempt = (await query<{
    id: string;
    delivery_id: string;
    outcome: string;
    retry_generation: number;
    attempt_number: number;
    total_attempt_number: number;
  }>(
    harness.server.sql,
    `select id,delivery_id,outcome,retry_generation,attempt_number,
       total_attempt_number from outbox_attempts where id=$1`,
    [execution.attempt_id],
  )).rows[0];
  assertEquals(attempt, {
    id: execution.attempt_id,
    delivery_id: deliveryId,
    outcome: "succeeded",
    retry_generation: 0,
    attempt_number: 1,
    total_attempt_number: 1,
  });
  assertEquals(
    provider.effects.filter((effect) => effect.idempotencyKey === deliveryId)
      .length,
    1,
  );
}

async function collectListPages(
  harness: LiveHarness,
  asJson: boolean,
  args: string[],
  outputs: string[],
) {
  const items: Array<Record<string, any>> = [];
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    if (++pageCount > 100) {
      throw new Error(
        `list pagination exceeded bound: ${JSON.stringify({ ids, cursor })}`,
      );
    }
    const result = await successful(
      harness.runOptctl([
        ...(asJson ? ["--json"] : []),
        "outbox",
        "list",
        ...args,
        ...(cursor === null ? [] : ["--cursor", cursor]),
      ]),
      outputs,
    );
    const data = (asJson ? json(result) : toon(result)).data;
    for (const item of data.items) {
      if (ids.includes(item.id)) {
        throw new Error(`duplicate list ID ${item.id}`);
      }
      ids.push(item.id);
      items.push(item);
    }
    const next = data.page.next_cursor as string | null;
    if (next !== null) {
      if (cursors.has(next)) throw new Error(`repeated list cursor ${next}`);
      cursors.add(next);
    }
    cursor = next;
  } while (cursor !== null);
  return { items, ids, pageCount, terminalCursor: cursor };
}

async function collectAttemptPages(
  harness: LiveHarness,
  asJson: boolean,
  deliveryId: string,
  outputs: string[],
) {
  const items: Array<Record<string, any>> = [];
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    if (++pageCount > 100) {
      throw new Error(
        `attempt pagination exceeded bound: ${JSON.stringify({ ids, cursor })}`,
      );
    }
    const result = await successful(
      harness.runOptctl([
        ...(asJson ? ["--json"] : []),
        "outbox",
        "attempts",
        deliveryId,
        "--limit",
        "1",
        ...(cursor === null ? [] : ["--cursor", cursor]),
      ]),
      outputs,
    );
    const data = (asJson ? json(result) : toon(result)).data;
    for (const item of data.items) {
      if (ids.includes(item.id)) {
        throw new Error(`duplicate attempt ID ${item.id}`);
      }
      ids.push(item.id);
      items.push(item);
    }
    const next = data.page.next_cursor as string | null;
    if (next !== null) {
      if (cursors.has(next)) throw new Error(`repeated attempt cursor ${next}`);
      cursors.add(next);
    }
    cursor = next;
  } while (cursor !== null);
  return { items, ids, pageCount, terminalCursor: cursor };
}

function compareDeliveryRows(
  left: Record<string, any>,
  right: Record<string, any>,
): number {
  const time = String(right.created_at).localeCompare(String(left.created_at));
  return time !== 0 ? time : String(right.id).localeCompare(String(left.id));
}

function expectedFilters(args: string[]): Record<string, string> {
  const filters: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].slice(2);
    const value = args[index + 1];
    filters[key] = key === "from" || key === "to"
      ? new Date(value).toISOString()
      : value;
  }
  return filters;
}
function withoutRequestId(value: Record<string, any>): Record<string, any> {
  return {
    ...value,
    meta: { ...value.meta, request_id: "<removed>" },
  };
}
type DeliveryRow = {
  id: string;
  event_id: string;
  status: string;
  available_at: string;
  created_at: string;
};
async function deliveryForStage(
  harness: LiveHarness,
  stageId: string,
): Promise<DeliveryRow> {
  return await waitRow<DeliveryRow>(
    harness,
    `select d.id,d.event_id,d.status,d.available_at::text,d.created_at::text from outbox_deliveries d join changeset_commits c on c.id=d.changeset_commit_id where c.stage_id=$1 order by d.created_at limit 1`,
    [stageId],
  );
}
async function delivery(
  harness: LiveHarness,
  id: string,
): Promise<DeliveryRow> {
  return await waitRow<DeliveryRow>(
    harness,
    "select id,event_id,status,available_at::text,created_at::text from outbox_deliveries where id=$1",
    [id],
  );
}
async function waitStatus(
  harness: LiveHarness,
  id: string,
  status: string,
  timeoutMs = 10_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    last = (await query<Record<string, unknown>>(
      harness.server.sql,
      "select id,status,available_at::text,last_error_code from outbox_deliveries where id=$1",
      [id],
    )).rows[0];
    if (last?.status === status) return last;
    await Promise.resolve();
  }
  throw new Error(
    `delivery ${id} did not reach ${status}: ${JSON.stringify(last)}`,
  );
}
async function waitRow<T extends Record<string, unknown>>(
  harness: LiveHarness,
  text: string,
  values: unknown[],
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const row = (await query<T>(harness.server.sql, text, values)).rows[0];
    if (row) return row;
    await Promise.resolve();
  }
  throw new Error("bounded outbox row wait failed");
}
async function deliveryAggregate(harness: LiveHarness, id: string) {
  return (await query<{
    retry_generation: number;
    attempts_in_generation: number;
    total_attempts: number;
  }>(
    harness.server.sql,
    `select retry_generation,attempts_in_generation,total_attempts
     from outbox_deliveries where id=$1`,
    [id],
  )).rows[0];
}
async function attemptRows(harness: LiveHarness, id: string) {
  return (await query<ArrayRow>(
    harness.server.sql,
    `select id,retry_generation,outcome,idempotency_key,grant_evidence_json from outbox_attempts where delivery_id=$1 order by total_attempt_number`,
    [id],
  )).rows;
}
type ArrayRow = {
  id: string;
  retry_generation: number;
  outcome: string;
  idempotency_key: string;
  grant_evidence_json: Array<Record<string, unknown>>;
};
async function installPauseTrigger(harness: LiveHarness) {
  await query(
    harness.server.sql,
    `create function outbox_e2e_pause() returns trigger language plpgsql as $$ begin new.available_at=now()+interval '1 day'; return new; end $$; create trigger outbox_e2e_pause before insert on outbox_deliveries for each row execute function outbox_e2e_pause()`,
  );
}
async function releasePaused(harness: LiveHarness, id: string) {
  await releasePausedMany(harness, [id]);
}
async function releasePausedMany(harness: LiveHarness, ids: string[]) {
  await query(
    harness.server.sql,
    "drop trigger outbox_e2e_pause on outbox_deliveries; drop function outbox_e2e_pause()",
  );
  await query(
    harness.server.sql,
    "update outbox_deliveries set available_at=now() where id=any($1::uuid[])",
    [ids],
  );
}
async function makeReady(harness: LiveHarness, id: string) {
  await query(
    harness.server.sql,
    "update outbox_deliveries set available_at=now() where id=$1",
    [id],
  );
}
async function assertNoIdleTransactions(harness: LiveHarness) {
  const deadline = Date.now() + 5_000;
  let rows: Record<string, unknown>[] = [];
  while (Date.now() < deadline) {
    rows = (await query<Record<string, unknown>>(
      harness.server.sql,
      `select pid,state,wait_event_type,wait_event,left(query,200) query
       from pg_stat_activity where datname=current_database()
         and state='idle in transaction' and pid<>pg_backend_pid()`,
    )).rows;
    if (rows.length === 0) return;
    await Promise.resolve();
  }
  throw new Error(`idle transaction leak: ${JSON.stringify(rows)}`);
}
