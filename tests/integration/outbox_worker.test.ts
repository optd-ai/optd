import { assertEquals } from "jsr:@std/assert";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  applyPlatformMigrations,
} from "../../src/adapters/outbound/postgres/migrations.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import { PostgresTransactionManager } from "../../src/adapters/outbound/postgres/transaction_manager.ts";
import { DenoHookRunner } from "../../src/adapters/outbound/deno-hooks/hook_runner.ts";
import { makeProcessOutboxService } from "../../src/application/services/process_outbox.ts";

class BlockingHookRunner extends DenoHookRunner {
  calls = 0;
  constructor(private readonly delayMs = 100) {
    super();
  }
  override async run(hook: Parameters<DenoHookRunner["run"]>[0]) {
    this.calls++;
    await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return {
      ok: true,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      output: { errors: [], warnings: [] },
      logs: "",
      durationMs: this.delayMs,
      exitCode: 0,
      scriptDigest: hook.scriptDigest,
    };
  }
}

class FailingHookRunner extends DenoHookRunner {
  override async run(hook: Parameters<DenoHookRunner["run"]>[0]) {
    return {
      ok: false,
      hook: hook.name,
      outputSchema: hook.outputSchema,
      logs: "boom",
      durationMs: 1,
      exitCode: 1,
      scriptDigest: hook.scriptDigest,
      error: { code: "hook_failed", message: "boom", details: {} },
    };
  }
}

Deno.test("outbox SKIP LOCKED claim prevents double processing", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP outbox worker integration: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }
  const dataDir = await Deno.makeTempDir({ prefix: "operant-outbox-worker-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }
  const runtime = await startPostgresRuntime();
  const sql = createPostgresClient(runtime.databaseUrl);
  try {
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const revision = `rev_${crypto.randomUUID()}`;
    const changesetId = `cs_${crypto.randomUUID()}`;
    const eventId = `evt_${crypto.randomUUID()}`;
    const outboxId = `ob_${crypto.randomUUID()}`;
    await query(
      sql,
      `insert into pack_revisions(revision,namespace,name,version,active,manifest,normalized)
       values ($1,'default','test','0.1.0',true,'{}'::jsonb,'{}'::jsonb)`,
      [revision],
    );
    await query(
      sql,
      `insert into pack_source_files(revision,path,digest,kind,content)
       values ($1,'hooks/test.ts','digest-test','script','console.log("{}")')`,
      [revision],
    );
    await query(
      sql,
      `insert into hook_definitions(revision,namespace,name,script_path,script_digest,spec,document)
       values ($1,'default','test_hook','hooks/test.ts','digest-test',$2::jsonb,$2::jsonb)`,
      [
        revision,
        JSON.stringify({
          script: "test.ts",
          output: { schema: "validation.v1" },
          permissions: {},
        }),
      ],
    );
    await query(
      sql,
      `insert into changesets(id,actor_id,status,request_json,preview_json,committed_at)
       values ($1,'actor','committed','{}'::jsonb,'{}'::jsonb,now())`,
      [changesetId],
    );
    await query(
      sql,
      `insert into events(id,changeset_id,event_type,payload_json)
       values ($1,$2,'changeset.committed','{}'::jsonb)`,
      [eventId, changesetId],
    );
    await query(
      sql,
      `insert into outbox(id,event_id,hook,phase,hook_revision,script_digest,payload_json,envelope_json)
       values ($1,$2,'default.test_hook','event.after_commit',$3,'digest-test',$4::jsonb,$5::jsonb)`,
      [
        outboxId,
        eventId,
        revision,
        JSON.stringify({ actor_id: "actor", event_id: eventId }),
        JSON.stringify({
          hook: "test_hook",
          phase: "event.after_commit",
          input: { actor_id: "actor", event_id: eventId },
        }),
      ],
    );

    const runner = new BlockingHookRunner();
    const service = makeProcessOutboxService({
      sql,
      tx: new PostgresTransactionManager(sql),
      hookRunner: runner,
      maxAttempts: 3,
    });
    const [first, second] = await Promise.all([
      service.drain({ limit: 1, worker_id: "worker-a" }),
      service.drain({ limit: 1, worker_id: "worker-b" }),
    ]);
    if (!first.ok) throw new Error(first.error.message);
    if (!second.ok) throw new Error(second.error.message);
    assertEquals(first.value.claimed + second.value.claimed, 1);
    assertEquals(runner.calls, 1);
    const outbox = await query<{ status: string; attempts: number }>(
      sql,
      "select status,attempts from outbox where id=$1",
      [outboxId],
    );
    assertEquals(outbox.rows[0]?.status, "succeeded");
    assertEquals(Number(outbox.rows[0]?.attempts), 1);
    const executions = await query<{ count: string }>(
      sql,
      "select count(*)::text as count from hook_executions where hook='default.test_hook' and phase='event.after_commit'",
    );
    assertEquals(Number(executions.rows[0]?.count ?? 0), 1);
  } finally {
    await closePostgresClient(sql).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => undefined);
  }
});

