// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert";
import postgres from "npm:postgres";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { EnvelopeCrypto } from "../../src/adapters/outbound/crypto/envelope.ts";
import { PostgresAuthorizationRepository } from "../../src/adapters/outbound/postgres/authorization_repository.ts";
import {
  HookSecretGrantUnavailableError,
  HookSecretUnavailableError,
  PostgresHookSecretRepository,
} from "../../src/adapters/outbound/postgres/hook_secret_repository.ts";
import { PostgresOutboxRepository } from "../../src/adapters/outbound/postgres/outbox_repository.ts";
import { makeProcessOutboxService } from "../../src/application/services/process_outbox.ts";
import { canonicalSha256 } from "../../src/domain/ids/canonical_json.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("production repository preserves stable identity, fixed lease fencing, attempts and generations", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-outbox-repository-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const fixture = await seedDelivery(sql);
    const repository = new PostgresOutboxRepository(sql);
    const worker = uuidV7();
    const started = new Date("2026-01-01T00:00:00.000Z");
    const first = (await repository.claim(worker, 1, 1, started))[0];
    assertEquals(first.id, fixture.deliveryId);
    assertEquals(first.attempt_number, 1);
    assertEquals(first.total_attempt_number, 1);

    const reclaimed =
      (await repository.claim(worker, 1, 1, new Date(started.getTime() + 3)))[
        0
      ];
    assertEquals(reclaimed.id, fixture.deliveryId);
    assertNotEquals(reclaimed.attempt_id, first.attempt_id);
    assertEquals(reclaimed.attempt_number, 2);
    assertEquals(reclaimed.total_attempt_number, 2);
    assertEquals(
      await repository.complete(
        first,
        { outcome: "succeeded" },
        evidence(),
        0,
        new Date(started.getTime() + 4),
      ),
      "late",
    );
    assertEquals(
      (await repository.inspect(fixture.deliveryId))?.status,
      "running",
    );
    assertEquals(
      await repository.complete(
        reclaimed,
        {
          outcome: "dead_letter",
          code: "invalid_destination",
          message: "invalid destination",
        },
        evidence(),
        0,
        new Date(started.getTime() + 4),
      ),
      "dead_letter",
    );

    const attempts = await repository.attempts(fixture.deliveryId, 10);
    assertEquals(attempts.map((row) => (row as { outcome: string }).outcome), [
      "late_succeeded",
      "dead_letter",
    ]);
    const beforeRetry = await repository.inspect(fixture.deliveryId) as Record<
      string,
      unknown
    >;
    assertEquals(
      await repository.retry(
        fixture.deliveryId,
        undefined,
        new Date(started.getTime() + 5),
      ),
      "pending",
    );
    const afterRetry = await repository.inspect(fixture.deliveryId) as Record<
      string,
      unknown
    >;
    assertEquals(afterRetry.retry_generation, 1);
    assertEquals(afterRetry.attempts_in_generation, 0);
    assertEquals(afterRetry.total_attempts, beforeRetry.total_attempts);
    assertEquals(afterRetry.id, beforeRetry.id);

    await assertRejects(() =>
      query(sql!, "delete from outbox_attempts where delivery_id=$1", [
        fixture.deliveryId,
      ])
    );
    await assertRejects(() =>
      query(sql!, "update outbox_deliveries set script_digest=$2 where id=$1", [
        fixture.deliveryId,
        hash("f"),
      ])
    );
    const execution = (await query<{ id: string }>(
      sql,
      "select id from outbox_hook_executions where delivery_id=$1 order by created_at limit 1",
      [fixture.deliveryId],
    )).rows[0];
    await assertRejects(() =>
      query(
        sql!,
        "update outbox_hook_executions set logs='changed' where id=$1",
        [
          execution.id,
        ],
      )
    );
    await assertRejects(() =>
      query(sql!, "delete from outbox_hook_executions where id=$1", [
        execution.id,
      ])
    );
    assertEquals(
      (await repository.claim(worker, 10, 1, new Date(started.getTime() + 6)))
        .length,
      1,
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("independent max-one claimers skip locked rows and cancellation has deterministic FIFO outcomes", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-outbox-locks-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let setup: ReturnType<typeof createPostgresClient> | undefined;
  let firstSql: ReturnType<typeof postgres> | undefined;
  let secondSql: ReturnType<typeof postgres> | undefined;
  try {
    runtime = await startPostgresRuntime();
    setup = createPostgresClient(runtime.databaseUrl);
    await setup.begin((tx) => applyPlatformMigrations(tx));
    const fixture = await seedDelivery(setup);
    firstSql = postgres(runtime.databaseUrl, {
      max: 1,
      connection: { application_name: "outbox-lock-first" },
    });
    secondSql = postgres(runtime.databaseUrl, {
      max: 1,
      connection: { application_name: "outbox-lock-second" },
    });

    const claimEntered = deferred<void>();
    const releaseClaim = deferred<void>();
    const firstRepository = new PostgresOutboxRepository(
      firstSql,
      undefined,
      {
        async afterClaimRowsLocked(ids) {
          if (ids.length === 0) return;
          claimEntered.resolve();
          await releaseClaim.promise;
        },
      },
    );
    const secondRepository = new PostgresOutboxRepository(secondSql);
    const now = new Date("2026-02-01T00:00:00.000Z");
    const firstClaim = firstRepository.claim(uuidV7(), 1, 1_000, now);
    await claimEntered.promise;
    assertEquals(await secondRepository.claim(uuidV7(), 1, 1_000, now), []);
    releaseClaim.resolve();
    const claimed = await firstClaim;
    assertEquals(claimed.length, 1);
    assertEquals(
      await secondRepository.cancel(fixture.deliveryId, undefined, now),
      "delivery_in_progress",
    );

    const cancelFirst = await cloneDelivery(
      setup,
      fixture,
      new Date(now.getTime() + 1),
    );
    const cancelEntered = deferred<void>();
    const releaseCancel = deferred<void>();
    const cancellingRepository = new PostgresOutboxRepository(
      firstSql,
      undefined,
      {
        async afterMutationRowLocked(id, operation) {
          if (id !== cancelFirst || operation !== "cancel") return;
          cancelEntered.resolve();
          await releaseCancel.promise;
        },
      },
    );
    const cancelling = cancellingRepository.cancel(cancelFirst, undefined, now);
    await cancelEntered.promise;
    assertEquals(
      await secondRepository.claim(
        uuidV7(),
        1,
        1_000,
        new Date(now.getTime() + 2),
      ),
      [],
    );
    releaseCancel.resolve();
    assertEquals(await cancelling, "cancelled");

    const claimFirst = await cloneDelivery(
      setup,
      fixture,
      new Date(now.getTime() + 3),
    );
    const winnerEntered = deferred<void>();
    const releaseWinner = deferred<void>();
    const winningRepository = new PostgresOutboxRepository(
      firstSql,
      undefined,
      {
        async afterClaimRowsLocked(ids) {
          if (!ids.includes(claimFirst)) return;
          winnerEntered.resolve();
          await releaseWinner.promise;
        },
      },
    );
    const winningClaim = winningRepository.claim(
      uuidV7(),
      1,
      1_000,
      new Date(now.getTime() + 4),
    );
    await winnerEntered.promise;
    const blockedCancel = secondRepository.cancel(claimFirst, undefined, now);
    await observeBlocked(setup, "outbox-lock-second");
    releaseWinner.resolve();
    assertEquals((await winningClaim).map((row) => row.id), [claimFirst]);
    assertEquals(await blockedCancel, "delivery_in_progress");

    const earlier = await cloneDelivery(
      setup,
      fixture,
      new Date(now.getTime() + 10),
    );
    const later = await cloneDelivery(
      setup,
      fixture,
      new Date(now.getTime() + 11),
    );
    const batch = await secondRepository.claim(
      uuidV7(),
      2,
      1_000,
      new Date(now.getTime() + 12),
    );
    assertEquals(batch.map((row) => row.id), [earlier, later]);
    await secondRepository.complete(
      batch[1],
      { outcome: "succeeded" },
      evidence(),
      0,
      new Date(now.getTime() + 13),
    );
    assertEquals((await secondRepository.inspect(later))?.status, "succeeded");
    assertEquals((await secondRepository.inspect(earlier))?.status, "running");
    await secondRepository.complete(
      batch[0],
      { outcome: "succeeded" },
      evidence(),
      0,
      new Date(now.getTime() + 14),
    );
    assertEquals(await idleInTransactionCount(setup), 0);
  } finally {
    if (firstSql) await firstSql.end({ timeout: 5 }).catch(() => undefined);
    if (secondSql) await secondSql.end({ timeout: 5 }).catch(() => undefined);
    if (setup) await closePostgresClient(setup).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("production service dead-letters pinned permanent failures before provider effects", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) return;
  const root = await Deno.makeTempDir({ prefix: "operant-outbox-permanent-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const fixture = await seedDelivery(sql);
    const repository = new PostgresOutboxRepository(sql);
    let now = new Date("2026-03-01T00:00:00.000Z");
    let runnerCalls = 0;
    type RunnerMode =
      | "success"
      | "invalid"
      | "capability"
      | "retry"
      | "retry_after";
    let runnerMode: RunnerMode = "success";
    const service = makeProcessOutboxService({
      sql,
      repository,
      authorization: {
        authorize: () => Promise.resolve({ ok: true, value: {} as never }),
      } as never,
      secrets: {
        resolve: () => Promise.resolve({ values: {}, evidence: [] }),
      } as unknown as PostgresHookSecretRepository,
      now: () => now,
      random: () => 0.5,
      workerId: uuidV7(),
      config: {
        pollIntervalMs: 1_000,
        batchSize: 1,
        leaseMarginMs: 1_000,
        initialBackoffMs: 100,
        maximumBackoffMs: 1_000,
        maximumRetryAfterMs: 500,
        shutdownGraceMs: 1_000,
      },
      runnerFactory: () => ({
        run: async (hook) => {
          await Promise.resolve();
          runnerCalls++;
          if (runnerMode === "capability") {
            return {
              ok: false,
              hook: hook.name,
              outputSchema: "delivery.v1",
              logs: "",
              durationMs: 0,
              exitCode: null,
              scriptDigest: hook.scriptDigest,
              error: {
                code: "hook_capability_denied",
                message: "deployment ceiling denied capability",
                details: {},
              },
            };
          }
          return {
            ok: true,
            hook: hook.name,
            outputSchema: "delivery.v1",
            output: runnerMode === "invalid"
              ? { outcome: "success" }
              : runnerMode === "retry"
              ? { outcome: "retry", code: "temporary", message: "later" }
              : runnerMode === "retry_after"
              ? {
                outcome: "retry",
                code: "temporary",
                message: "later",
                retry_after: "5s",
              }
              : { outcome: "succeeded" },
            logs: "",
            durationMs: 1,
            exitCode: 0,
            scriptDigest: hook.scriptDigest,
          };
        },
      }),
    });

    await service.processBatch(1);
    assertEquals(
      (await repository.inspect(fixture.deliveryId))?.status,
      "succeeded",
    );
    assertEquals(runnerCalls, 1);

    now = new Date(now.getTime() + 10_000);
    runnerMode = "retry";
    const retrying = await cloneDelivery(sql, fixture, now);
    await service.processBatch(1);
    let retryRow = await repository.inspect(retrying) as Record<
      string,
      unknown
    >;
    assertEquals(retryRow.status, "retry_wait");
    assertEquals(
      new Date(String(retryRow.available_at)).getTime(),
      now.getTime() + 50,
    );
    now = new Date(now.getTime() + 50);
    await service.processBatch(1);
    retryRow = await repository.inspect(retrying) as Record<string, unknown>;
    assertEquals(retryRow.status, "dead_letter");
    assertEquals(retryRow.last_error_code, "delivery_retry_exhausted");
    assertEquals(retryRow.total_attempts, 2);

    now = new Date(now.getTime() + 10_000);
    runnerMode = "retry_after";
    const retryAfter = await cloneDelivery(sql, fixture, now);
    await service.processBatch(1);
    const retryAfterRow = await repository.inspect(retryAfter) as Record<
      string,
      unknown
    >;
    assertEquals(
      new Date(String(retryAfterRow.available_at)).getTime(),
      now.getTime() + 500,
    );
    assertEquals(
      await repository.cancel(retryAfter, undefined, now),
      "cancelled",
    );

    const cases: Array<{
      name: string;
      overrides?: Parameters<typeof cloneDelivery>[3];
      prepare?: () => Promise<void>;
      cleanup?: () => Promise<void>;
      mode?: RunnerMode;
      expectedCode: string;
      runnerDelta: number;
    }> = [
      {
        name: "disabled revision",
        prepare: async () => {
          await query(
            sql!,
            `insert into hook_revision_delivery_controls(
            hook_revision_id,enabled,reason,changed_auth_context_id)
            values($1,false,'disabled by test',$2)`,
            [fixture.hook, fixture.auth],
          );
        },
        cleanup: async () => {
          await query(
            sql!,
            "delete from hook_revision_delivery_controls where hook_revision_id=$1",
            [fixture.hook],
          );
        },
        expectedCode: "pinned_hook_disabled",
        runnerDelta: 0,
      },
      {
        name: "script digest mismatch",
        overrides: { scriptDigest: hash("9") },
        expectedCode: "pinned_hook_digest_mismatch",
        runnerDelta: 0,
      },
      {
        name: "attachment digest mismatch",
        overrides: { attachmentDigest: hash("8") },
        expectedCode: "pinned_hook_digest_mismatch",
        runnerDelta: 0,
      },
      {
        name: "attachment identity mismatch",
        overrides: { attachmentSpec: { wrong: true } },
        expectedCode: "pinned_hook_digest_mismatch",
        runnerDelta: 0,
      },
      {
        name: "config digest mismatch",
        overrides: { configDigest: hash("7") },
        expectedCode: "pinned_hook_digest_mismatch",
        runnerDelta: 0,
      },
      {
        name: "missing pinned grant",
        overrides: {
          pinnedGrants: [{
            slot: "token",
            env: "TOKEN",
            grant_id: null,
            secret_id: null,
          }],
        },
        expectedCode: "hook_secret_grant_unavailable",
        runnerDelta: 0,
      },
      {
        name: "current capability ceiling",
        mode: "capability",
        expectedCode: "capability_unavailable",
        runnerDelta: 1,
      },
      {
        name: "invalid delivery output",
        mode: "invalid",
        expectedCode: "delivery_output_invalid",
        runnerDelta: 1,
      },
    ];
    let lastDead = "";
    for (const item of cases) {
      now = new Date(now.getTime() + 10_000);
      runnerMode = item.mode ?? "success";
      await item.prepare?.();
      const id = await cloneDelivery(sql, fixture, now, item.overrides);
      lastDead = id;
      const before = runnerCalls;
      const processed = await service.processBatch(1);
      assertEquals(processed.claimed, 1, item.name);
      const row = await repository.inspect(id) as Record<string, unknown>;
      assertEquals(row.status, "dead_letter", item.name);
      assertEquals(row.last_error_code, item.expectedCode, item.name);
      assertEquals(runnerCalls - before, item.runnerDelta, item.name);
      const attempts = await repository.attempts(id, 10);
      assertEquals(attempts.length, 1, item.name);
      assertEquals(
        (attempts[0] as { outcome: string }).outcome,
        "dead_letter",
        item.name,
      );
      await item.cleanup?.();
    }
    const authorization = new PostgresAuthorizationRepository(sql);
    const superAuth = {
      id: fixture.auth,
      principalId: fixture.principal,
      principalType: "human_user" as const,
      humanUserId: fixture.human,
      sessionId: fixture.session,
      credentialKind: "human_full" as const,
      roles: ["system:super_admin"],
      createdAt: now.toISOString(),
    };
    const ordinaryAuth = await seedOrdinaryAuth(sql);
    for (
      const action of [
        "outbox.inspect",
        "outbox.retry",
        "outbox.cancel",
        "outbox.drain",
      ]
    ) {
      assertEquals(
        (await authorization.authorize({
          auth: superAuth,
          boundary: { type: "system" },
          action,
          resource: "system:outbox",
        })).ok,
        true,
        action,
      );
      assertEquals(
        (await authorization.authorize({
          auth: ordinaryAuth,
          boundary: { type: "system" },
          action,
          resource: "system:outbox",
        })).ok,
        false,
        action,
      );
    }

    const mutationEntered = deferred<void>();
    const releaseMutation = deferred<void>();
    let mutationAllowed = true;
    const cutoffRepository = new PostgresOutboxRepository(
      sql,
      () => Promise.resolve(mutationAllowed),
      {
        async afterMutationRowLocked(id, operation) {
          if (id !== lastDead || operation !== "retry") return;
          mutationEntered.resolve();
          await releaseMutation.promise;
        },
      },
    );
    const auditBefore = Number(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from audit_events where event_type='outbox.retry'",
      )).rows[0].count,
    );
    const reopening = cutoffRepository.retry(lastDead, {
      authContextId: superAuth.id,
      auth: superAuth,
      reason: "must not commit",
    }, now);
    await mutationEntered.promise;
    mutationAllowed = false;
    releaseMutation.resolve();
    assertEquals(await reopening, "authorization_changed");
    assertEquals((await repository.inspect(lastDead))?.status, "dead_letter");
    assertEquals(
      Number(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from audit_events where event_type='outbox.retry'",
        )).rows[0].count,
      ),
      auditBefore,
    );

    const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
    const cryptoAdapter = new EnvelopeCrypto(key);
    const secretId = uuidV7();
    const grantId = uuidV7();
    const encryptedV1 = await cryptoAdapter.encrypt("secret-v1", {
      secret_id: secretId,
      value_version: 1,
    });
    await query(
      sql,
      `insert into platform_secrets(id,name,description,ciphertext,nonce,
       algorithm,key_id,value_version,status,created_auth_context_id,
       updated_auth_context_id) values($1,$2,'pinned rotation test',$3,$4,$5,$6,
       1,'active',$7,$7)`,
      [
        secretId,
        `outbox-secret-${secretId}`,
        encryptedV1.ciphertext,
        encryptedV1.nonce,
        encryptedV1.algorithm,
        encryptedV1.keyId,
        fixture.auth,
      ],
    );
    await sql.begin(async (tx) => {
      await query(
        tx,
        `insert into hook_secret_grants(id,hook_revision_id,hook_security_digest,
         slot,secret_id,created_auth_context_id) values($1,$2,$3,'token',$4,$5)`,
        [grantId, fixture.hook, hash("d"), secretId, fixture.auth],
      );
      await query(
        tx,
        `insert into hook_secret_grant_heads(hook_revision_id,slot,grant_id)
         values($1,'token',$2)`,
        [fixture.hook, grantId],
      );
    });
    const encryptedV2 = await cryptoAdapter.encrypt("secret-v2", {
      secret_id: secretId,
      value_version: 2,
    });
    await query(
      sql,
      `update platform_secrets set ciphertext=$2,nonce=$3,algorithm=$4,key_id=$5,
       value_version=2,updated_auth_context_id=$6 where id=$1`,
      [
        secretId,
        encryptedV2.ciphertext,
        encryptedV2.nonce,
        encryptedV2.algorithm,
        encryptedV2.keyId,
        fixture.auth,
      ],
    );
    const candidateV2 = uuidV7();
    const hookV2 = uuidV7();
    await sql.begin(async (tx) => {
      await query(
        tx,
        `insert into pack_candidate_revisions(id,publisher,pack_name,version,
         source_digest,content_digest,manifest,normalized,source_files)
         values($1,'test','outbox','2.0.0',$2,$3,'{}','{}','{}')`,
        [candidateV2, hash("1"), hash("2")],
      );
      await query(
        tx,
        `insert into pack_component_revisions(id,candidate_revision_id,
         definition_kind,definition_name,definition_digest,hook_security_digest,
         hook_script_digest,hook_normalized_config,hook_script_content)
         select $1,$2,'hook','notify',$3,$4,$5,hook_normalized_config,
         'console.log(JSON.stringify({outcome:"succeeded",summary:"v2"}))'
         from pack_component_revisions where id=$6`,
        [hookV2, candidateV2, hash("3"), hash("4"), hash("5"), fixture.hook],
      );
      await query(
        tx,
        `insert into pack_active_revisions(publisher,pack_name,candidate_revision_id,
         activated_at) values('test','outbox',$1,now())`,
        [candidateV2],
      );
    });
    const secretRepository = new PostgresHookSecretRepository(
      sql,
      cryptoAdapter,
    );
    const resolved = await secretRepository.resolve(
      fixture.hook,
      hash("d"),
      [{
        slot: "token",
        env: "TOKEN",
        grant_id: grantId,
        secret_id: secretId,
      }],
    );
    assertEquals(resolved.values, { TOKEN: "secret-v2" });
    assertEquals(resolved.evidence, [{
      grant_id: grantId,
      secret_id: secretId,
      value_version: 2,
      slot: "token",
      env: "TOKEN",
    }]);
    await assertRejects(
      () =>
        secretRepository.resolve(fixture.hook, hash("0"), [{
          slot: "token",
          env: "TOKEN",
          grant_id: grantId,
          secret_id: secretId,
        }]),
      HookSecretGrantUnavailableError,
    );
    const replacement = uuidV7();
    await sql.begin(async (tx) => {
      await query(
        tx,
        `insert into hook_secret_grants(id,hook_revision_id,hook_security_digest,
         slot,secret_id,created_auth_context_id,supersedes_grant_id)
         values($1,$2,$3,'token',$4,$5,$6)`,
        [replacement, fixture.hook, hash("d"), secretId, fixture.auth, grantId],
      );
      await query(
        tx,
        `update hook_secret_grant_heads set grant_id=$1,version=version+1
         where hook_revision_id=$2 and slot='token'`,
        [replacement, fixture.hook],
      );
    });
    await assertRejects(
      () =>
        secretRepository.resolve(fixture.hook, hash("d"), [{
          slot: "token",
          env: "TOKEN",
          grant_id: grantId,
          secret_id: secretId,
        }]),
      HookSecretGrantUnavailableError,
    );
    await query(
      sql,
      "update platform_secrets set ciphertext=$2 where id=$1",
      [secretId, new Uint8Array([1, 2, 3])],
    );
    await assertRejects(
      () =>
        secretRepository.resolve(fixture.hook, hash("d"), [{
          slot: "token",
          env: "TOKEN",
          grant_id: replacement,
          secret_id: secretId,
        }]),
      HookSecretUnavailableError,
    );
    await query(
      sql,
      "update platform_secrets set ciphertext=$2,status='disabled',disabled_at=now(),disabled_auth_context_id=$3 where id=$1",
      [secretId, encryptedV2.ciphertext, fixture.auth],
    );
    await assertRejects(
      () =>
        secretRepository.resolve(fixture.hook, hash("d"), [{
          slot: "token",
          env: "TOKEN",
          grant_id: replacement,
          secret_id: secretId,
        }]),
      HookSecretUnavailableError,
    );
    await query(
      sql,
      "update platform_secrets set status='active',disabled_at=null,disabled_auth_context_id=null where id=$1",
      [secretId],
    );
    await query(
      sql,
      `insert into hook_secret_grant_revocations(id,grant_id,
       revoked_auth_context_id,reason) values($1,$2,$3,'revoked by test')`,
      [uuidV7(), replacement, fixture.auth],
    );
    await assertRejects(
      () =>
        secretRepository.resolve(fixture.hook, hash("d"), [{
          slot: "token",
          env: "TOKEN",
          grant_id: replacement,
          secret_id: secretId,
        }]),
      HookSecretGrantUnavailableError,
    );

    const leak = JSON.stringify(
      (await query(
        sql,
        `select envelope_json,
      last_error_message from outbox_deliveries order by created_at`,
      )).rows,
    );
    assertEquals(leak.includes("plaintext-secret"), false);
    assertEquals(await idleInTransactionCount(sql), 0);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

async function seedDelivery(sql: ReturnType<typeof createPostgresClient>) {
  const principal = uuidV7();
  const human = uuidV7();
  const session = uuidV7();
  const auth = uuidV7();
  const commit = uuidV7();
  const event = uuidV7();
  const candidate = uuidV7();
  const hook = uuidV7();
  const attachment = uuidV7();
  const deliveryId = uuidV7();
  await sql.begin(async (tx) => {
    await query(
      tx,
      "insert into principals(id,type,active) values($1,'human_user',true)",
      [principal],
    );
    await query(
      tx,
      "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,'Outbox Test','active')",
      [human, principal, `outbox-${human}`],
    );
    await query(
      tx,
      "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full',$4)",
      [session, principal, human, `digest-${session}`],
    );
    await query(
      tx,
      "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{system:super_admin}',now())",
      [auth, principal, human, session],
    );
    await query(
      tx,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:super_admin','system',true)",
      [uuidV7(), principal],
    );
    await query(
      tx,
      "insert into changeset_commits(id,committed_auth_context_id) values($1,$2)",
      [commit, auth],
    );
    await query(
      tx,
      "insert into events(id,changeset_commit_id,schema_version,event_type,payload_json) values($1,$2,1,'changeset.committed','{}')",
      [event, commit],
    );
    await query(
      tx,
      `insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files)
      values($1,'test','outbox','1.0.0',$2,$3,'{}','{}','{}')`,
      [candidate, hash("a"), hash("b")],
    );
    const config = {
      spec: {
        output: { schema: "delivery.v1" },
        permissions: {},
        secrets: [],
        effects: {},
      },
    };
    await query(
      tx,
      `insert into pack_component_revisions(id,candidate_revision_id,definition_kind,definition_name,definition_digest,
      hook_security_digest,hook_script_digest,hook_normalized_config,hook_script_content)
      values($1,$2,'hook','notify',$3,$4,$5,$6::jsonb,'')`,
      [hook, candidate, hash("c"), hash("d"), hash("e"), config],
    );
    const declaration = {
      hook: "test/outbox:notify",
      phase: "event.after_commit",
      resource: null,
      action: null,
      event: "changeset.committed",
      order: 0,
      condition: null,
      input: {},
    };
    await query(
      tx,
      `insert into pack_hook_attachment_revisions(id,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
      phase,ordinal,declaration_digest,declaration_spec) values($1,$2,$3,'test/outbox:notify',null,'event.after_commit',0,$4,$5::jsonb)`,
      [
        attachment,
        candidate,
        hook,
        `sha256:${await canonicalSha256(declaration)}`,
        declaration,
      ],
    );
    await query(
      tx,
      `insert into outbox_deliveries(id,event_id,attachment_id,candidate_revision_id,hook_revision_id,hook_identity,
      script_digest,security_digest,attachment_digest,config_digest,envelope_schema,output_schema,envelope_json,attachment_spec_json,
      hook_config_json,capabilities_json,effects_json,pinned_grants_json,auth_context_id,changeset_commit_id,status,max_attempts,timeout_ms,available_at)
      values($1,$2,$3,$4,$5,'test/outbox:notify',$6,$7,$8,$9,'delivery.v1','delivery.v1','{}',$10::jsonb,'{}','{}','{}','[]',$11,$12,'pending',2,1,$13)`,
      [
        deliveryId,
        event,
        attachment,
        candidate,
        hook,
        hash("e"),
        hash("d"),
        `sha256:${await canonicalSha256(declaration)}`,
        `sha256:${await canonicalSha256(config)}`,
        declaration,
        auth,
        commit,
        new Date("2026-01-01T00:00:00.000Z"),
      ],
    );
  });
  return {
    deliveryId,
    event,
    attachment,
    candidate,
    hook,
    auth,
    principal,
    human,
    session,
    commit,
  };
}

async function seedOrdinaryAuth(
  sql: ReturnType<typeof createPostgresClient>,
) {
  const principal = uuidV7();
  const human = uuidV7();
  const session = uuidV7();
  const id = uuidV7();
  await sql.begin(async (tx) => {
    await query(
      tx,
      "insert into principals(id,type,active) values($1,'human_user',true)",
      [principal],
    );
    await query(
      tx,
      "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,$3,'Ordinary Outbox','active')",
      [human, principal, `ordinary-${human}`],
    );
    await query(
      tx,
      "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full',$4)",
      [session, principal, human, `ordinary-${session}`],
    );
    await query(
      tx,
      "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{}',now())",
      [id, principal, human, session],
    );
  });
  return {
    id,
    principalId: principal,
    principalType: "human_user" as const,
    humanUserId: human,
    sessionId: session,
    credentialKind: "human_full" as const,
    roles: [] as string[],
    createdAt: new Date().toISOString(),
  };
}

async function cloneDelivery(
  sql: ReturnType<typeof createPostgresClient>,
  fixture: Awaited<ReturnType<typeof seedDelivery>>,
  availableAt: Date,
  overrides: {
    scriptDigest?: string;
    attachmentDigest?: string;
    configDigest?: string;
    attachmentSpec?: unknown;
    pinnedGrants?: unknown[];
  } = {},
): Promise<string> {
  const event = uuidV7();
  const delivery = uuidV7();
  await sql.begin(async (tx) => {
    await query(
      tx,
      "insert into events(id,changeset_commit_id,schema_version,event_type,payload_json) values($1,$2,1,'changeset.committed','{}')",
      [event, fixture.commit],
    );
    await query(
      tx,
      `insert into outbox_deliveries(id,event_id,attachment_id,candidate_revision_id,
       hook_revision_id,hook_identity,script_digest,security_digest,attachment_digest,
       config_digest,envelope_schema,output_schema,envelope_json,attachment_spec_json,
       hook_config_json,capabilities_json,effects_json,pinned_grants_json,
       auth_context_id,changeset_commit_id,status,retry_generation,
       attempts_in_generation,total_attempts,max_attempts,timeout_ms,available_at,
       created_at,updated_at)
       select $1,$2,attachment_id,candidate_revision_id,hook_revision_id,hook_identity,
       coalesce($5,script_digest),security_digest,coalesce($6,attachment_digest),
       coalesce($7,config_digest),envelope_schema,output_schema,envelope_json,
       coalesce($8::jsonb,attachment_spec_json),hook_config_json,
       capabilities_json,effects_json,coalesce($9::jsonb,pinned_grants_json),
       auth_context_id,changeset_commit_id,'pending',0,0,0,max_attempts,timeout_ms,
       $3,$3,$3 from outbox_deliveries where id=$4`,
      [
        delivery,
        event,
        availableAt,
        fixture.deliveryId,
        overrides.scriptDigest ?? null,
        overrides.attachmentDigest ?? null,
        overrides.configDigest ?? null,
        overrides.attachmentSpec ?? null,
        overrides.pinnedGrants ?? null,
      ],
    );
  });
  return delivery;
}

async function observeBlocked(
  sql: ReturnType<typeof createPostgresClient>,
  applicationName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const row = (await query<{ blocked: boolean; diagnostics: unknown }>(
      sql,
      `select coalesce(bool_or(cardinality(pg_blocking_pids(pid))>0),false) blocked,
        coalesce(jsonb_agg(jsonb_build_object('pid',pid,'state',state,
          'wait_event_type',wait_event_type,'wait_event',wait_event,
          'blocking',pg_blocking_pids(pid))) filter(where pid is not null),'[]') diagnostics
       from pg_stat_activity where application_name=$1`,
      [applicationName],
    )).rows[0];
    if (row?.blocked) return;
    await Promise.resolve();
  }
  const diagnostics = (await query(
    sql,
    `select pid,application_name,state,wait_event_type,wait_event,
      pg_blocking_pids(pid) blocking,left(query,200) query
     from pg_stat_activity where datname=current_database() order by pid`,
  )).rows;
  throw new Error(
    `bounded waiter observation failed: ${JSON.stringify(diagnostics)}`,
  );
}

async function idleInTransactionCount(
  sql: ReturnType<typeof createPostgresClient>,
): Promise<number> {
  return Number(
    (await query<{ count: string }>(
      sql,
      "select count(*)::text count from pg_stat_activity where datname=current_database() and state='idle in transaction'",
    )).rows[0]?.count ?? "0",
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function evidence() {
  return {
    duration_ms: 1,
    exit_code: 0,
    logs: "",
    logs_truncated: false,
    secrets_redacted: false,
    grants: [],
  };
}
function hash(character: string) {
  return `sha256:${character.repeat(64)}`;
}
