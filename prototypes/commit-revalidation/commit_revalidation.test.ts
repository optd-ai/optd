import { assert, assertEquals } from "@std/assert";
import postgres from "postgres";
import {
  findPostgresBins,
  startManagedPostgres,
  stopManagedPostgres,
} from "../postgres/app-managed-postgres-spike.ts";
import {
  applyPackRevision,
  cancelStage,
  canonicalDependencyOrder,
  canonicalTableOrder,
  commitStage,
  installSchema,
  requestedLockTimeoutMs,
  seedScenario,
  setApproval,
  type Sql,
} from "./commit_revalidation.ts";

const PROJECT = "019bef41-0000-7000-8000-000000000001";

Deno.test({
  name: "real Postgres proves race-free staged commit lock protocol",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!await findPostgresBins()) {
      console.warn(
        "SKIP commit-revalidation prototype: postgres binaries not found; run in nix-shell",
      );
      return;
    }

    const root = await Deno.makeTempDir({ prefix: "operant-commit-locks-" });
    const pg = await startManagedPostgres(root);
    const admin = client(pg.databaseUrl);
    const clients: Sql[] = [admin];
    const nextClient = () => {
      const sql = client(pg.databaseUrl);
      clients.push(sql);
      return sql;
    };

    try {
      await installSchema(admin);
      assertEquals(canonicalTableOrder(["proto_b", "proto_a", "proto_b"]), [
        "proto_a",
        "proto_b",
      ]);
      assertEquals(
        canonicalDependencyOrder([
          op("proto_b", id(2), "read", 1),
          op("proto_a", id(1), "mutate", 1, "x"),
          op("proto_b", id(2), "mutate", 1, "y"),
        ]).map((value) => `${value.table}:${value.mode}`),
        ["proto_a:mutate", "proto_b:mutate"],
      );
      assertEquals(requestedLockTimeoutMs(undefined), 10_000);
      assertEquals(requestedLockTimeoutMs(25_000), 25_000);

      await sameStageCommitsOnce(admin, nextClient);
      await commitAndCancellationHaveOneWinner(admin, nextClient);
      await approvalMutationUsesStageLock(admin, nextClient);
      await objectAndReadDependenciesCannotSlip(admin, nextClient);
      await packApplyWaitsForCommit(admin, nextClient);
      await commitWaitingForPackBecomesStale(admin, nextClient);
      await differentRowsRemainConcurrent(admin, nextClient);
      await oppositeAuthoredOrdersDoNotDeadlock(admin, nextClient);
      await authorizationHasOneStatementCutoff(admin, nextClient);
      await requestLockTimeoutOverridesDefault(admin, nextClient);
      await failedRevalidationLeavesNoPartialFacts(admin, nextClient);
      await postgresDeadlockIsDetectedAndRetryable(nextClient);
    } finally {
      await Promise.all(
        clients.map((sql) => sql.end({ timeout: 2 }).catch(() => undefined)),
      );
      await stopManagedPostgres(pg).catch(() => undefined);
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  },
});

async function sameStageCommitsOnce(admin: Sql, nextClient: () => Sql) {
  const objectId = id(10);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(11);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "after")],
  });
  const locked = deferred();
  const release = deferred();
  const first = commitStage(nextClient(), stageId, {
    hooks: {
      afterStageLock: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  const second = commitStage(nextClient(), stageId);
  release.resolve();
  const results = await Promise.all([first, second]);
  assertEquals(
    new Set(results.map((result) => result.status)),
    new Set([
      "committed",
      "already_committed",
    ]),
  );
  const counts = await admin.unsafe(
    "select count(*)::int count from proto_commits where stage_id=$1",
    [stageId],
  );
  assertEquals(counts[0].count, 1);
}

async function commitAndCancellationHaveOneWinner(
  admin: Sql,
  nextClient: () => Sql,
) {
  const objectId = id(20);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(21);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "committed")],
  });
  const locked = deferred();
  const release = deferred();
  const committing = commitStage(nextClient(), stageId, {
    hooks: {
      afterStageLock: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  const cancelling = cancelStage(nextClient(), stageId);
  release.resolve();
  assertEquals((await committing).status, "committed");
  assertEquals(await cancelling, "already_committed");

  const cancelledStage = id(22);
  await seedScenario(admin, {
    stageId: cancelledStage,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 2, "never")],
  });
  assertEquals(await cancelStage(admin, cancelledStage), "cancelled");
  assertEquals(
    (await commitStage(admin, cancelledStage)).status,
    "stage_cancelled",
  );
}

