// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import {
  assertNoIdleClients,
  commitRepository,
  observeWaiters,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

type Gate = { pid: number; release(): void; done: Promise<unknown> };

Deno.test({
  name:
    "production commit acquires three reverse-authored runtime TABLE locks in exact canonical order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const clients = [
      matrix.client(),
      matrix.client(),
      matrix.client(),
      matrix.client(),
    ];
    const gates: Gate[] = [];
    try {
      const stage = await matrix.stage(
        ["gamma", "beta", "alpha"].map((name) => ({
          op: "create",
          project_id: matrix.projectId,
          resource: `test/commitmatrix:${name}`,
          fields: { key: `table-order-${name}`, status: "ready" },
        })),
      );
      const tables = await runtimeTables(matrix.harness.server.sql);
      for (let index = 0; index < 3; index++) {
        gates.push(await holdTable(clients[index], tables[index]));
      }
      const committing = commitRepository(clients[3]).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 30_000 },
      );
      for (let index = 0; index < gates.length; index++) {
        const waiter = await observeWaiters(
          matrix.harness.server.sql,
          "lock table",
          1,
          gates[index].pid,
        );
        assertEquals(waiter[0].blockers.includes(gates[index].pid), true);
        const locks =
          (await query<{ relation: string; mode: string; granted: boolean }>(
            matrix.harness.server.sql,
            `select relation::regclass::text relation,mode,granted from pg_locks
           where pid=$1 and relation=any($2::regclass[]) order by relation::regclass::text`,
            [waiter[0].pid, tables],
          )).rows;
        for (let acquired = 0; acquired < index; acquired++) {
          assertEquals(
            locks.some((lock) =>
              clean(lock.relation) === tables[acquired] &&
              lock.mode === "RowExclusiveLock" && lock.granted
            ),
            true,
          );
        }
        assertEquals(
          locks.some((lock) =>
            clean(lock.relation) === tables[index] &&
            lock.mode === "RowExclusiveLock" && !lock.granted
          ),
          true,
        );
        gates[index].release();
        await gates[index].done;
      }
      assertEquals((await committing).ok, true);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      gates.forEach((gate) => gate.release());
      await Promise.all(
        clients.map((client) => client.end().catch(() => undefined)),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit acquires strongest promoted ROW locks in sorted table and UUID order",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const clients = [
      matrix.client(),
      matrix.client(),
      matrix.client(),
      matrix.client(),
      matrix.client(),
    ];
    const gates: Gate[] = [];
    try {
      const base = await matrix.stage(
        ["gamma", "beta", "alpha", "alpha"].map((name, index) => ({
          op: "create",
          project_id: matrix.projectId,
          resource: `test/commitmatrix:${name}`,
          fields: { key: `row-order-${name}-${index}`, status: "ready" },
        })),
      );
      assertEquals((await matrix.commit(base.id)).ok, true);
      const objects = base.operations.map((operation) => ({
        id: String(operation.object_id),
        name: String(operation.resource).split(":").at(-1)!,
      }));
      const alpha = objects.filter((object) => object.name === "alpha").sort((
        a,
        b,
      ) => a.id.localeCompare(b.id));
      const beta = objects.find((object) => object.name === "beta")!;
      const gamma = objects.find((object) => object.name === "gamma")!;
      const ordered = [alpha[0], alpha[1], beta, gamma];
      const tables = await runtimeTableMap(matrix.harness.server.sql);
      const stage = await matrix.stage([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        object_id: gamma.id,
        set: { note: "reverse" },
      }, {
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        object_id: beta.id,
        set: { note: "reverse" },
      }, {
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: alpha[1].id,
        set: { note: "second" },
      }, {
        op: "comment",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: alpha[0].id,
        body: "read plus mutation",
      }, {
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: alpha[0].id,
        set: { note: "promoted update" },
      }]);
      for (let index = 0; index < ordered.length; index++) {
        gates.push(
          await holdRow(
            clients[index],
            tables[ordered[index].name],
            ordered[index].id,
            index === 0 ? "key share" : "update",
          ),
        );
      }
      const committing = commitRepository(clients[4]).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 30_000 },
      );
      for (let index = 0; index < ordered.length; index++) {
        const waiter = await observeWaiters(
          matrix.harness.server.sql,
          tables[ordered[index].name],
          1,
          gates[index].pid,
        );
        assertEquals(waiter[0].wait_event_type, "Lock");
        assertEquals(waiter[0].blockers, [gates[index].pid]);
        gates[index].release();
        await gates[index].done;
      }
      assertEquals((await committing).ok, true);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      gates.forEach((gate) => gate.release());
      await Promise.all(
        clients.map((client) => client.end().catch(() => undefined)),
      );
      await matrix.close();
    }
  },
});

async function holdTable(
  client: ReturnType<Awaited<ReturnType<typeof startCommitMatrix>>["client"]>,
  table: string,
): Promise<Gate> {
  let release!: () => void, held!: (pid: number) => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const pid = new Promise<number>((resolve) => held = resolve);
  const done = client.begin(async (tx) => {
    const backend = Number(
      (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
    );
    await tx.unsafe(`lock table ${quoteIdentifier(table)} in share mode`);
    held(backend);
    await released;
  });
  return { pid: await pid, release, done };
}

async function holdRow(
  client: ReturnType<Awaited<ReturnType<typeof startCommitMatrix>>["client"]>,
  table: string,
  id: string,
  mode: "update" | "key share",
): Promise<Gate> {
  let release!: () => void, held!: (pid: number) => void;
  const released = new Promise<void>((resolve) => release = resolve);
  const pid = new Promise<number>((resolve) => held = resolve);
  const done = client.begin(async (tx) => {
    const backend = Number(
      (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
    );
    await tx.unsafe(
      `select id from ${quoteIdentifier(table)} where id=$1 for ${mode}`,
      [id],
    );
    held(backend);
    await released;
  });
  return { pid: await pid, release, done };
}

async function runtimeTableMap(sql: Sql) {
  const rows = (await query<{ definition_name: string; table_name: string }>(
    sql,
    `select definition_name,table_name from pack_runtime_tables where publisher='test'
     and pack_name='commitmatrix' and definition_kind='resource'`,
  )).rows;
  return Object.fromEntries(
    rows.map((row) => [row.definition_name, row.table_name]),
  );
}
async function runtimeTables(sql: Sql) {
  const map = await runtimeTableMap(sql);
  return [map.alpha, map.beta, map.gamma];
}
function clean(name: string) {
  return name.replaceAll('"', "");
}
