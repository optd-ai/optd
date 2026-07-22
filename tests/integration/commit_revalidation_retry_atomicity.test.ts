// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
} from "../../src/adapters/outbound/postgres/client.ts";
import { makeCommitChangesetService } from "../../src/application/services/commit/commit_changeset.ts";
import {
  assertNoIdleClients,
  commitRepository,
  observeWaiters,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production commit timeout is single-attempt busy and a long observed waiter succeeds",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const blocker = matrix.client(),
      shortClient = matrix.client(),
      longClient = matrix.client();
    try {
      const stage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "timeout", status: "ready" },
      }]);
      let release!: () => void, held!: (pid: number) => void;
      const releasePromise = new Promise<void>((resolve) => release = resolve);
      const heldPromise = new Promise<number>((resolve) => held = resolve);
      const lock = blocker.begin(async (tx) => {
        const pid = Number(
          (await tx.unsafe("select pg_backend_pid() pid"))[0].pid,
        );
        await tx.unsafe(
          "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
          [stage.id],
        );
        held(pid);
        await releasePromise;
      });
      const blockerPid = await heldPromise;
      const busy = await commitRepository(shortClient).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 5 },
      );
      assertEquals(busy.ok, false);
      if (!busy.ok) assertEquals(busy.error.code, "commit_busy");
      const priorDefault = Deno.env.get("OPERANT_COMMIT_LOCK_TIMEOUT");
      Deno.env.set("OPERANT_COMMIT_LOCK_TIMEOUT", "5ms");
      try {
        const configured = await makeCommitChangesetService(
          commitRepository(shortClient),
        ).commit(stage.id, {}, matrix.auth);
        assertEquals(configured.ok, false);
        if (!configured.ok) assertEquals(configured.error.code, "commit_busy");
      } finally {
        if (priorDefault === undefined) {
          Deno.env.delete("OPERANT_COMMIT_LOCK_TIMEOUT");
        } else Deno.env.set("OPERANT_COMMIT_LOCK_TIMEOUT", priorDefault);
      }
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [stage.id],
        )).rows[0].count,
        "0",
      );
      const long = commitRepository(longClient).commit(stage.id, matrix.auth, {
        lockTimeoutMs: 5_000,
      });
      await observeWaiters(
        matrix.harness.server.sql,
        "staged_changeset_lifecycle",
        1,
        blockerPid,
      );
      release();
      await lock;
      assertEquals((await long).ok, true);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await Promise.all(
        [blocker.end(), shortClient.end(), longClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit retries injected 40001 within bound and exhausts with exact nontransactional attempts",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const client = matrix.client();
    try {
      const first = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "retry-success", status: "ready" },
      }]);
      await query(
        matrix.harness.server.sql,
        "create sequence matrix_serialization_attempts",
      );
      await installSerializationTrigger(matrix, 1);
      const evidenceBefore = await externalEvidence(matrix);
      const success = await commitRepository(client).commit(
        first.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(success.ok, true);
      assertEquals(await sequenceValue(matrix), 2);
      assertEquals(await externalEvidence(matrix), evidenceBefore);

      const exhausted = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "retry-exhaust", status: "ready" },
      }]);
      await query(
        matrix.harness.server.sql,
        "drop trigger matrix_serialization_failure on changeset_commits",
      );
      await installSerializationTrigger(matrix, 100);
      const beforeExhaustion = await sequenceValue(matrix);
      const result = await commitRepository(client).commit(
        exhausted.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.code, "commit_retry_exhausted");
        assertEquals(
          (result.error.details as Record<string, unknown>).attempts,
          4,
        );
      }
      assertEquals((await sequenceValue(matrix)) - beforeExhaustion, 4);
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [exhausted.id],
        )).rows[0].count,
        "0",
      );
      assertEquals(await externalEvidence(matrix), evidenceBefore);
      await query(
        matrix.harness.server.sql,
        "drop trigger matrix_serialization_failure on changeset_commits",
      );
      await query(
        matrix.harness.server.sql,
        "drop function matrix_serialization_failure()",
      );
      await query(
        matrix.harness.server.sql,
        "drop sequence matrix_serialization_attempts",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await client.end().catch(() => undefined);
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production 40P01 exhausts exactly while 55P03 and domain conflicts attempt once",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const client = matrix.client();
    try {
      await query(
        matrix.harness.server.sql,
        "create sequence matrix_state_attempts",
      );
      await query(
        matrix.harness.server.sql,
        `create function matrix_state_failure() returns trigger
        language plpgsql as $$ begin perform nextval('matrix_state_attempts');
        raise exception 'matrix state' using errcode='40P01'; end $$`,
      );
      await query(
        matrix.harness.server.sql,
        `create trigger matrix_state_failure before insert on changeset_commits
        for each row execute function matrix_state_failure()`,
      );
      const deadlock = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "deadlock-exhaust", status: "ready" },
      }]);
      const exhausted = await commitRepository(client).commit(
        deadlock.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(exhausted.ok, false);
      if (!exhausted.ok) {
        assertEquals(exhausted.error.code, "commit_retry_exhausted");
        assertEquals(
          (exhausted.error.details as Record<string, unknown>).attempts,
          4,
        );
      }
      assertEquals(await stateAttempts(matrix), 4);

      await query(
        matrix.harness.server.sql,
        `create or replace function matrix_state_failure() returns trigger
        language plpgsql as $$ begin perform nextval('matrix_state_attempts');
        raise exception 'matrix busy' using errcode='55P03'; end $$`,
      );
      const busyStage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "busy-once", status: "ready" },
      }]);
      const beforeBusy = await stateAttempts(matrix);
      const busy = await commitRepository(client).commit(
        busyStage.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(busy.ok, false);
      if (!busy.ok) assertEquals(busy.error.code, "commit_busy");
      assertEquals((await stateAttempts(matrix)) - beforeBusy, 1);

      await query(
        matrix.harness.server.sql,
        `create or replace function matrix_state_failure() returns trigger
        language plpgsql as $$ begin perform nextval('matrix_state_attempts');
        raise exception 'matrix domain' using errcode='23505'; end $$`,
      );
      const domainStage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:gamma",
        fields: { key: "domain-once", status: "ready" },
      }]);
      const beforeDomain = await stateAttempts(matrix);
      const domain = await commitRepository(client).commit(
        domainStage.id,
        matrix.auth,
        { lockTimeoutMs: 2_000 },
      );
      assertEquals(domain.ok, false);
      if (!domain.ok) assertEquals(domain.error.code, "constraint_conflict");
      assertEquals((await stateAttempts(matrix)) - beforeDomain, 1);
      await query(
        matrix.harness.server.sql,
        "drop trigger matrix_state_failure on changeset_commits",
      );
      await query(
        matrix.harness.server.sql,
        "drop function matrix_state_failure()",
      );
      await query(
        matrix.harness.server.sql,
        "drop sequence matrix_state_attempts",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await client.end().catch(() => undefined);
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit is the deterministic PostgreSQL 40P01 victim and retries the whole transaction",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const commitClient = matrix.client(), blockerClient = matrix.client();
    try {
      const stage = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "deadlock-retry", status: "ready" },
      }]);
      await query(
        matrix.harness.server.sql,
        "create table matrix_deadlock(id integer primary key,touched integer not null default 0)",
      );
      await query(
        matrix.harness.server.sql,
        "insert into matrix_deadlock(id) select generate_series(1,1000)",
      );
      await query(
        matrix.harness.server.sql,
        "create sequence matrix_deadlock_attempts",
      );
      await query(
        matrix.harness.server.sql,
        `create function matrix_deadlock_commit() returns trigger
        language plpgsql as $$ begin perform nextval('matrix_deadlock_attempts');
        perform set_config('deadlock_timeout','50ms',true);
        update matrix_deadlock set touched=touched+1 where id=1; return new; end $$`,
      );
      await query(
        matrix.harness.server.sql,
        `create trigger matrix_deadlock_commit before insert on changeset_commits
        for each row execute function matrix_deadlock_commit()`,
      );
      let ready!: () => void, cycle!: () => void;
      const readyPromise = new Promise<void>((resolve) => ready = resolve);
      const cyclePromise = new Promise<void>((resolve) => cycle = resolve);
      const blocker = blockerClient.begin(async (tx) => {
        await tx.unsafe("select set_config('deadlock_timeout','5s',true)");
        await tx.unsafe("update matrix_deadlock set touched=touched+1");
        ready();
        await cyclePromise;
        await tx.unsafe(
          "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
          [stage.id],
        );
      });
      await readyPromise;
      const committing = commitRepository(commitClient).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      await observeWaiters(
        matrix.harness.server.sql,
        "insert into changeset_commits",
        1,
      );
      cycle();
      const [blocked, committed] = await Promise.allSettled([
        blocker,
        committing,
      ]);
      if (blocked.status === "rejected") throw blocked.reason;
      if (committed.status === "rejected") throw committed.reason;
      assertEquals(committed.value.ok, true);
      assertEquals(
        Number(
          (await query<{ value: string }>(
            matrix.harness.server.sql,
            "select last_value::text value from matrix_deadlock_attempts",
          )).rows[0].value,
        ),
        2,
      );
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=$1",
          [stage.id],
        )).rows[0].count,
        "1",
      );
      await query(
        matrix.harness.server.sql,
        "drop trigger matrix_deadlock_commit on changeset_commits",
      );
      await query(
        matrix.harness.server.sql,
        "drop function matrix_deadlock_commit()",
      );
      await query(
        matrix.harness.server.sql,
        "drop sequence matrix_deadlock_attempts",
      );
      await query(matrix.harness.server.sql, "drop table matrix_deadlock");
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await Promise.all(
        [commitClient.end(), blockerClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production concurrent absent seed stages produce one durable winner and one stable conflict",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    const firstClient = matrix.client(), secondClient = matrix.client();
    try {
      const staged = await Promise.all(
        [0, 1].map(() =>
          matrix.harness.runOptctl([
            "--json",
            "--project",
            matrix.projectId,
            "seed",
            "stage",
            "test/commitmatrix",
            "--seed",
            "alpha",
          ])
        ),
      );
      assertEquals(staged.map((result) => result.code), [0, 0]);
      const ids = staged.map((result) =>
        JSON.parse(result.stdout).data.stage.id as string
      );
      assertEquals(new Set(ids).size, 2);
      const results = await Promise.all([
        commitRepository(firstClient).commit(ids[0], matrix.auth, {
          lockTimeoutMs: 5_000,
        }),
        commitRepository(secondClient).commit(ids[1], matrix.auth, {
          lockTimeoutMs: 5_000,
        }),
      ]);
      assertEquals(results.filter((result) => result.ok).length, 1);
      const loser = results.find((result) => !result.ok);
      if (!loser || loser.ok) throw new Error("missing losing seed commit");
      assertEquals(loser.error.code, "constraint_conflict");
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from changeset_commits where stage_id=any($1::uuid[])",
          [ids],
        )).rows[0].count,
        "1",
      );
      const unchanged = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "seed",
        "stage",
        "test/commitmatrix",
        "--seed",
        "alpha",
      ]);
      assertEquals(unchanged.code, 0, unchanged.stderr);
      assertEquals(JSON.parse(unchanged.stdout).data.stage, null);
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await Promise.all(
        [firstClient.end(), secondClient.end()].map((value) =>
          value.catch(() => undefined)
        ),
      );
      await matrix.close();
    }
  },
});