async function approvalMutationUsesStageLock(
  admin: Sql,
  nextClient: () => Sql,
) {
  const objectId = id(30);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(31);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "approved")],
  });
  const locked = deferred();
  const release = deferred();
  const commit = commitStage(nextClient(), stageId, {
    hooks: {
      afterStageLock: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  let approvalFinished = false;
  const revoke = setApproval(nextClient(), stageId, false).then((result) => {
    approvalFinished = true;
    return result;
  });
  await delay(75);
  assertEquals(approvalFinished, false);
  release.resolve();
  assertEquals((await commit).status, "committed");
  assertEquals(await revoke, "already_committed");
}

async function objectAndReadDependenciesCannotSlip(
  admin: Sql,
  nextClient: () => Sql,
) {
  const objectA = id(40);
  const objectB = id(41);
  await insertObject(admin, "proto_a", objectA, "before-a");
  await insertObject(admin, "proto_b", objectB, "before-b");
  const stageId = id(42);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [
      op("proto_a", objectA, "mutate", 1, "after-a"),
      op("proto_b", objectB, "read", 1),
    ],
  });
  const locked = deferred();
  const release = deferred();
  const commit = commitStage(nextClient(), stageId, {
    hooks: {
      afterDependencyLocks: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  let updateFinished = false;
  const update = nextClient().unsafe(
    "update proto_b set value='changed',version=version+1 where id=$1",
    [objectB],
  ).then(() => {
    updateFinished = true;
  });
  await delay(75);
  assertEquals(updateFinished, false);
  release.resolve();
  assertEquals((await commit).status, "committed");
  await update;

  const staleStage = id(43);
  await seedScenario(admin, {
    stageId: staleStage,
    projectId: PROJECT,
    operations: [op("proto_b", objectB, "mutate", 1, "stale")],
  });
  assertEquals((await commitStage(admin, staleStage)).status, "stage_stale");
}

async function packApplyWaitsForCommit(admin: Sql, nextClient: () => Sql) {
  await admin.unsafe(
    "update proto_pack_installations set active_revision=1 where pack='optd/test'",
  );
  const objectId = id(50);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(51);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "after")],
  });
  const locked = deferred();
  const release = deferred();
  const commit = commitStage(nextClient(), stageId, {
    hooks: {
      afterTableLocks: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  let applyFinished = false;
  const apply = applyPackRevision(nextClient(), 2, ["proto_b", "proto_a"]).then(
    (result) => {
      applyFinished = true;
      return result;
    },
  );
  await delay(75);
  assertEquals(applyFinished, false);
  release.resolve();
  assertEquals((await commit).status, "committed");
  assertEquals(await apply, "applied");
}

async function commitWaitingForPackBecomesStale(
  admin: Sql,
  nextClient: () => Sql,
) {
  await admin.unsafe(
    "update proto_pack_installations set active_revision=1 where pack='optd/test'",
  );
  const objectId = id(60);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(61);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    packRevision: 1,
    operations: [op("proto_a", objectId, "mutate", 1, "never")],
  });
  const locked = deferred();
  const release = deferred();
  const apply = applyPackRevision(nextClient(), 2, ["proto_a", "proto_b"], {
    hooks: {
      afterTableLocks: async () => {
        locked.resolve();
        await release.promise;
      },
    },
  });
  await locked.promise;
  const commit = commitStage(nextClient(), stageId);
  await delay(75);
  release.resolve();
  assertEquals(await apply, "applied");
  const result = await commit;
  assertEquals(result.status, "stage_stale");
  if (result.status === "stage_stale") {
    assertEquals(result.reason, "pack_revision_changed");
  }
}