Deno.test("outbox failures retry and dead-letter with explicit retry reset", async () => {
  if (!Deno.env.get("OPERANT_DATABASE_URL") && !await findPostgresBins()) {
    console.warn(
      "SKIP outbox retry/dead-letter integration: postgres binaries not found; set OPERANT_PG_BIN_DIR or enter nix shell",
    );
    return;
  }
  const dataDir = await Deno.makeTempDir({ prefix: "operant-outbox-dead-" });
  const previousDataDir = Deno.env.get("OPERANT_DATA_DIR");
  if (!Deno.env.get("OPERANT_DATABASE_URL")) {
    Deno.env.set("OPERANT_DATA_DIR", dataDir);
  }
  const runtime = await startPostgresRuntime();
  const sql = createPostgresClient(runtime.databaseUrl);
  try {
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const revision = `rev_${crypto.randomUUID()}`;
    const changesetId = `cs_${crypto.randomUUID()}`;
    const eventId = `evt_${crypto.randomUUID()}`;
    const outboxId = `ob_${crypto.randomUUID()}`;
    await query(
      sql,
      `insert into pack_revisions(revision,namespace,name,version,active,manifest,normalized)
       values ($1,'default','dead','0.1.0',true,'{}'::jsonb,'{}'::jsonb)`,
      [revision],
    );
    await query(
      sql,
      `insert into pack_source_files(revision,path,digest,kind,content)
       values ($1,'hooks/fail.ts','digest-fail','script','Deno.exit(1)')`,
      [revision],
    );
    await query(
      sql,
      `insert into hook_definitions(revision,namespace,name,script_path,script_digest,spec,document)
       values ($1,'default','fail_hook','hooks/fail.ts','digest-fail',$2::jsonb,$2::jsonb)`,
      [
        revision,
        JSON.stringify({
          output: { schema: "validation.v1" },
          permissions: {},
        }),
      ],
    );
    await query(
      sql,
      `insert into changesets(id,actor_id,status,request_json,preview_json,committed_at)
       values ($1,'actor','committed','{}'::jsonb,'{}'::jsonb,now())`,
      [changesetId],
    );
    await query(
      sql,
      `insert into events(id,changeset_id,event_type,payload_json)
       values ($1,$2,'changeset.committed','{}'::jsonb)`,
      [eventId, changesetId],
    );
    await query(
      sql,
      `insert into outbox(id,event_id,hook,phase,hook_revision,script_digest,payload_json,envelope_json)
       values ($1,$2,'default.fail_hook','event.after_commit',$3,'digest-fail',$4::jsonb,$4::jsonb)`,
      [
        outboxId,
        eventId,
        revision,
        JSON.stringify({ input: { actor_id: "actor", event_id: eventId } }),
      ],
    );

    const service = makeProcessOutboxService({
      sql,
      tx: new PostgresTransactionManager(sql),
      hookRunner: new FailingHookRunner(),
      maxAttempts: 2,
    });
    const first = await service.drain({ limit: 1 });
    if (!first.ok) throw new Error(first.error.message);
    assertEquals(first.value.failed, 1);
    await query(sql, "update outbox set available_at=now() where id=$1", [
      outboxId,
    ]);
    const second = await service.drain({ limit: 1 });
    if (!second.ok) throw new Error(second.error.message);
    assertEquals(second.value.dead_lettered, 1);
    const dead = await query<
      { status: string; attempts: number; last_error: string }
    >(
      sql,
      "select status,attempts,last_error from outbox where id=$1",
      [outboxId],
    );
    assertEquals(dead.rows[0]?.status, "dead_letter");
    assertEquals(Number(dead.rows[0]?.attempts), 2);
    assertEquals(dead.rows[0]?.last_error, "boom");
    const retry = await service.retry(outboxId);
    if (!retry.ok) throw new Error(retry.error.message);
    assertEquals(retry.value.status, "pending");
    assertEquals(Number(retry.value.attempts), 0);
  } finally {
    await closePostgresClient(sql).catch(() => undefined);
    await runtime.stop().catch(() => undefined);
    if (previousDataDir === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previousDataDir);
    await Deno.remove(dataDir, { recursive: true }).catch(() => undefined);
  }
});