Deno.test({
  name:
    "production commit rolls back every major fact point and enforces immutable successful chains",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const matrix = await startCommitMatrix();
    try {
      const dependency = await matrix.stage([{
        op: "create",
        key: "alpha",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "failure-dependency-alpha", status: "ready" },
      }, {
        op: "create",
        key: "beta",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        fields: { key: "failure-dependency-beta", status: "ready" },
      }]);
      assertEquals((await matrix.commit(dependency.id)).ok, true);
      const alphaId = String(dependency.operations[0].object_id);
      const betaId = String(dependency.operations[1].object_id);
      const unlinkBase = await matrix.stage([{
        op: "create",
        key: "alpha",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "failure-unlink-alpha", status: "ready" },
      }, {
        op: "create",
        key: "beta",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        fields: { key: "failure-unlink-beta", status: "ready" },
      }, {
        op: "link",
        key: "relationship",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        from: { $ref: "alpha.object_id" },
        to: { $ref: "beta.object_id" },
        fields: {},
      }]);
      assertEquals((await matrix.commit(unlinkBase.id)).ok, true);
      const unlinkRelationship = String(
        unlinkBase.operations[2].relationship_id,
      );
      const runtimes = (await query<
        {
          definition_kind: string;
          definition_name: string;
          table_name: string;
        }
      >(
        matrix.harness.server.sql,
        `select definition_kind,definition_name,table_name from pack_runtime_tables
         where publisher='test' and pack_name='commitmatrix'`,
      )).rows;
      const alphaTable = runtimes.find((row) =>
        row.definition_kind === "resource" && row.definition_name === "alpha"
      )!.table_name;
      const relationshipTable = runtimes.find((row) =>
        row.definition_kind === "relationship" &&
        row.definition_name === "alpha_beta"
      )!.table_name;
      const cases = [
        { point: "changeset_commits", kind: "create" },
        { point: alphaTable, kind: "create" },
        { point: "object_versions", kind: "create" },
        { point: relationshipTable, kind: "link" },
        { point: "object_versions", kind: "link" },
        { point: "comments", kind: "comment" },
        { point: "audit_events", kind: "create" },
        { point: "audit_events:changeset", kind: "create" },
        { point: "events", kind: "create" },
        { point: "events:changeset", kind: "create" },
        { point: "staged_changeset_lifecycle", kind: "create" },
        { point: "events", kind: "update" },
        { point: "events", kind: "transition" },
        { point: "events", kind: "archive" },
        { point: "object_versions", kind: "unlink" },
      ];
      for (const [ordinal, failure] of cases.entries()) {
        const operations = failureOperations(
          failure.kind,
          matrix.projectId,
          ordinal,
          alphaId,
          betaId,
          unlinkRelationship,
        );
        const stage = await matrix.stage(operations);
        const before = await completeSnapshot(matrix, stage.id);
        await installFailure(matrix, failure.point);
        const failed = await matrix.commit(stage.id);
        assertEquals(failed.ok, false);
        await removeFailure(matrix, failure.point);
        assertEquals(await completeSnapshot(matrix, stage.id), before);
        const generatedId = failure.kind === "link"
          ? String(stage.operations[0].relationship_id)
          : failure.kind === "create"
          ? String(stage.operations[0].object_id)
          : "";
        if (generatedId) {
          const projection = failure.kind === "link"
            ? relationshipTable
            : alphaTable;
          assertEquals(
            (await query<{ count: string }>(
              matrix.harness.server.sql,
              `select count(*)::text count from ${
                quoteIdentifier(projection)
              } where id=$1`,
              [generatedId],
            )).rows[0].count,
            "0",
          );
        }
      }

      const successStage = await matrix.stage([{
        op: "create",
        key: "created",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "immutable-success", status: "ready" },
      }, {
        op: "comment",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: { $ref: "created.object_id" },
        body: "immutable",
      }]);
      const success = await matrix.commit(successStage.id);
      assertEquals(success.ok, true);
      if (!success.ok) {
        throw new Error("commit failed");
      }
      const commitId = success.value.id;
      const objectId = String(successStage.operations[0].object_id);
      const version = (await query<{ id: string; snapshot_json: unknown }>(
        matrix.harness.server.sql,
        "select id,snapshot_json from object_versions where changeset_commit_id=$1",
        [commitId],
      )).rows[0];
      const runtimeTable = (await query<{ table_name: string }>(
        matrix.harness.server.sql,
        `select table_name from pack_runtime_tables where publisher='test' and pack_name='commitmatrix'
         and definition_kind='resource' and definition_name='alpha'`,
      )).rows[0].table_name;
      const pointer = (await query<{ current: string }>(
        matrix.harness.server.sql,
        `select current_object_version_id current from ${
          quoteIdentifier(runtimeTable)
        } where id=$1`,
        [objectId],
      )).rows[0].current;
      // The immutable version and comment target are the same generated version.
      assertEquals(
        (await query<{ id: string }>(
          matrix.harness.server.sql,
          "select target_object_version_id id from comments where changeset_commit_id=$1",
          [commitId],
        )).rows[0].id,
        version.id,
      );
      assertEquals(
        (await query<{ version: number }>(
          matrix.harness.server.sql,
          "select version from object_versions where id=$1",
          [version.id],
        )).rows[0].version,
        1,
      );
      assertEquals(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from events where changeset_commit_id=$1 and schema_version=1",
          [commitId],
        )).rows[0].count,
        "3",
      );
      assertEquals(pointer, version.id);
      for (
        const statement of [
          [
            "update changeset_commits set committed_at=committed_at where id=$1",
            commitId,
          ],
          ["delete from changeset_commits where id=$1", commitId],
          [
            "update object_versions set snapshot_json=snapshot_json where id=$1",
            version.id,
          ],
          ["delete from object_versions where id=$1", version.id],
          [
            "update comments set body=body where changeset_commit_id=$1",
            commitId,
          ],
          ["delete from comments where changeset_commit_id=$1", commitId],
          [
            "update audit_events set policy_summary_json=policy_summary_json where changeset_commit_id=$1",
            commitId,
          ],
          ["delete from audit_events where changeset_commit_id=$1", commitId],
          [
            "update events set payload_json=payload_json where changeset_commit_id=$1",
            commitId,
          ],
          ["delete from events where changeset_commit_id=$1", commitId],
          [
            "update staged_changesets set warnings_json=warnings_json where id=$1",
            successStage.id,
          ],
          ["delete from staged_changesets where id=$1", successStage.id],
          [
            "update staged_changeset_operations set canonical_operation_json=canonical_operation_json where stage_id=$1",
            successStage.id,
          ],
          [
            "delete from staged_changeset_operations where stage_id=$1",
            successStage.id,
          ],
          [
            "update staged_changeset_dependencies set dependency_json=dependency_json where stage_id=$1",
            successStage.id,
          ],
          [
            "delete from staged_changeset_dependencies where stage_id=$1",
            successStage.id,
          ],
        ] as const
      ) {
        await assertRejects(() =>
          query(matrix.harness.server.sql, statement[0], [statement[1]])
        );
      }
      assertEquals(objectId.length > 0, true);

      const chainCreate = await matrix.stage([{
        op: "create",
        key: "alpha",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "complete-chain-alpha", status: "ready" },
      }, {
        op: "create",
        key: "beta",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:beta",
        fields: { key: "complete-chain-beta", status: "ready" },
      }]);
      const chainCommits: Array<{ id: string; operations: number }> = [];
      const createCommit = await matrix.commit(chainCreate.id);
      assertEquals(createCommit.ok, true);
      if (!createCommit.ok) {
        throw new Error("chain create failed");
      }
      chainCommits.push({ id: createCommit.value.id, operations: 2 });
      const chainAlpha = String(chainCreate.operations[0].object_id);
      const chainBeta = String(chainCreate.operations[1].object_id);
      const commitChain = async (operations: Record<string, unknown>[]) => {
        const staged = await matrix.stage(operations);
        const committed = await matrix.commit(staged.id);
        assertEquals(committed.ok, true, JSON.stringify(committed));
        if (!committed.ok) {
          throw new Error("chain commit failed");
        }
        chainCommits.push({
          id: committed.value.id,
          operations: operations.length,
        });
        return staged;
      };
      await commitChain([{
        op: "update",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: chainAlpha,
        set: { note: "updated" },
      }]);
      await commitChain([{
        op: "transition",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: chainAlpha,
        to: "done",
      }]);
      const linked = await commitChain([{
        op: "link",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        from: chainAlpha,
        to: chainBeta,
        fields: { label: "first" },
      }]);
      const linkedId = String(linked.operations[0].relationship_id);
      const beforeCommentVersions = Number(
        (await query<{ count: string }>(
          matrix.harness.server.sql,
          "select count(*)::text count from object_versions where object_id=$1",
          [chainAlpha],
        )).rows[0].count,
      );
      await commitChain([{
        op: "comment",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: chainAlpha,
        body: "no bump",
      }]);
      assertEquals(
        Number(
          (await query<{ count: string }>(
            matrix.harness.server.sql,
            "select count(*)::text count from object_versions where object_id=$1",
            [chainAlpha],
          )).rows[0].count,
        ),
        beforeCommentVersions,
      );
      await commitChain([{
        op: "unlink",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        relationship_id: linkedId,
      }]);
      const relinked = await commitChain([{
        op: "link",
        project_id: matrix.projectId,
        relationship: "test/commitmatrix:alpha_beta",
        from: chainAlpha,
        to: chainBeta,
        fields: { label: "second" },
      }]);
      assertEquals(
        String(relinked.operations[0].relationship_id) === linkedId,
        false,
      );
      await commitChain([{
        op: "archive",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        object_id: chainAlpha,
      }]);
      const chainVersions = (await query<
        { id: string; previous_version_id: string | null; operation: string }
      >(
        matrix.harness.server.sql,
        "select id,previous_version_id,operation from object_versions where object_id=$1 order by version",
        [chainAlpha],
      )).rows;
      assertEquals(
        chainVersions.map((row) =>
          row.operation
        ),
        [
          "create",
          "update",
          "transition",
          "archive",
        ],
      );
      assertEquals(
        chainVersions.slice(1).every((row, index) =>
          row.previous_version_id === chainVersions[index].id
        ),
        true,
      );
      for (const committed of chainCommits) {
        assertEquals(
          (await query<{ count: string }>(
            matrix.harness.server.sql,
            "select count(*)::text count from events where changeset_commit_id=$1 and schema_version=1",
            [committed.id],
          )).rows[0].count,
          String(committed.operations + 1),
        );
      }
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await matrix.close();
    }
  },
});