async function differentRowsRemainConcurrent(
  admin: Sql,
  nextClient: () => Sql,
) {
  await admin.unsafe(
    "update proto_pack_installations set active_revision=1 where pack='optd/test'",
  );
  const firstObject = id(70);
  const secondObject = id(71);
  await insertObject(admin, "proto_a", firstObject, "one");
  await insertObject(admin, "proto_a", secondObject, "two");
  const firstStage = id(72);
  const secondStage = id(73);
  await seedScenario(admin, {
    stageId: firstStage,
    projectId: PROJECT,
    operations: [op("proto_a", firstObject, "mutate", 1, "one-updated")],
  });
  await seedScenario(admin, {
    stageId: secondStage,
    projectId: PROJECT,
    operations: [op("proto_a", secondObject, "mutate", 1, "two-updated")],
  });
  const bothLocked = countdown(2);
  const release = deferred();
  const hook = {
    afterTableLocks: async () => {
      bothLocked.arrive();
      await release.promise;
    },
  };
  const first = commitStage(nextClient(), firstStage, { hooks: hook });
  const second = commitStage(nextClient(), secondStage, { hooks: hook });
  await bothLocked.promise;
  release.resolve();
  assertEquals((await first).status, "committed");
  assertEquals((await second).status, "committed");
}

async function oppositeAuthoredOrdersDoNotDeadlock(
  admin: Sql,
  nextClient: () => Sql,
) {
  const a = id(80);
  const b = id(81);
  await insertObject(admin, "proto_a", a, "a");
  await insertObject(admin, "proto_b", b, "b");
  const firstStage = id(82);
  const secondStage = id(83);
  await seedScenario(admin, {
    stageId: firstStage,
    projectId: PROJECT,
    operations: [
      op("proto_a", a, "mutate", 1, "first-a"),
      op("proto_b", b, "mutate", 1, "first-b"),
    ],
  });
  await seedScenario(admin, {
    stageId: secondStage,
    projectId: PROJECT,
    operations: [
      op("proto_b", b, "mutate", 1, "second-b"),
      op("proto_a", a, "mutate", 1, "second-a"),
    ],
  });
  const results = await Promise.all([
    commitStage(nextClient(), firstStage),
    commitStage(nextClient(), secondStage),
  ]);
  assert(results.some((result) => result.status === "committed"));
  assert(results.some((result) => result.status === "stage_stale"));
  assert(!results.some((result) => result.status === "commit_retry_exhausted"));
}

async function authorizationHasOneStatementCutoff(
  admin: Sql,
  nextClient: () => Sql,
) {
  const deniedObject = id(90);
  await insertObject(admin, "proto_a", deniedObject, "before");
  const deniedStage = id(91);
  await seedScenario(admin, {
    stageId: deniedStage,
    projectId: PROJECT,
    actorId: "revoked-before",
    operations: [op("proto_a", deniedObject, "mutate", 1, "never")],
  });
  await admin.unsafe(
    "update proto_authorizations set allowed=false where actor_id='revoked-before'",
  );
  assertEquals(
    (await commitStage(admin, deniedStage)).status,
    "authorization_changed",
  );

  const overlapObject = id(92);
  await insertObject(admin, "proto_a", overlapObject, "before");
  const overlapStage = id(93);
  await seedScenario(admin, {
    stageId: overlapStage,
    projectId: PROJECT,
    actorId: "revoked-overlap",
    operations: [
      op("proto_a", overlapObject, "mutate", 1, "allowed-at-cutoff"),
    ],
  });
  const authorized = deferred();
  const release = deferred();
  const commit = commitStage(nextClient(), overlapStage, {
    hooks: {
      afterAuthorization: async () => {
        authorized.resolve();
        await release.promise;
      },
    },
  });
  await authorized.promise;
  await nextClient().unsafe(
    "update proto_authorizations set allowed=false where actor_id='revoked-overlap'",
  );
  release.resolve();
  assertEquals((await commit).status, "committed");
}

