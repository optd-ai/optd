// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { startHttpProvider } from "../support/http_provider.ts";
import {
  assertNoIdleClients,
  commitRepository,
  startCommitMatrix,
} from "../support/commit_revalidation_harness.ts";

Deno.test({
  name:
    "production commit retries stored action operations without provider hook grant or secret resolution",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const provider = startHttpProvider([{
      kind: "success",
      body: { ok: true },
    }]);
    const previousKey = Deno.env.get("OPERANT_SECRET_MASTER_KEY");
    Deno.env.set(
      "OPERANT_SECRET_MASTER_KEY",
      btoa(String.fromCharCode(...new Uint8Array(32).fill(41))),
    );
    const matrix = await startCommitMatrix({ providerUrl: provider.url });
    const client = matrix.client();
    try {
      const secret = await matrix.harness.runOptctl([
        "--json",
        "secret",
        "create",
        "matrix-token",
        "--stdin",
      ], "pinned-token\n");
      assertEquals(secret.code, 0, secret.stderr);
      const grant = await matrix.harness.runOptctl([
        "--json",
        "secret",
        "grant",
        "matrix-token",
        "--hook",
        "test/commitmatrix:generate",
        "--slot",
        "token",
      ]);
      assertEquals(grant.code, 0, grant.stderr);
      const source = await matrix.stage([{
        op: "create",
        project_id: matrix.projectId,
        resource: "test/commitmatrix:alpha",
        fields: { key: "hook-retry-source", status: "ready" },
      }]);
      assertEquals((await matrix.commit(source.id)).ok, true);
      const staged = await matrix.harness.runOptctl([
        "--json",
        "--project",
        matrix.projectId,
        "action",
        "stage",
        "test/commitmatrix:generate",
        "--input",
        JSON.stringify({
          project_id: matrix.projectId,
          source_id: String(source.operations[0].object_id),
        }),
      ]);
      assertEquals(staged.code, 0, staged.stderr);
      const stage = JSON.parse(staged.stdout).data;
      assertEquals(provider.attempts.length, 1);
      const evidenceBefore = await storedEvidence(matrix, stage.id);
      assertEquals(evidenceBefore.hooks.length, 1);
      const stagedHook = evidenceBefore.hooks[0] as Record<string, unknown>;
      assertEquals(
        (stagedHook.grant_snapshot_json as { grants: unknown[] }).grants.length,
        1,
      );
      const current = (await query<
        { grant_id: string; secret_id: string; value_version: string }
      >(
        matrix.harness.server.sql,
        `select h.grant_id,g.secret_id,s.value_version::text from hook_secret_grant_heads h
         join hook_secret_grants g on g.id=h.grant_id join platform_secrets s on s.id=g.secret_id
         limit 1`,
      )).rows[0];
      const revoke = await matrix.harness.runOptctl([
        "--json",
        "secret",
        "revoke-grant",
        current.grant_id,
      ]);
      assertEquals(revoke.code, 0, revoke.stderr);
      const disable = await matrix.harness.runOptctl([
        "--json",
        "secret",
        "disable",
        "matrix-token",
      ]);
      assertEquals(disable.code, 0, disable.stderr);
      const evidenceAfterRevocation = await storedEvidence(matrix, stage.id);
      assertEquals(evidenceAfterRevocation.hooks, evidenceBefore.hooks);

      await query(
        matrix.harness.server.sql,
        "create sequence matrix_hook_retry_attempts",
      );
      await query(
        matrix.harness.server.sql,
        `create function matrix_hook_retry() returns trigger language plpgsql as $$
        begin if nextval('matrix_hook_retry_attempts')=1 then raise exception 'retry' using errcode='40001'; end if;
        return new; end $$`,
      );
      await query(
        matrix.harness.server.sql,
        `create trigger matrix_hook_retry before insert on changeset_commits
        for each row execute function matrix_hook_retry()`,
      );
      const committed = await commitRepository(client).commit(
        stage.id,
        matrix.auth,
        { lockTimeoutMs: 5_000 },
      );
      assertEquals(committed.ok, true);
      assertEquals(
        Number(
          (await query<{ value: string }>(
            matrix.harness.server.sql,
            "select last_value::text value from matrix_hook_retry_attempts",
          )).rows[0].value,
        ),
        2,
      );
      assertEquals(provider.attempts.length, 1);
      assertEquals(
        await storedEvidence(matrix, stage.id),
        evidenceAfterRevocation,
      );
      assertEquals(
        (await query<{ status: string; value_version: string }>(
          matrix.harness.server.sql,
          "select status,value_version::text value_version from platform_secrets where id=$1",
          [current.secret_id],
        )).rows[0],
        { status: "disabled", value_version: current.value_version },
      );
      await query(
        matrix.harness.server.sql,
        "drop trigger matrix_hook_retry on changeset_commits",
      );
      await query(
        matrix.harness.server.sql,
        "drop function matrix_hook_retry()",
      );
      await query(
        matrix.harness.server.sql,
        "drop sequence matrix_hook_retry_attempts",
      );
      await assertNoIdleClients(matrix.harness.server.sql);
    } finally {
      await client.end().catch(() => undefined);
      await matrix.close();
      await provider.close();
      if (previousKey === undefined) {
        Deno.env.delete("OPERANT_SECRET_MASTER_KEY");
      } else Deno.env.set("OPERANT_SECRET_MASTER_KEY", previousKey);
    }
  },
});

async function storedEvidence(
  matrix: Awaited<ReturnType<typeof startCommitMatrix>>,
  stageId: string,
) {
  const hooks = (await query<Record<string, unknown>>(
    matrix.harness.server.sql,
    `select to_jsonb(h)-'created_at' value from staged_hook_executions h where stage_id=$1 order by ordinal`,
    [stageId],
  )).rows.map((row) => row.value);
  const externalAudits = (await query<{ count: string }>(
    matrix.harness.server.sql,
    `select count(*)::text count from audit_events where resource in ('system:secret','system:hook-secret-grant')`,
  )).rows[0].count;
  return { hooks, externalAudits };
}
