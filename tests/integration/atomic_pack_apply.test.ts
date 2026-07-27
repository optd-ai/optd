// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  closePostgresClient,
  createPostgresClient,
  query,
  type Queryable,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import { applyPlatformMigrations } from "../../src/adapters/outbound/postgres/migrations.ts";
import { getDefinition } from "../../src/adapters/outbound/postgres/pack_repository.ts";
import { PostgresTransactionManager } from "../../src/adapters/outbound/postgres/transaction_manager.ts";
import { PostgresAuthorizationRepository } from "../../src/adapters/outbound/postgres/authorization_repository.ts";
import { makePostgresMigrationPersistence } from "../../src/adapters/outbound/postgres/repositories/migration_application_repository.ts";
import {
  makeMigrationServices,
  type MigrationRetryConfig,
} from "../../src/application/services/migration_services.ts";
import type { AuthorizationRepository } from "../../src/application/ports/authorization.ts";
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

type MigrationTestDeps =
  & Parameters<typeof makePostgresMigrationPersistence>[0]
  & {
    authorization: AuthorizationRepository;
    retry?: MigrationRetryConfig;
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  };

function makeMigrationTestServices(deps: MigrationTestDeps) {
  return makeMigrationServices({
    persistence: makePostgresMigrationPersistence(deps),
    authorization: deps.authorization,
    retry: deps.retry ??
      { maximumRetries: 2, jitterMinimumMs: 0, jitterMaximumMs: 0 },
    random: deps.random ?? (() => 0),
    sleep: deps.sleep ?? (() => Promise.resolve()),
  });
}

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
    const assignmentId = uuidV7();
    await query(
      sql,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:super_admin','system',true)",
      [assignmentId, principal],
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
    const projection = (await query<{
      roles: string;
      policies: string;
      rules: string;
      defaults: string;
    }>(
      sql,
      `select
      (select count(*)::text from role_definition_versions where candidate_revision_id=$1 and active) roles,
      (select count(*)::text from policy_definition_versions where candidate_revision_id=$1 and active) policies,
      (select count(*)::text from policy_rules pr join policy_definition_versions pd on pd.id=pr.policy_definition_version_id where pd.candidate_revision_id=$1) rules,
      (select count(*)::text from policy_assignments pa join policy_definition_versions pd on pd.id=pa.policy_definition_version_id where pd.candidate_revision_id=$1 and pa.active and pa.source='pack_default') defaults`,
      [first.plan.to_pack_revision_id],
    )).rows[0];
    assert(Number(projection.roles) > 0);
    assert(Number(projection.policies) > 0);
    assert(Number(projection.rules) > 0);
    assert(Number(projection.defaults) > 0);
    const carryProject = uuidV7();
    await query(
      sql,
      "insert into projects(id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id) values($1,'carry-project','Carry Project',$2,$2)",
      [carryProject, auth],
    );
    const activePolicyVersion = (await query<{ id: string }>(
      sql,
      "select id from policy_definition_versions where policy_id='operant/crm:sales_access' and active",
    )).rows[0].id;
    const carriedAssignmentIds = [uuidV7(), uuidV7(), uuidV7()];
    for (
      const [index, boundary] of [
        "project",
        "all_projects",
        "system",
      ].entries()
    ) {
      await query(
        sql,
        `insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,source,created_by_auth_context_id)
         values($1,$2,$3,$4,true,'operator',$5)`,
        [
          carriedAssignmentIds[index],
          activePolicyVersion,
          boundary,
          boundary === "project" ? carryProject : null,
          auth,
        ],
      );
    }
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

    const revokedCandidate = structuredClone(pack);
    revokedCandidate.version = "0.1.8";
    revokedCandidate.sourceDigest = `sha256:${"e".repeat(64)}`;
    revokedCandidate.revision = `operant/crm@0.1.8:sha256:${"e".repeat(64)}`;
    const revokedPlan = await createPackMigrationPlan(
      sql,
      revokedCandidate,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, revokedPlan.plan.id, auth)
    );
    const firstRuntimeTable = (await query<{ table_name: string }>(
      sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' order by case definition_kind when 'resource' then 0 else 1 end,definition_name,table_name limit 1",
    )).rows[0].table_name;
    const lockHeld = Promise.withResolvers<void>();
    const unlock = Promise.withResolvers<void>();
    const runtimeBlocker = sql.begin(async (tx) => {
      await query(
        tx,
        `lock table "${firstRuntimeTable}" in row exclusive mode`,
      );
      lockHeld.resolve();
      await unlock.promise;
    });
    await lockHeld.promise;
    const applyStarted = Promise.withResolvers<number>();
    const revokedServices = makeMigrationTestServices({
      sql,
      tx: new PostgresTransactionManager(sql),
      authorization: allowAuthorization(),
      authorizeApplyInTransaction: (lockedSql, currentAuth) =>
        new PostgresAuthorizationRepository(lockedSql as Sql).authorize({
          auth: currentAuth,
          boundary: { type: "system" },
          action: "migration.apply",
          resource: "system:migration",
        }),
      beforeApplyAttempt: async (tx: Queryable) => {
        applyStarted.resolve(
          Number(
            (await query<{ pid: number }>(tx, "select pg_backend_pid() pid"))
              .rows[0].pid,
          ),
        );
      },
    });
    const revokedApply = revokedServices.apply(
      revokedPlan.plan.id,
      { acknowledgement: "safe" },
      authContext(auth, principal, human, session),
    );
    const applyingPid = await applyStarted.promise;
    await waitUntilBlocked(sql, applyingPid);
    await query(sql, "update role_assignments set active=false where id=$1", [
      assignmentId,
    ]);
    unlock.resolve();
    await runtimeBlocker;
    const revokedResult = await revokedApply;
    assertEquals(revokedResult.ok, false);
    if (!revokedResult.ok) {
      assertEquals(revokedResult.error.code, "authorization_changed");
    }
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_applications where plan_id=$1",
        [revokedPlan.plan.id],
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_attempts where plan_id=$1 and outcome='authorization_changed'",
        [revokedPlan.plan.id],
      )).rows[0].count,
      "1",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_audit_events where plan_id=$1 and decision='denied' and details->>'error_code'='authorization_changed'",
        [revokedPlan.plan.id],
      )).rows[0].count,
      "1",
    );
    assertEquals(
      (await query<{ id: string }>(
        sql,
        "select candidate_revision_id::text id from pack_active_revisions where publisher='operant' and pack_name='crm'",
      )).rows[0].id,
      first.plan.to_pack_revision_id,
    );
    await query(sql, "update role_assignments set active=true where id=$1", [
      assignmentId,
    ]);

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
      const faultServices = migrationServices(
        sql,
        async () => {},
        fault,
      );
      const faultResult = await faultServices.apply(
        next.plan.id,
        { acknowledgement: "safe" },
        authContext(auth, principal, human, session),
      );
      assertEquals(faultResult.ok, false);
      if (!faultResult.ok) {
        assertEquals(faultResult.error.code, "migration_apply_failed");
      }
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
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_migration_audit_events where plan_id=$1 and decision='denied' and details->>'error_code'='migration_apply_failed'",
          [next.plan.id],
        )).rows[0].count,
        "1",
      );
    }

    const carryCandidate = structuredClone(pack);
    carryCandidate.version = "0.1.8";
    carryCandidate.sourceDigest = `sha256:${"7".repeat(64)}`;
    carryCandidate.revision = `operant/crm@0.1.8:sha256:${"6".repeat(64)}`;
    const carryPolicy = carryCandidate.policies.sales_access.document as {
      spec: { default_assignment: "none" | "all_projects" };
    };
    carryPolicy.spec.default_assignment = "none";
    const normalizedCarryPolicy = (carryCandidate.normalized.policies as Record<
      string,
      { spec: { default_assignment: "none" | "all_projects" } }
    >).sales_access;
    normalizedCarryPolicy.spec.default_assignment = "none";
    const carryPlan = await createPackMigrationPlan(sql, carryCandidate, auth);
    await sql.begin((tx) => validateMigrationPlan(tx, carryPlan.plan.id, auth));
    await sql.begin((tx) =>
      applyMigrationPlan(
        tx,
        carryPlan.plan.id,
        {
          acknowledgement: carryPlan.plan.class === "safe"
            ? "safe"
            : carryPlan.plan.class === "risky"
            ? "reviewed"
            : "destructive",
        },
        auth,
      )
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        `select count(*)::text count
        from policy_assignments pa join policy_definition_versions pd
          on pd.id=pa.policy_definition_version_id
        where pd.candidate_revision_id=$1 and pa.active and pa.source='operator'`,
        [carryPlan.plan.to_pack_revision_id],
      )).rows[0].count,
      "3",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        `select count(*)::text count
        from policy_assignments pa join policy_definition_versions pd
          on pd.id=pa.policy_definition_version_id
        where pd.candidate_revision_id=$1 and pa.active and pa.source='pack_default'`,
        [carryPlan.plan.to_pack_revision_id],
      )).rows[0].count,
      "0",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from policy_assignments where id=any($1::uuid[]) and active",
        [carriedAssignmentIds],
      )).rows[0].count,
      "0",
    );

    const restoredCandidate = structuredClone(pack);
    restoredCandidate.version = "0.1.81";
    restoredCandidate.sourceDigest = `sha256:${"5".repeat(64)}`;
    restoredCandidate.revision = `operant/crm@0.1.81:sha256:${"4".repeat(64)}`;
    const restoredPlan = await createPackMigrationPlan(
      sql,
      restoredCandidate,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, restoredPlan.plan.id, auth)
    );
    await sql.begin((tx) =>
      applyMigrationPlan(
        tx,
        restoredPlan.plan.id,
        {
          acknowledgement: restoredPlan.plan.class === "safe"
            ? "safe"
            : "reviewed",
        },
        auth,
      )
    );

    const timeoutCandidate = structuredClone(restoredCandidate);
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

    for (const [index, state] of ["40P01", "40001"].entries()) {
      const retryCandidate = structuredClone(pack);
      retryCandidate.version = `0.1.${index + 20}`;
      retryCandidate.sourceDigest = `sha256:${String(index + 2).repeat(64)}`;
      retryCandidate.revision = `operant/crm@${retryCandidate.version}:sha256:${
        String(index + 4).repeat(64)
      }`;
      const retryPlan = await createPackMigrationPlan(
        sql,
        retryCandidate,
        auth,
      );
      await sql.begin((tx) =>
        validateMigrationPlan(tx, retryPlan.plan.id, auth)
      );
      const transactionIds: string[] = [];
      const services = migrationServices(sql, async (tx, attempt) => {
        transactionIds.push(
          (await query<{ id: string }>(tx, "select txid_current()::text id"))
            .rows[0].id,
        );
        if (attempt < 3) {
          throw Object.assign(new Error("injected transient SQLSTATE"), {
            code: state,
          });
        }
      });
      const result = await services.apply(retryPlan.plan.id, {
        acknowledgement: "safe",
      }, authContext(auth, principal, human, session));
      assertEquals(result.ok, true);
      assertEquals(new Set(transactionIds).size, 3);
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_migration_attempts where plan_id=$1 and outcome=$2",
          [retryPlan.plan.id, state],
        )).rows[0].count,
        "2",
      );
      assertEquals(
        (await query<{ count: string }>(
          sql,
          "select count(*)::text count from pack_migration_applications where plan_id=$1",
          [retryPlan.plan.id],
        )).rows[0].count,
        "1",
      );
    }

    const noRetryCandidate = structuredClone(pack);
    noRetryCandidate.version = "0.1.30";
    noRetryCandidate.sourceDigest = `sha256:${"6".repeat(64)}`;
    noRetryCandidate.revision = `operant/crm@0.1.30:sha256:${"7".repeat(64)}`;
    const noRetryPlan = await createPackMigrationPlan(
      sql,
      noRetryCandidate,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, noRetryPlan.plan.id, auth)
    );
    let attempts = 0;
    const busyServices = migrationServices(sql, () => {
      attempts++;
      return Promise.reject(
        Object.assign(new Error("injected timeout"), { code: "55P03" }),
      );
    });
    const busyResult = await busyServices.apply(noRetryPlan.plan.id, {
      acknowledgement: "safe",
    }, authContext(auth, principal, human, session));
    assertEquals(busyResult.ok, false);
    if (!busyResult.ok) {
      assertEquals(busyResult.error.code, "pack_install_busy");
    }
    assertEquals(attempts, 1);
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_attempts where plan_id=$1",
        [noRetryPlan.plan.id],
      )).rows[0].count,
      "1",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_applications where plan_id=$1",
        [noRetryPlan.plan.id],
      )).rows[0].count,
      "0",
    );
    let acknowledgementAttempts = 0;
    const acknowledgementServices = migrationServices(sql, () => {
      acknowledgementAttempts++;
      return Promise.resolve();
    });
    const acknowledgementResult = await acknowledgementServices.apply(
      noRetryPlan.plan.id,
      { acknowledgement: "reviewed" },
      authContext(auth, principal, human, session),
    );
    assertEquals(acknowledgementResult.ok, false);
    if (!acknowledgementResult.ok) {
      assertEquals(
        acknowledgementResult.error.code,
        "migration_acknowledgement_invalid",
      );
    }
    assertEquals(acknowledgementAttempts, 1);

    let deniedAttempts = 0;
    const deniedServices = makeMigrationTestServices({
      sql,
      tx: new PostgresTransactionManager(sql),
      authorization: denyAuthorization(),
      authorizeApplyInTransaction: () =>
        Promise.resolve({ ok: true as const, value: {} }),
      beforeApplyAttempt: () => {
        deniedAttempts++;
        return Promise.resolve();
      },
    });
    assertEquals(
      (await deniedServices.apply(
        noRetryPlan.plan.id,
        { acknowledgement: "safe" },
        authContext(auth, principal, human, session),
      )).ok,
      false,
    );
    assertEquals(deniedAttempts, 0);
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_audit_events where plan_id=$1 and decision='denied' and details->>'error_code'='policy_denied'",
        [noRetryPlan.plan.id],
      )).rows[0].count,
      "1",
    );

    const exhaustedCandidate = structuredClone(pack);
    exhaustedCandidate.version = "0.1.40";
    exhaustedCandidate.sourceDigest = `sha256:${"8".repeat(64)}`;
    exhaustedCandidate.revision = `operant/crm@0.1.40:sha256:${"8".repeat(64)}`;
    const exhaustedPlan = await createPackMigrationPlan(
      sql,
      exhaustedCandidate,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, exhaustedPlan.plan.id, auth)
    );
    let exhaustedAttempts = 0;
    const exhaustedServices = migrationServices(sql, () => {
      exhaustedAttempts++;
      return Promise.reject(
        Object.assign(new Error("injected exhausted deadlock"), {
          code: "40P01",
        }),
      );
    });
    const exhaustedResult = await exhaustedServices.apply(
      exhaustedPlan.plan.id,
      { acknowledgement: "safe" },
      authContext(auth, principal, human, session),
    );
    assertEquals(exhaustedResult.ok, false);
    if (!exhaustedResult.ok) {
      assertEquals(exhaustedResult.error.code, "migration_retry_exhausted");
    }
    assertEquals(exhaustedAttempts, 3);
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_attempts where plan_id=$1",
        [exhaustedPlan.plan.id],
      )).rows[0].count,
      "3",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_audit_events where plan_id=$1 and decision='denied'",
        [exhaustedPlan.plan.id],
      )).rows[0].count,
      "3",
    );
    assertEquals(
      (await query<{ count: string }>(
        sql,
        "select count(*)::text count from pack_migration_applications where plan_id=$1",
        [exhaustedPlan.plan.id],
      )).rows[0].count,
      "0",
    );

    const staleCandidate = structuredClone(pack);
    staleCandidate.version = "0.1.31";
    staleCandidate.sourceDigest = `sha256:${"0".repeat(64)}`;
    staleCandidate.revision = `operant/crm@0.1.31:sha256:${"1".repeat(64)}`;
    const stalePlan = await createPackMigrationPlan(sql, staleCandidate, auth);
    await sql.begin((tx) => validateMigrationPlan(tx, stalePlan.plan.id, auth));
    const advancement = structuredClone(pack);
    advancement.version = "0.1.32";
    advancement.sourceDigest = `sha256:${"4".repeat(64)}`;
    advancement.revision = `operant/crm@0.1.32:sha256:${"5".repeat(64)}`;
    const advancementPlan = await createPackMigrationPlan(
      sql,
      advancement,
      auth,
    );
    await sql.begin((tx) =>
      validateMigrationPlan(tx, advancementPlan.plan.id, auth)
    );
    await sql.begin((tx) =>
      applyMigrationPlan(tx, advancementPlan.plan.id, {
        acknowledgement: "safe",
      }, auth)
    );
    let staleAttempts = 0;
    const staleServices = migrationServices(sql, () => {
      staleAttempts++;
      return Promise.resolve();
    });
    const staleResult = await staleServices.apply(stalePlan.plan.id, {
      acknowledgement: "safe",
    }, authContext(auth, principal, human, session));
    assertEquals(staleResult.ok, false);
    if (!staleResult.ok) {
      assertEquals(staleResult.error.code, "migration_stale");
    }
    assertEquals(staleAttempts, 1);

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
    const normalizedResources = destructive.normalized.resources as Record<
      string,
      { spec: { fields: Record<string, unknown> } }
    >;
    delete normalizedResources.lead.spec.fields.phone;
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
    let tokenAttempts = 0;
    const tokenServices = migrationServices(sql, () => {
      tokenAttempts++;
      return Promise.resolve();
    });
    const wrongTokenResult = await tokenServices.apply(
      removal.plan.id,
      {
        acknowledgement: "destructive",
        confirmation_token: "wrong",
      },
      authContext(auth, principal, human, session),
    );
    assertEquals(wrongTokenResult.ok, false);
    if (!wrongTokenResult.ok) {
      assertEquals(
        wrongTokenResult.error.code,
        "migration_confirmation_invalid",
      );
    }
    assertEquals(tokenAttempts, 1);
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
    const normalizedActions = risky.normalized.actions as Record<
      string,
      { spec: Record<string, unknown> }
    >;
    normalizedActions[actionName].spec.description = "reviewed behavior change";
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
    const failedRecords = await query<{
      attempts: string;
      audits: string;
      redacted: boolean;
    }>(
      sql,
      `select
         (select count(*)::text from pack_migration_attempts) attempts,
         (select count(*)::text from pack_migration_audit_events where decision='denied') audits,
         not exists(
           select 1 from pack_migration_audit_events
            where decision='denied'
              and (details - 'error_code') <> '{}'::jsonb
         ) redacted`,
    );
    assertEquals(failedRecords.rows[0].audits, failedRecords.rows[0].attempts);
    assertEquals(failedRecords.rows[0].redacted, true);
  } finally {
    if (sql) await closePostgresClient(sql).catch(() => undefined);
    if (runtime) await runtime.stop().catch(() => undefined);
    if (previous === undefined) Deno.env.delete("OPERANT_DATA_DIR");
    else Deno.env.set("OPERANT_DATA_DIR", previous);
    await Deno.remove(root, { recursive: true }).catch(() => undefined);
  }
});