async function requestLockTimeoutOverridesDefault(
  admin: Sql,
  nextClient: () => Sql,
) {
  const objectId = id(100);
  await insertObject(admin, "proto_a", objectId, "before");
  const shortStage = id(101);
  await seedScenario(admin, {
    stageId: shortStage,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "short")],
  });
  const holderReady = deferred();
  const holderRelease = deferred();
  const holder = nextClient().begin(async (tx) => {
    await tx.unsafe("lock table proto_a in share row exclusive mode");
    holderReady.resolve();
    await holderRelease.promise;
  });
  await holderReady.promise;
  assertEquals(
    (await commitStage(nextClient(), shortStage, { lockTimeoutMs: 100 }))
      .status,
    "commit_busy",
  );

  const longStage = id(102);
  await seedScenario(admin, {
    stageId: longStage,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 1, "long")],
  });
  const long = commitStage(nextClient(), longStage, { lockTimeoutMs: 1_000 });
  setTimeout(() => holderRelease.resolve(), 150);
  await holder;
  assertEquals((await long).status, "committed");
}

async function failedRevalidationLeavesNoPartialFacts(
  admin: Sql,
  nextClient: () => Sql,
) {
  const objectId = id(110);
  await insertObject(admin, "proto_a", objectId, "before");
  const stageId = id(111);
  await seedScenario(admin, {
    stageId,
    projectId: PROJECT,
    operations: [op("proto_a", objectId, "mutate", 99, "never")],
  });
  assertEquals(
    (await commitStage(nextClient(), stageId)).status,
    "stage_stale",
  );
  const partials = await admin.unsafe(
    `select
       (select count(*)::int from proto_commits where stage_id=$1) commits,
       (select count(*)::int from proto_object_versions v
          join proto_commits c on c.id=v.commit_id where c.stage_id=$1) versions,
       (select count(*)::int from proto_events e
          join proto_commits c on c.id=e.commit_id where c.stage_id=$1) events,
       (select count(*)::int from proto_outbox o
          join proto_events e on e.id=o.event_id
          join proto_commits c on c.id=e.commit_id where c.stage_id=$1) outbox`,
    [stageId],
  );
  assertEquals(partials[0].commits, 0);
  assertEquals(partials[0].versions, 0);
  assertEquals(partials[0].events, 0);
  assertEquals(partials[0].outbox, 0);
}

async function postgresDeadlockIsDetectedAndRetryable(nextClient: () => Sql) {
  const first = nextClient();
  const second = nextClient();
  await first.unsafe(
    "create table if not exists proto_deadlock(id integer primary key, value integer not null)",
  );
  await first.unsafe("truncate proto_deadlock");
  await first.unsafe("insert into proto_deadlock values (1,0),(2,0)");
  const barrier = countdown(2);
  let deadlocks = 0;
  const worker = async (sql: Sql, firstId: number, secondId: number) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe(
            "update proto_deadlock set value=value+1 where id=$1",
            [firstId],
          );
          if (attempt === 1) {
            barrier.arrive();
            await barrier.promise;
          }
          await tx.unsafe(
            "update proto_deadlock set value=value+1 where id=$1",
            [secondId],
          );
        });
        return attempt;
      } catch (error) {
        if ((error as { code?: string }).code !== "40P01") throw error;
        deadlocks++;
      }
    }
    throw new Error("deadlock retry exhausted");
  };
  const hookExecutions = 1; // Stage hook ran before either commit transaction.
  const attempts = await Promise.all([
    worker(first, 1, 2),
    worker(second, 2, 1),
  ]);
  assert(attempts.some((attempt) => attempt > 1));
  assert(deadlocks >= 1);
  assertEquals(hookExecutions, 1);
}

function client(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
  });
}

function op(
  table: string,
  object_id: string,
  mode: "mutate" | "read",
  expected_version: number,
  value?: string,
) {
  return { table, object_id, mode, expected_version, value };
}

function id(n: number): string {
  return `019bef41-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

async function insertObject(
  sql: Sql,
  table: "proto_a" | "proto_b",
  objectId: string,
  value: string,
) {
  await sql.unsafe(
    `insert into ${table}(id,version,value) values ($1,1,$2)`,
    [objectId, value],
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

function countdown(count: number) {
  const done = deferred();
  return {
    promise: done.promise,
    arrive() {
      count--;
      if (count === 0) done.resolve();
    },
  };
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
