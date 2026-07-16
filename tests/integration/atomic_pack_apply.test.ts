import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  closePostgresClient,
  createPostgresClient,
  query,
} from "../../src/adapters/outbound/postgres/client.ts";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import { getDefinition } from "../../src/adapters/outbound/postgres/pack_repository.ts";
import {
  findPostgresBins,
  startPostgresRuntime,
} from "../../src/adapters/outbound/postgres-process/lifecycle.ts";
import {
  applyMigrationPlan,
  createPackMigrationPlan,
  getMigrationPlan,
  validateMigrationPlan,
} from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";

Deno.test("atomic pack apply activates globally, is idempotent, and rolls back injected failures", async () => {
  if (Deno.env.get("OPERANT_DATABASE_URL") || !await findPostgresBins()) {
    throw new Error("PostgreSQL 18.4 app-managed binaries are required");
  }
  const root = await Deno.makeTempDir({ prefix: "operant-atomic-pack-" });
  const previous = Deno.env.get("OPERANT_DATA_DIR");
  Deno.env.set("OPERANT_DATA_DIR", root);
  let runtime: Awaited<ReturnType<typeof startPostgresRuntime>> | undefined;
  let sql: ReturnType<typeof createPostgresClient> | undefined;
  try {
    runtime = await startPostgresRuntime();
    sql = createPostgresClient(runtime.databaseUrl);
    await sql.begin((tx) => applyPlatformMigrations(tx));
    const principal = uuidV7(),
      human = uuidV7(),
      session = uuidV7(),
      auth = uuidV7();
    await query(
      sql,
      "insert into principals(id,type,active) values($1,'human_user',true)",
      [principal],
    );
    await query(
      sql,
      "insert into human_users(id,principal_id,username,display_name,status) values($1,$2,'apply-test','Apply Test','active')",
      [human, principal],
    );
    await query(
      sql,
      "insert into auth_sessions(id,principal_id,human_user_id,credential_kind,token_digest) values($1,$2,$3,'human_full','apply-test')",
      [session, principal, human],
    );
    await query(
      sql,
      "insert into auth_contexts(id,principal_id,human_user_id,session_id,credential_kind,roles,created_at) values($1,$2,$3,$4,'human_full','{system:super_admin}',now())",
      [auth, principal, human, session],
    );

    const pack = await loadPackFromFiles(
      await packFiles("prototypes/crm-default-pack"),
    );
    const first = await createPackMigrationPlan(sql, pack, auth);
    const competing = await createPackMigrationPlan(sql, pack, auth);
    for (const plan of [first.plan, competing.plan]) {
      const validation = await sql.begin((tx) =>
        validateMigrationPlan(tx, plan.id, auth)
      ) as Record<string, unknown>;
      assertEquals(validation.status, "ready");
      assertEquals(validation.confirmation_token, null);
    }
    const concurrent = await Promise.allSettled(
      [first.plan, competing.plan].map((plan) =>
        sql!.begin((tx) =>
          applyMigrationPlan(tx, plan.id, { acknowledgement: "safe" }, auth)
        )
      ),
    );
    assertEquals(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assertEquals(
      concurrent.filter((result) => result.status === "rejected").length,
      1,
    );
    const winnerIndex = concurrent.findIndex((result) =>
      result.status === "fulfilled"
    );
    const winner = [first.plan, competing.plan][winnerIndex];
    const applied = concurrent[winnerIndex].status === "fulfilled"
      ? concurrent[winnerIndex].value
      : null;
    assert(applied);
    const repeated = await sql.begin((tx) =>
      applyMigrationPlan(tx, winner.id, { acknowledgement: "safe" }, auth)
    );
    assertEquals(repeated, applied);
    assertEquals((await getMigrationPlan(sql, winner.id))?.status, "applied");
    assertEquals(
      (await query<{ id: string }>(
        sql,
        "select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm'",
      )).rows[0].id,
      first.plan.to_pack_revision_id,
    );
    assert(
      Number(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_runtime_tables where publisher='operant' and pack_name='crm'",
        )).rows[0].count,
      ) > 1,
    );
    const activeDefinition = await getDefinition(
      sql,
      "resources",
      "operant",
      "crm",
      "lead",
    );
    if (!activeDefinition) {
      const debug = await query<{ keys: string[] }>(
        sql,
        `select jsonb_object_keys(cr.normalized->'resources') keys from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id where ar.publisher='operant' and ar.pack_name='crm'`,
      );
      throw new Error(
        `missing active lead metadata: ${JSON.stringify(debug.rows)}`,
      );
    }

    for (const fault of ["after_sql", "after_application"] as const) {
      const candidate = structuredClone(pack);
      candidate.version = `0.1.${fault === "after_sql" ? 1 : 2}`;
      candidate.sourceDigest = `sha256:${
        fault === "after_sql" ? "a" : "b".repeat(64)
      }`;
      if (fault === "after_sql") {
        candidate.sourceDigest = `sha256:${"a".repeat(64)}`;
      }
      candidate.revision = `operant/crm@${candidate.version}:sha256:${
        "c".repeat(64)
      }`;
      const next = await createPackMigrationPlan(sql, candidate, auth);
      await sql.begin((tx) => validateMigrationPlan(tx, next.plan.id, auth));
      await assertRejects(
        () =>
          sql!.begin((tx) =>
            applyMigrationPlan(
              tx,
              next.plan.id,
              { acknowledgement: "safe" },
              auth,
              fault,
            )
          ),
        Error,
        "injected migration failure",
      );
      assertEquals(
        (await query<{ id: string }>(
          sql,
          "select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm'",
        )).rows[0].id,
        first.plan.to_pack_revision_id,
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_migration_applications where plan_id=$1",
          [next.plan.id],
        )).rows[0].count,
        "0",
      );
    }

    const timeoutCandidate = structuredClone(pack);
    timeoutCandidate.version = "0.1.9";
    timeoutCandidate.sourceDigest = `sha256:${"9".repeat(64)}`;
    timeoutCandidate.revision = `operant/crm@0.1.9:sha256:${"8".repeat(64)}`;
    const timeoutPlan = await createPackMigrationPlan(
      sql,
      timeoutCandidate,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, timeoutPlan.plan.id, auth)
    );
    const lockedTable = (await query<{ table_name: string }>(
      sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' order by case definition_kind when 'resource' then 0 else 1 end,definition_name,table_name limit 1",
    )).rows[0].table_name;
    const acquired = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = sql.begin(async (tx) => {
      await query(tx, `lock table "${lockedTable}" in row exclusive mode`);
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const timeoutError = await assertRejects(
      () =>
        sql!.begin((tx) =>
          applyMigrationPlan(tx, timeoutPlan.plan.id, {
            acknowledgement: "safe",
            lock_timeout: "1ms",
          }, auth)
        ),
      Error,
    );
    assertEquals((timeoutError as Error & { code?: string }).code, "55P03");
    release.resolve();
    await blocker;

    const destructive = structuredClone(pack);
    destructive.version = "0.2.0";
    destructive.sourceDigest = `sha256:${"d".repeat(64)}`;
    destructive.revision = `operant/crm@0.2.0:sha256:${"e".repeat(64)}`;
    delete (destructive.resources.lead.spec.fields as Record<string, unknown>)
      .phone;
    delete ((destructive.resources.lead.document.spec as Record<
      string,
      unknown
    >).fields as Record<string, unknown>).phone;
    delete ((((destructive.normalized.resources as Record<string, any>).lead
      .spec as Record<string, unknown>).fields) as Record<string, unknown>)
      .phone;
    const removal = await createPackMigrationPlan(sql, destructive, auth);
    const confirmed = await sql.begin((tx) =>
      validateMigrationPlan(tx, removal.plan.id, auth)
    ) as Record<string, unknown>;
    assertEquals(confirmed.status, "ready");
    const token = String(confirmed.confirmation_token);
    assertEquals(token.length, 43);
    assertEquals(
      (await query<{ leaked: boolean }>(
        sql,
        "select exists(select 1 from pack_migration_confirmation_tokens where token_digest=$1) leaked",
        [token],
      )).rows[0].leaked,
      false,
    );
    await assertRejects(
      () =>
        sql!.begin((tx) =>
          applyMigrationPlan(tx, removal.plan.id, {
            acknowledgement: "destructive",
            confirmation_token: "wrong",
          }, auth)
        ),
      Error,
      "confirmation token",
    );
    await query(
      sql,
      "update pack_migration_confirmation_tokens set expires_at=now()-interval '1 second' where plan_id=$1",
      [removal.plan.id],
    );
    await assertRejects(
      () =>
        sql!.begin((tx) =>
          applyMigrationPlan(tx, removal.plan.id, {
            acknowledgement: "destructive",
            confirmation_token: token,
          }, auth)
        ),
      Error,
      "confirmation token",
    );
    const refreshed = await sql.begin((tx) =>
      validateMigrationPlan(tx, removal.plan.id, auth)
    ) as Record<string, unknown>;
    const finalToken = String(refreshed.confirmation_token);
    const destructiveApplication = await sql.begin((tx) =>
      applyMigrationPlan(tx, removal.plan.id, {
        acknowledgement: "destructive",
        confirmation_token: finalToken,
      }, auth)
    );
    assert(destructiveApplication);
    const leadTable = (await query<{ table_name: string }>(
      sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    assertEquals(
      (await query<{ exists: boolean }>(
        sql,
        "select exists(select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name='phone') exists",
        [leadTable],
      )).rows[0].exists,
      false,
    );
    assertEquals(
      (await query<{ used: boolean }>(
        sql,
        "select consumed_at is not null used from pack_migration_confirmation_tokens where token_digest=$1",
        [await tokenDigest(finalToken)],
      )).rows[0].used,
      true,
    );

    const risky = structuredClone(destructive);
    risky.version = "0.3.0";
    risky.sourceDigest = `sha256:${"f".repeat(64)}`;
    risky.revision = `operant/crm@0.3.0:sha256:${"1".repeat(64)}`;
    const actionName = Object.keys(risky.actions).sort()[0];
    (risky.actions[actionName].document.spec as Record<string, unknown>)
      .description = "reviewed behavior change";
    ((risky.normalized.actions as Record<string, any>)[actionName]
      .spec as Record<string, unknown>).description =
        "reviewed behavior change";
    const riskyPlan = await createPackMigrationPlan(sql, risky, auth);
    assertEquals(riskyPlan.plan.class, "risky");
    const riskyValidation = await sql.begin((tx) =>
      validateMigrationPlan(tx, riskyPlan.plan.id, auth)
    ) as Record<string, unknown>;
    assertEquals(riskyValidation.confirmation_token, null);
    await assertRejects(
      () =>
        sql!.begin((tx) =>
          applyMigrationPlan(tx, riskyPlan.plan.id, {
            acknowledgement: "reviewed",
            confirmation_token: "forbidden",
          }, auth)
        ),
      Error,
      "forbidden",
    );
    assert(
      await sql.begin((tx) =>
        applyMigrationPlan(tx, riskyPlan.plan.id, {
          acknowledgement: "reviewed",
        }, auth)
      ),
    );
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

async function tokenDigest(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function packFiles(dir: string): Promise<UploadedPackFile[]> {
  const files: UploadedPackFile[] = [];
  async function collect(path: string, prefix = "") {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) await collect(child, relative);
      else if (/\.(?:yaml|ts)$/.test(relative)) {
        files.push({ path: relative, text: await Deno.readTextFile(child) });
      }
    }
  }
  await collect(dir);
  return files;
}
