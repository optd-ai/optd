// deno-lint-ignore-file no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
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
        assertEquals(provider.attempts.length, 1);
        assertEquals(provider.attempts[0].idempotencyKey, normalDelivery.id);
        const normalBody = JSON.parse(provider.attempts[0].body);
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
        await provider.waitForAttempts(3, 10_000);
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
        provider.enqueue(
          { kind: "retry", retryAfterSeconds: 1 },
          { kind: "success" },
        );
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
        await provider.waitForAttempts(4, 10_000);
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
        assertEquals(inspected.data.status, "retry_wait");
        const beforeCount = provider.attempts.length;
        if (Date.now() < new Date(String(retryWait.available_at)).getTime()) {
          assertEquals(provider.attempts.length, beforeCount);
        }
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
        provider.enqueue({ kind: "success" });
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
        await waitStatus(harness, permanentDelivery.id, "succeeded");
        const repaired = await deliveryAggregate(harness, permanentDelivery.id);
        assertEquals(repaired.retry_generation, 1);
        assertEquals(repaired.attempts_in_generation, 1);
        assertEquals(repaired.total_attempts, 2);
        const crashRequestCount = provider.attempts.length;
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
        await provider.waitForAttempts(crashRequestCount + 1, 10_000);
        await harness.crash();
        provider.release("crash");
        const stillRunning = await delivery(harness, crashDelivery.id);
        assertEquals(stillRunning.status, "running");
        await harness.restart();
        await waitStatus(harness, crashDelivery.id, "succeeded", 20_000);
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
        const drainBefore = provider.attempts.length;
        provider.enqueue({ kind: "success" });
        await releasePaused(harness, drainDelivery.id);
        await harness.runConcurrent([
          { args: ["--json", "outbox", "drain", "--limit", "1"] },
          { args: ["--json", "outbox", "drain", "--limit", "1"] },
        ]);
        await waitStatus(harness, drainDelivery.id, "succeeded");
        assertEquals(provider.attempts.length, drainBefore + 1);

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
        const unorderedBefore = provider.attempts.length;
        provider.enqueue(
          { kind: "hold", token: "slow-earlier" },
          { kind: "success" },
        );
        await releasePaused(harness, slowDelivery.id);
        await provider.waitForAttempts(unorderedBefore + 1, 10_000);
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
        await provider.waitForAttempts(unorderedBefore + 2, 10_000);
        await waitStatus(harness, fastDelivery.id, "succeeded");
        assertEquals(
          (await delivery(harness, slowDelivery.id)).status,
          "running",
        );
        provider.release("slow-earlier");
        await waitStatus(harness, slowDelivery.id, "succeeded");
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
        const nextCursor = listedJson.data.page?.next_cursor;
        if (typeof nextCursor === "string") {
          const mismatch = await harness.runOptctl([
            "--json",
            "outbox",
            "list",
            "--status",
            "dead_letter",
            "--cursor",
            nextCursor,
          ]);
          assertNotEquals(mismatch.code, 0);
          assertStringIncludes(mismatch.stderr, "invalid_cursor");
          outputs.push(mismatch.stdout, mismatch.stderr);
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
        const toonInspect = await successful(
          harness.runOptctl(["outbox", "inspect", queuedDelivery.id]),
          outputs,
        );
        assertStringIncludes(
          toonInspect.stdout,
          String(deliveryInspection.id),
        );
        assertStringIncludes(
          toonInspect.stdout,
          String(deliveryInspection.status),
        );

        const firstAttempts = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "attempts",
              ambiguousDelivery.id,
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
        const attemptCursor = firstAttempts.page.next_cursor;
        assertEquals(typeof attemptCursor, "string");
        const secondAttempts = json(
          await successful(
            harness.runOptctl([
              "--json",
              "outbox",
              "attempts",
              ambiguousDelivery.id,
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
        const mismatchedAttemptCursor = await harness.runOptctl([
          "--json",
          "outbox",
          "attempts",
          queuedDelivery.id,
          "--cursor",
          attemptCursor,
        ]);
        assertNotEquals(mismatchedAttemptCursor.code, 0);
        assertStringIncludes(mismatchedAttemptCursor.stderr, "invalid_cursor");
        outputs.push(
          mismatchedAttemptCursor.stdout,
          mismatchedAttemptCursor.stderr,
        );
        const attemptsAlias = await harness.runOptctl([
          "--json",
          "outbox",
          "attempts",
          ambiguousDelivery.id,
          "--after",
          "1",
        ]);
        assertNotEquals(attemptsAlias.code, 0);
        outputs.push(attemptsAlias.stdout, attemptsAlias.stderr);
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
        const legacy = await harness.runOptctl(["--json", "outbox", "status"]);
        assertNotEquals(legacy.code, 0);
        outputs.push(legacy.stdout, legacy.stderr);
        const legacyHttp = await fetch(`${harness.baseUrl}/outbox`);
        assertEquals([401, 404].includes(legacyHttp.status), true);
        await legacyHttp.body?.cancel();

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
        await successful(
          ordinary.runOptctl([
            "--json",
            "outbox",
            "inspect",
            normalDelivery.id,
          ]),
          outputs,
        );
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
        );
        await successful(
          ordinary.runOptctl(["--json", "outbox", "drain", "--limit", "1"]),
          outputs,
        );
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
        await successful(
          ordinary.runOptctl([
            "--json",
            "outbox",
            "cancel",
            ordinaryDelivery.id,
          ]),
          outputs,
        );
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
        provider.enqueue({ kind: "permanent_failure" });
        await releasePaused(harness, ordinaryRetryDelivery.id);
        await waitStatus(harness, ordinaryRetryDelivery.id, "dead_letter");
        provider.enqueue({ kind: "success" });
        await successful(
          ordinary.runOptctl([
            "--json",
            "outbox",
            "retry",
            ordinaryRetryDelivery.id,
          ]),
          outputs,
        );
        await waitStatus(harness, ordinaryRetryDelivery.id, "succeeded");
        await query(
          harness.server.sql,
          "update role_assignments set active=false,disabled_at=now() where id=$1",
          [ordinaryAssignment],
        );
        for (
          const args of [
            ["--json", "outbox", "inspect", normalDelivery.id],
            ["--json", "outbox", "retry", ordinaryRetryDelivery.id],
            ["--json", "outbox", "cancel", normalDelivery.id],
            ["--json", "outbox", "drain", "--limit", "1"],
          ]
        ) {
          const denied = await ordinary.runOptctl(args);
          assertNotEquals(denied.code, 0);
          assertStringIncludes(denied.stderr, "policy_denied");
          outputs.push(denied.stdout, denied.stderr);
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
type DeliveryRow = {
  id: string;
  event_id: string;
  status: string;
  available_at: string;
};
async function deliveryForStage(
  harness: LiveHarness,
  stageId: string,
): Promise<DeliveryRow> {
  return await waitRow<DeliveryRow>(
    harness,
    `select d.id,d.event_id,d.status,d.available_at::text from outbox_deliveries d join changeset_commits c on c.id=d.changeset_commit_id where c.stage_id=$1 order by d.created_at limit 1`,
    [stageId],
  );
}
async function delivery(
  harness: LiveHarness,
  id: string,
): Promise<DeliveryRow> {
  return await waitRow<DeliveryRow>(
    harness,
    "select id,event_id,status,available_at::text from outbox_deliveries where id=$1",
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
    `select id,outcome,idempotency_key,grant_evidence_json from outbox_attempts where delivery_id=$1 order by total_attempt_number`,
    [id],
  )).rows;
}
type ArrayRow = {
  id: string;
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
