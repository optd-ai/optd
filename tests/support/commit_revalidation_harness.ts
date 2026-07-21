// deno-lint-ignore-file no-import-prefix no-unversioned-import
import postgres from "npm:postgres";
import { assertEquals } from "jsr:@std/assert";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import { PostgresCommitRepository } from "../../src/adapters/outbound/postgres/commit_repository.ts";
import { makeStageChangesetService } from "../../src/application/services/changesets/stage_changesets.ts";
import { makeCommitChangesetService } from "../../src/application/services/commit/commit_changeset.ts";
import {
  query,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";
import { startAuthenticatedHarness } from "./authenticated_harness.ts";

export async function startCommitMatrix() {
  const harness = await startAuthenticatedHarness();
  const pack = await Deno.makeTempDir({ prefix: "commit-matrix-pack-" });
  await writePack(pack);
  const applied = await harness.runOptctl([
    "--json",
    "pack",
    "apply",
    pack,
    "--safe",
  ]);
  assertEquals(applied.code, 0, applied.stderr);
  const project = await harness.runOptctl([
    "--json",
    "project",
    "create",
    `commit-matrix-${crypto.randomUUID().slice(0, 8)}`,
    "--display-name",
    "Commit Matrix",
  ]);
  assertEquals(project.code, 0, project.stderr);
  const auth = await currentAuth(harness.server.sql);
  const stageRepository = new PostgresStageRepository(harness.server.sql);
  const stageService = makeStageChangesetService(stageRepository);
  return {
    harness,
    pack,
    projectId: JSON.parse(project.stdout).data.id as string,
    auth,
    stageRepository,
    stageService,
    client() {
      return postgres(harness.databaseUrl, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 5,
      });
    },
    async stage(operations: Record<string, unknown>[], actor = auth) {
      const result = await stageService.stage({ operations }, actor);
      if (!result.ok) {
        throw new Error(`stage failed: ${JSON.stringify(result.error)}`);
      }
      return result.value;
    },
    async commit(stageId: string, actor = auth, timeout = "2s") {
      return await makeCommitChangesetService(
        new PostgresCommitRepository(harness.server.sql),
      ).commit(stageId, { lock_timeout: timeout }, actor);
    },
    async close() {
      await harness.close();
      await Deno.remove(pack, { recursive: true }).catch(() => undefined);
    },
  };
}

export async function currentAuth(sql: Sql): Promise<AuthContext> {
  const row = (await query<{
    id: string;
    principal_id: string;
    principal_type: "human_user" | "agent_user";
    human_user_id: string;
    session_id: string;
    authorization_id: string | null;
    credential_kind: AuthContext["credentialKind"];
    roles: string[];
    created_at: Date | string;
  }>(
    sql,
    `select c.id,c.principal_id,p.type principal_type,c.human_user_id,c.session_id,
      c.authorization_id,c.credential_kind,c.roles,c.created_at
      from auth_contexts c join principals p on p.id=c.principal_id order by c.created_at desc limit 1`,
  )).rows[0];
  return {
    id: row.id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    humanUserId: row.human_user_id,
    sessionId: row.session_id,
    ...(row.authorization_id ? { authorizationId: row.authorization_id } : {}),
    credentialKind: row.credential_kind,
    roles: row.roles,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  };
}

export function commitRepository(sql: ReturnType<typeof postgres>) {
  return new PostgresCommitRepository(sql as unknown as Sql);
}

export async function observeWaiters(
  observer: Sql,
  fragment: string,
  expected: number,
  blockerPid?: number,
) {
  const deadline = Date.now() + 8_000;
  let last: unknown = null;
  while (Date.now() < deadline) {
    const rows = (await query<{
      pid: number;
      blockers: number[];
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      observer,
      `select pid,pg_blocking_pids(pid) blockers,wait_event_type,wait_event
      from pg_stat_activity where pid<>pg_backend_pid() and position($1 in query)>0
      and cardinality(pg_blocking_pids(pid))>0 order by query_start,pid`,
      [fragment],
    )).rows;
    last = rows;
    if (
      rows.length === expected &&
      rows.every((row) =>
        row.wait_event_type === "Lock" && row.blockers.length > 0
      ) &&
      (blockerPid === undefined ||
        rows.every((row) => row.blockers.includes(blockerPid)))
    ) return rows;
    await Promise.resolve();
  }
  throw new Error(`bounded waiter observation failed: ${JSON.stringify(last)}`);
}