async function waitUntilBlocked(
  sql: ReturnType<typeof createPostgresClient>,
  pid: number,
) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const blocked = await query<{ blocked: boolean }>(
      sql,
      "select cardinality(pg_blocking_pids($1)) > 0 blocked",
      [pid],
    );
    if (blocked.rows[0]?.blocked) return;
  }
  throw new Error(
    `apply backend ${pid} did not reach the runtime lock barrier`,
  );
}

function authContext(
  id: string,
  principalId: string,
  humanUserId: string,
  sessionId: string,
) {
  return Object.freeze({
    id,
    principalId,
    principalType: "human_user" as const,
    humanUserId,
    sessionId,
    credentialKind: "human_full" as const,
    roles: Object.freeze(["system:super_admin"]),
    createdAt: new Date().toISOString(),
  });
}

function allowAuthorization(): AuthorizationRepository {
  return {
    authorize: () => Promise.resolve({ ok: true as const, value: {} }),
  } as unknown as AuthorizationRepository;
}

function denyAuthorization(): AuthorizationRepository {
  return {
    authorize: () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "policy_denied",
          message: "denied",
          severity: "authorization" as const,
        },
      }),
  } as unknown as AuthorizationRepository;
}

function migrationServices(
  sql: ReturnType<typeof createPostgresClient>,
  beforeApplyAttempt: (sql: Queryable, attempt: number) => Promise<void>,
  applyTestFault?: "after_sql" | "after_application",
) {
  return makeMigrationTestServices({
    sql,
    tx: new PostgresTransactionManager(sql),
    authorization: allowAuthorization(),
    authorizeApplyInTransaction: () =>
      Promise.resolve({ ok: true as const, value: {} }),
    beforeApplyAttempt,
    applyTestFault,
  });
}

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
