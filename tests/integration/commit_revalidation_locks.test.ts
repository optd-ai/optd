// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  applyMigrationPlan,
  createPackMigrationPlan,
  validateMigrationPlan,
} from "../../src/adapters/outbound/postgres/pack_migration_repository.ts";
import {
  loadPackFromFiles,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import {
  query,
  quoteIdentifier,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  assertNoIdleClients,
  commitRepository,
  observeWaiters,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production commit exposes canonical early table locks and permits a different-row writer",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const blocker = matrix.client(),
      commitClient = matrix.client(),
      otherClient = matrix.client();
    let release: (() => void) | undefined;
    try {
      const base = await matrix.stage([{
        op: "create",
        key: "alpha_one",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "lock-alpha-one", status: "ready" },
      }, {
        op: "create",
        key: "alpha_two",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "lock-alpha-two", status: "ready" },
      }, {
        op: "create",
        key: "beta",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        fields: { key: "lock-beta", status: "ready" },
      }]);
      assertEquals((await matrix.commit(base.id)).ok, true);
      const alphaOne = String(base.operations[0].object_id);
      const alphaTwo = String(base.operations[1].object_id);
      const beta = String(base.operations[2].object_id);
      const stageA = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        object_id: beta,
        set: { note: "reverse-beta" },
      }, {
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: alphaOne,
        set: { note: "reverse-alpha" },
      }]);
      const tables = (await query<{
        definition_kind: string;
        definition_name: string;
        table_name: string;
      }>(
        matrix.harness.server.sql,
        `select definition_kind,definition_name,table_name
        from pack_runtime_tables where publisher='test' and pack_name='commitmatrix'
        order by publisher,pack_name,case definition_kind when 'resource' then 0 else 1 end,definition_name,table_name`,
      )).rows;
      const alphaTable = tables.find((row) =>
        row.definition_name === "alpha"
      )!.table_name;
      let held!: (pid: number) => void;
      const releasePromise = new Promise<void>((resolve) => release = resolve);
      const heldPromise = new Promise<number>((resolve) => held = resolve);
      const rowBlocker = blocker.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          `select id from ${
            quoteIdentifier(alphaTable)
          } where id=$1 for update`,
          [alphaOne],
        );
        held(pid);
        await releasePromise;
      });
      const blockerPid = await heldPromise;
      const commitA = commitRepository(commitClient).commit(
        stageA.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      const waiter = await observeWaiters(
        matrix.harness.server.sql,
        alphaTable,
        1,
        blockerPid,
      );
      assertEquals(waiter[0].wait_event_type, "Lock");
      const heldLocks =
        (await query<{ relation_name: string; mode: string; granted: boolean }>(
          matrix.harness.server.sql,
          `select relation::regclass::text relation_name,mode,granted from pg_locks
         where pid=$1 and relation is not null order by relation::regclass::text,mode`,
          [waiter[0].pid],
        )).rows;
      for (
        const table of tables.filter((row) =>
          row.definition_kind === "resource" &&
          ["alpha", "beta"].includes(row.definition_name)
        )
      ) {
        assertEquals(
          heldLocks.some((lock) =>
            lock.relation_name.replaceAll('"', "") === table.table_name &&
            lock.mode === "RowExclusiveLock" && lock.granted
          ),
          true,
        );
      }
      assertEquals(
        heldLocks.some((lock) =>
          lock.relation_name === "projects" && lock.mode === "RowShareLock" &&
          lock.granted
        ),
        true,
      );

      const stageB = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: alphaTwo,
        set: { note: "independent" },
      }]);
      const commitB = await commitRepository(otherClient).commit(
        stageB.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(commitB.ok, true);
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [stageA.id],
        )).rows[0].count,
        "0",
      );
      release?.();
      release = undefined;
      await rowBlocker;
      assertEquals((await commitA).ok, true);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      release?.();
      await Promise.all(
        [blocker.end(), commitClient.end(), otherClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit and production pack apply serialize in both observed table-lock orders",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const rowClient = matrix.client(),
      commitClient = matrix.client(),
      applyClient = matrix.client();
    let releaseRow: (() => void) | undefined,
      releasePack: (() => void) | undefined;
    try {
      const base = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "pack-race", status: "ready" },
      }]);
      assertEquals((await matrix.commit(base.id)).ok, true);
      const objectId = String(base.operations[0].object_id);
      const table = (await query<{ table_name: string }>(
        matrix.harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test' and pack_name='commitmatrix'
         and definition_kind='resource' and definition_name='alpha'`,
      )).rows[0].table_name;

      const firstPlan = await nextPackPlan(matrix, "pack_field_one");
      const commitFirstStage = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: objectId,
        set: { note: "commit first" },
      }]);
      let rowHeld!: (pid: number) => void;
      const rowHeldPromise = new Promise<number>((resolve) =>
        rowHeld = resolve
      );
      const rowReleasePromise = new Promise<void>((resolve) =>
        releaseRow = resolve
      );
      const rowBlocker = rowClient.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          `select id from ${quoteIdentifier(table)} where id=$1 for update`,
          [objectId],
        );
        rowHeld(pid);
        await rowReleasePromise;
      });
      const rowPid = await rowHeldPromise;
      const committing = commitRepository(commitClient).commit(
        commitFirstStage.id,
        matrix.auth,
        { lockTimeoutMs: 30_000 },
      );
      const commitWaiter = await observeWaiters(
        matrix.harness.server.sql,
        table,
        1,
        rowPid,
      );
      let applyStarted!: (pid: number) => void;
      const applyStartedPromise = new Promise<number>((resolve) =>
        applyStarted = resolve
      );
      const applying = applyClient.begin(async (tx) => {
        applyStarted(
          Number((await tx.unsafe("select pg_backend_pid() pid"))[0].pid),
        );
        return await applyMigrationPlan(
          tx as never,
          firstPlan,
          { acknowledgement: "safe" },
          matrix.auth.id,
        );
      });
      const applyPid = await applyStartedPromise;
      const packBlockers = await observeBlockedPid(
        matrix.harness.server.sql,
        applyPid,
      );
      assertEquals(packBlockers.includes(commitWaiter[0].pid), true);
      assertEquals(commitWaiter[0].blockers, [rowPid]);
      releaseRow?.();
      releaseRow = undefined;
      await rowBlocker;
      const committedFirst = await committing;
      assertEquals(committedFirst.ok, true, JSON.stringify(committedFirst));
      await applying;

      const secondPlan = await nextPackPlan(matrix, "pack_field_two");
      const packFirstStage = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: objectId,
        set: { note: "pack first" },
      }]);
      const runtimeTables = (await query<{ table_name: string }>(
        matrix.harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test' and pack_name='commitmatrix'
         order by publisher,pack_name,case definition_kind when 'resource' then 0 else 1 end,definition_name,table_name`,
      )).rows.map((row) => row.table_name);
      const laterTable = runtimeTables.at(-1)!;
      let laterHeld!: (pid: number) => void;
      const laterHeldPromise = new Promise<number>((resolve) =>
        laterHeld = resolve
      );
      const packReleasePromise = new Promise<void>((resolve) =>
        releasePack = resolve
      );
      const laterBlocker = rowClient.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          `lock table ${quoteIdentifier(laterTable)} in access exclusive mode`,
        );
        laterHeld(pid);
        await packReleasePromise;
      });
      const laterPid = await laterHeldPromise;
      let productionApplyStarted!: (pid: number) => void;
      const productionApplyPid = new Promise<number>((resolve) =>
        productionApplyStarted = resolve
      );
      const packTransaction = applyClient.begin(async (tx) => {
        productionApplyStarted(
          Number((await tx.unsafe("select pg_backend_pid() pid"))[0].pid),
        );
        return await applyMigrationPlan(tx as never, secondPlan, {
          acknowledgement: "safe",
        }, matrix.auth.id);
      });
      const packPid = await productionApplyPid;
      await observeWaiters(
        matrix.harness.server.sql,
        "lock table",
        1,
        laterPid,
      );
      const applyLocks =
        (await query<{ relation: string; mode: string; granted: boolean }>(
          matrix.harness.server.sql,
          `select relation::regclass::text relation,mode,granted from pg_locks
         where pid=$1 and relation=any($2::regclass[])`,
          [packPid, runtimeTables],
        )).rows;
      assertEquals(
        applyLocks.filter((lock) =>
          lock.mode === "ShareRowExclusiveLock" && lock.granted
        ).length >= 2,
        true,
      );
      const commitPid = Number(
        (await commitClient.unsafe("select pg_backend_pid() pid"))[0].pid,
      );
      const packBlockedCommit = commitRepository(commitClient).commit(
        packFirstStage.id,
        matrix.auth,
        { lockTimeoutMs: 30_000 },
      );
      assertEquals(
        (await observeBlockedPid(matrix.harness.server.sql, commitPid))
          .includes(packPid),
        true,
      );
      releasePack?.();
      releasePack = undefined;
      await laterBlocker;
      await packTransaction;
      const stale = await packBlockedCommit;
      assertEquals(stale.ok, false);
      if (!stale.ok) {
        assertEquals(stale.error.code, "stage_stale");
        assertEquals(
          (stale.error.details as Record<string, unknown>).reason,
          "pack_revision_changed",
        );
      }
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [packFirstStage.id],
        )).rows[0].count,
        "0",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      releaseRow?.();
      releasePack?.();
      await Promise.all(
        [rowClient.end(), commitClient.end(), applyClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit rereads runtime metadata after an observed table-lock wait and returns pack_revision_changed",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const blocker = matrix.client(), commitClient = matrix.client();
    let originalTable = "", renamedTable = "";
    try {
      const stage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "metadata-race", status: "ready" },
      }]);
      originalTable = (await query<{ table_name: string }>(
        matrix.harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test' and pack_name='commitmatrix'
         and definition_kind='resource' and definition_name='alpha'`,
      )).rows[0].table_name;
      renamedTable = `${originalTable}_moved`;
      let mutate!: () => void, held!: (pid: number) => void;
      const mutatePromise = new Promise<void>((resolve) => mutate = resolve);
      const heldPromise = new Promise<number>((resolve) => held = resolve);
      const ddl = blocker.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          `lock table ${
            quoteIdentifier(originalTable)
          } in access exclusive mode`,
        );
        held(pid);
        await mutatePromise;
        await tx.unsafe(
          `alter table ${quoteIdentifier(originalTable)} rename to ${
            quoteIdentifier(renamedTable)
          }`,
        );
        await tx.unsafe(
          "update pack_runtime_tables set table_name=$1 where table_name=$2",
          [renamedTable, originalTable],
        );
      });
      const blockerPid = await heldPromise;
      const committing = commitRepository(commitClient).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      const waiters = await observeWaiters(
        matrix.harness.server.sql,
        "lock table",
        1,
        blockerPid,
      );
      assertEquals(waiters[0].wait_event_type, "Lock");
      mutate();
      await ddl;
      const result = await committing;
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.code, "stage_stale");
        assertEquals(
          (result.error.details as Record<string, unknown>).reason,
          "pack_revision_changed",
        );
      }
      assertEquals(
        (await query<{ ok: number }>(matrix.harness.server.sql, "select 1 ok"))
          .rows[0].ok,
        1,
      );
      await query(
        matrix.harness.server.sql,
        `alter table ${quoteIdentifier(renamedTable)} rename to ${
          quoteIdentifier(originalTable)
        }`,
      );
      await query(
        matrix.harness.server.sql,
        "update pack_runtime_tables set table_name=$1 where table_name=$2",
        [originalTable, renamedTable],
      );
      renamedTable = "";
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      if (renamedTable) {
        await query(
          matrix.harness.server.sql,
          `alter table if exists ${quoteIdentifier(renamedTable)} rename to ${
            quoteIdentifier(originalTable)
          }`,
        ).catch(() => undefined);
        await query(
          matrix.harness.server.sql,
          "update pack_runtime_tables set table_name=$1 where table_name=$2",
          [originalTable, renamedTable],
        ).catch(() => undefined);
      }
      await Promise.all(
        [blocker.end(), commitClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

async function nextPackPlan(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  field: string,
) {
  const alphaPath = `${matrix.pack}/resources/alpha.yaml`;
  const alpha = await Deno.readTextFile(alphaPath);
  await Deno.writeTextFile(
    alphaPath,
    alpha.replace(
      "  constraints:",
      `    ${field}: { type: string }\n  constraints:`,
    ),
  );
  const loaded = await loadPackFromFiles(await packFiles(matrix.pack));
  const created = await createPackMigrationPlan(
    matrix.harness.server.sql,
    loaded,
    matrix.auth.id,
  );
  await matrix.harness.server.sql.begin((tx) =>
    validateMigrationPlan(tx, created.plan.id, matrix.auth.id)
  );
  return created.plan.id;
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

async function observeBlockedPid(
  sql: import("../../src/adapters/outbound/postgres/client.ts").Sql,
  pid: number,
) {
  let last: number[] = [];
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const row =
      (await query<{ wait_event_type: string | null; blockers: number[] }>(
        sql,
        `select wait_event_type,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1`,
        [pid],
      )).rows[0];
    last = row?.blockers ?? [];
    if (row?.wait_event_type === "Lock" && last.length > 0) return last;
    await Promise.resolve();
  }
  throw new Error(
    `backend ${pid} was not observably blocked: ${JSON.stringify(last)}`,
  );
}

Deno.test({
  name:
    "production apply barrier for an unrelated pack never blocks commit runtime tables",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const holder = matrix.client(),
      applyClient = matrix.client(),
      commitClient = matrix.client();
    const pack = await Deno.makeTempDir({ prefix: "commit-unrelated-pack-" });
    let release: (() => void) | undefined;
    try {
      await writeUnrelatedPack(pack, "1.0.0", false);
      const initial = await matrix.harness.runOptctl([
        "--json",
        "pack",
        "apply",
        pack,
        "--safe",
      ]);
      assertEquals(initial.code, 0, initial.stderr);
      const stage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "unrelated-pack-commit", status: "ready" },
      }]);
      await writeUnrelatedPack(pack, "1.0.1", true);
      const loaded = await loadPackFromFiles(await packFiles(pack));
      const plan = await createPackMigrationPlan(
        matrix.harness.server.sql,
        loaded,
        matrix.auth.id,
      );
      await matrix.harness.server.sql.begin((tx) =>
        validateMigrationPlan(tx, plan.plan.id, matrix.auth.id)
      );
      const tables = (await query<{ table_name: string }>(
        matrix.harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='other' and pack_name='independent'
         order by definition_name`,
      )).rows.map((row) => row.table_name);
      let held!: (pid: number) => void;
      const heldPromise = new Promise<number>((resolve) => held = resolve);
      const releasePromise = new Promise<void>((resolve) => release = resolve);
      const blocking = holder.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          `lock table ${quoteIdentifier(tables[1])} in access exclusive mode`,
        );
        held(pid);
        await releasePromise;
      });
      const holderPid = await heldPromise;
      let started!: (pid: number) => void;
      const startedPromise = new Promise<number>((resolve) =>
        started = resolve
      );
      const applying = applyClient.begin(async (tx) => {
        started(
          Number((await tx.unsafe("select pg_backend_pid() pid"))[0].pid),
        );
        return await applyMigrationPlan(tx as never, plan.plan.id, {
          acknowledgement: "safe",
        }, matrix.auth.id);
      });
      const applyPid = await startedPromise;
      await observeWaiters(
        matrix.harness.server.sql,
        "lock table",
        1,
        holderPid,
      );
      const locks = (await query<{ mode: string; granted: boolean }>(
        matrix.harness.server.sql,
        "select mode,granted from pg_locks where pid=$1 and relation=$2::regclass",
        [applyPid, tables[0]],
      )).rows;
      assertEquals(
        locks.some((lock) =>
          lock.mode === "ShareRowExclusiveLock" && lock.granted
        ),
        true,
      );
      const commitPid = Number(
        (await commitClient.unsafe("select pg_backend_pid() pid"))[0].pid,
      );
      const committed = await commitRepository(commitClient).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(committed.ok, true);
      assertEquals(
        (await query<{ blockers: number[] }>(
          matrix.harness.server.sql,
          "select pg_blocking_pids($1) blockers",
          [commitPid],
        )).rows[0].blockers,
        [],
      );
      release?.();
      release = undefined;
      await blocking;
      await applying;
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      release?.();
      await Promise.all(
        [holder.end(), applyClient.end(), commitClient.end()].map((client) =>
          client.catch(() => undefined)
        ),
      );
      await matrix.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    }
  },
});

async function writeUnrelatedPack(
  root: string,
  version: string,
  changed: boolean,
) {
  await Deno.mkdir(`${root}/resources`, { recursive: true });
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: other, name: independent, version: ${version} }\nspec: { purpose: Unrelated lock proof., axi: {} }\n`,
  );
  for (const name of ["one", "two"]) {
    await Deno.writeTextFile(
      `${root}/resources/${name}.yaml`,
      `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: ${name} }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n${
        changed && name === "one" ? "    note: { type: string }\n" : ""
      }  axi: {}\n`,
    );
  }
}
