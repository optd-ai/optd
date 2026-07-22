// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertNotEquals, assertRejects } from "jsr:@std/assert";
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
import { PostgresOutboxRepository } from "../../src/adapters/outbound/postgres/outbox_repository.ts";
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
    await query(
      tx,
      `insert into pack_component_revisions(id,candidate_revision_id,definition_kind,definition_name,definition_digest,
      hook_security_digest,hook_script_digest,hook_normalized_config,hook_script_content)
      values($1,$2,'hook','notify',$3,$4,$5,$6::jsonb,'')`,
      [hook, candidate, hash("c"), hash("d"), hash("e"), {
        spec: {
          output: { schema: "delivery.v1" },
          permissions: {},
          secrets: [],
          effects: {},
        },
      }],
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
      [attachment, candidate, hook, hash("6"), declaration],
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
        hash("6"),
        hash("7"),
        declaration,
        auth,
        commit,
        new Date("2026-01-01T00:00:00.000Z"),
      ],
    );
  });
  return { deliveryId };
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