export async function assertNoIdleClients(sql: Sql) {
  const rows = await query<{ pid: number; query: string }>(
    sql,
    `select pid,query from pg_stat_activity
    where datname=current_database() and state='idle in transaction' and pid<>pg_backend_pid()`,
  );
  assertEquals(rows.rows, []);
}

export async function writePack(root: string) {
  await Deno.mkdir(`${root}/resources`);
  await Deno.mkdir(`${root}/relationships`);
  await Deno.mkdir(`${root}/lifecycles`);
  await Deno.mkdir(`${root}/roles`);
  await Deno.mkdir(`${root}/hooks`);
  await Deno.mkdir(`${root}/seeds`);
  await Deno.writeTextFile(
    `${root}/pack.yaml`,
    `kind: Pack\napiVersion: operant.dev/v1\nmetadata: { publisher: test, name: commitmatrix, version: 1.0.0 }\nspec: { purpose: Production commit matrix., axi: {} }\n`,
  );
  for (const name of ["alpha", "beta"]) {
    await Deno.writeTextFile(
      `${root}/resources/${name}.yaml`,
      `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: ${name} }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n    status: { type: string, required: true }\n    note: { type: string }\n    parent_key: { type: string }\n  axi: {}\n`,
    );
  }
  await Deno.writeTextFile(
    `${root}/resources/approval_case.yaml`,
    `kind: Resource\napiVersion: operant.dev/v1\nmetadata: { name: approval_case }\nspec:\n  fields:\n    key: { type: string, required: true, unique: true }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/roles/reviewer.yaml`,
    `kind: Role\napiVersion: operant.dev/v1\nmetadata: { name: reviewer }\nspec:\n  display_name: Commit Reviewer\n  description: Exact matrix reviewer.\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/approval.yaml`,
    `kind: Hook\napiVersion: operant.dev/v1\nmetadata: { name: approval }\nspec:\n  script: approval.ts\n  permissions: { net: false, env: false, read: false, write: false, run: false }\n  secrets: []\n  effects: { operations: [] }\n  output: { schema: validation.v1 }\n  attachments:\n    - { phase: changeset.validate, resource: approval_case, input: { proposed: '$proposed' } }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/hooks/approval.ts`,
    `console.log(JSON.stringify({allow:true,errors:[],warnings:[],required_approvals:[{key:"matrix_review",role:"test/commitmatrix:reviewer",boundary:{type:"system"},minimum:1,principal_types:["human_user"],allow_initiator:true,expires_at:null,reason:"matrix review"}]}));`,
  );
  await Deno.writeTextFile(
    `${root}/relationships/alpha_owner.yaml`,
    `kind: Relationship\napiVersion: operant.dev/v1\nmetadata: { name: alpha_owner }\nspec:\n  from: { resource: alpha }\n  to: { resource: system:principal }\n  fields: {}\n  unique: [from, to]\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/seeds/alpha.yaml`,
    `kind: Seed\napiVersion: operant.dev/v1\nmetadata: { name: alpha }\nspec:\n  resource: alpha\n  key: key\n  mode: changeset\n  rows:\n    - { key: seeded-alpha, status: ready }\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/relationships/alpha_beta.yaml`,
    `kind: Relationship\napiVersion: operant.dev/v1\nmetadata: { name: alpha_beta }\nspec:\n  from: { resource: alpha }\n  to: { resource: beta }\n  fields:\n    label: { type: string }\n  unique: [from, to]\n  axi: {}\n`,
  );
  await Deno.writeTextFile(
    `${root}/lifecycles/alpha_status.yaml`,
    `kind: Lifecycle\napiVersion: operant.dev/v1\nmetadata: { name: alpha_status }\nspec:\n  resource: alpha\n  field: status\n  initial: ready\n  states:\n    - { name: ready, terminal: false }\n    - { name: done, terminal: true }\n  transitions:\n    - { name: finish, from: [ready], to: done, set: { note: transitioned } }\n  axi: {}\n`,
  );
}