async function installSerializationTrigger(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  failures: number,
) {
  await query(
    matrix.harness.server.sql,
    `create or replace function matrix_serialization_failure()
    returns trigger language plpgsql as $$ begin
      if nextval('matrix_serialization_attempts') <= ${failures} then
        raise exception 'matrix serialization' using errcode='40001';
      end if; return new; end $$`,
  );
  await query(
    matrix.harness.server.sql,
    `create trigger matrix_serialization_failure before insert
    on changeset_commits for each row execute function matrix_serialization_failure()`,
  );
}
async function stateAttempts(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
) {
  return Number(
    (await query<{ value: string }>(
      matrix.harness.server.sql,
      "select last_value::text value from matrix_state_attempts",
    )).rows[0].value,
  );
}

async function sequenceValue(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
) {
  return Number(
    (await query<{ value: string }>(
      matrix.harness.server.sql,
      "select last_value::text value from matrix_serialization_attempts",
    )).rows[0].value,
  );
}
async function externalEvidence(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
) {
  return (await query(
    matrix.harness.server.sql,
    `select
    (select count(*) from staged_hook_executions)::text hooks,
    (select count(*) from hook_secret_grants)::text grants,
    (select count(*) from platform_secrets)::text secrets`,
  )).rows[0];
}
async function installFailure(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  table: string,
) {
  const [actualTable, selector] = table.split(":");
  const guard = selector === "changeset"
    ? "if new.event_type <> 'changeset.committed' then return new; end if;"
    : "";
  await query(
    matrix.harness.server.sql,
    `create function matrix_commit_failure() returns trigger
    language plpgsql as $$ begin ${guard} raise exception 'matrix failure'; end $$`,
  );
  const operation = actualTable === "staged_changeset_lifecycle"
    ? "after update"
    : "after insert";
  await query(
    matrix.harness.server.sql,
    `create trigger matrix_commit_failure ${operation} on ${
      quoteIdentifier(actualTable)
    }
    for each row execute function matrix_commit_failure()`,
  );
}
async function removeFailure(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  table: string,
) {
  const actualTable = table.split(":")[0];
  await query(
    matrix.harness.server.sql,
    `drop trigger matrix_commit_failure on ${quoteIdentifier(actualTable)}`,
  );
  await query(
    matrix.harness.server.sql,
    "drop function matrix_commit_failure()",
  );
}
function failureOperations(
  kind: string,
  projectId: string,
  ordinal: number,
  alphaId: string,
  betaId: string,
  relationshipId: string,
): Record<string, unknown>[] {
  if (kind === "link") {
    return [{
      op: "link",
      project_id: projectId,
      relationship: "test/commitmatrix:alpha_beta",
      from: alphaId,
      to: betaId,
      fields: { label: `failure-${ordinal}` },
    }];
  }
  if (kind === "unlink") {
    return [{
      op: "unlink",
      project_id: projectId,
      relationship: "test/commitmatrix:alpha_beta",
      relationship_id: relationshipId,
    }];
  }
  if (kind === "comment") {
    return [{
      op: "comment",
      project_id: projectId,
      resource: "test/commitmatrix:alpha",
      object_id: alphaId,
      body: `failure-${ordinal}`,
    }];
  }
  if (kind === "update") {
    return [{
      op: "update",
      project_id: projectId,
      resource: "test/commitmatrix:alpha",
      object_id: alphaId,
      set: { note: `failure-${ordinal}` },
    }];
  }
  if (kind === "transition") {
    return [{
      op: "transition",
      project_id: projectId,
      resource: "test/commitmatrix:alpha",
      object_id: alphaId,
      to: "done",
    }];
  }
  if (kind === "archive") {
    return [{
      op: "archive",
      project_id: projectId,
      resource: "test/commitmatrix:alpha",
      object_id: alphaId,
    }];
  }
  return [{
    op: "create",
    project_id: projectId,
    resource: "test/commitmatrix:alpha",
    fields: { key: `failure-${ordinal}`, status: "ready" },
  }];
}

async function completeSnapshot(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
) {
  const runtimeTables = (await query<{ table_name: string }>(
    matrix.harness.server.sql,
    "select table_name from pack_runtime_tables order by table_name",
  )).rows.map((row) => row.table_name);
  const tables = [
    ...runtimeTables,
    "changeset_commits",
    "object_versions",
    "comments",
    "audit_events",
    "events",
    "staged_changeset_lifecycle",
  ];
  const snapshot: Record<string, unknown> = {};
  for (const table of tables) {
    const where = table === "staged_changeset_lifecycle"
      ? "stage_id=$1"
      : ["changeset_commits"].includes(table)
      ? "stage_id=$1"
      : ["object_versions", "comments", "audit_events", "events"].includes(
          table,
        )
      ? "changeset_commit_id in (select id from changeset_commits where stage_id=$1)"
      : "true";
    snapshot[table] = (await query(
      matrix.harness.server.sql,
      `select to_jsonb(value) value from ${
        quoteIdentifier(table)
      } value where ${where} order by to_jsonb(value)::text`,
      where === "true" ? [] : [stageId],
    )).rows;
  }
  return snapshot;
}
