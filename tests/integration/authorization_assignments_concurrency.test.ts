import { assertEquals, assertRejects } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import {
  query,
  type Queryable,
} from "../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { tokenDigest } from "../../src/domain/auth/token.ts";
import type { AuthContext } from "../../src/domain/auth/model.ts";
import { PostgresAgentAuthorizationGrantabilityState } from "../../src/adapters/outbound/postgres/auth_repository.ts";
import { type LiveHarness, startLiveHarness } from "../support/live_harness.ts";

type Credentials = { token: string };

Deno.test("assignment disable ordering preserves immutable contexts and cuts off current authority", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "race-root",
        password: "assignment race root password",
      })).code,
      0,
    );
    const root = await credentials(harness);
    const project = await createProject(harness);
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "user",
        "create",
        "--username",
        "race-user",
        "--password-stdin",
      ], "assignment race user password\n")).code,
      0,
    );
    const user = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='race-user'",
    )).rows[0];
    const roleVersion = uuidV7();
    const policyVersion = uuidV7();
    await query(
      harness.server.sql,
      "insert into system_roles(id,display_name,active) values('optd/test:operator','Operator',true)",
    );
    await query(
      harness.server.sql,
      "insert into role_definition_versions(id,role_id,version,active) values($1,'optd/test:operator',1,true)",
      [roleVersion],
    );
    await query(
      harness.server.sql,
      "insert into policy_definition_versions(id,policy_id,version,active) values($1,'optd/test:race_policy',1,true)",
      [policyVersion],
    );
    await query(
      harness.server.sql,
      `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind)
       values($1,$2,'optd/test:operator','auth.request.decide','*','unconditional')`,
      [uuidV7(), policyVersion],
    );
    const roleCreated = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      user.id,
      "--role",
      "optd/test:operator",
      "--boundary",
      "all_projects",
    ]);
    const policyCreated = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersion,
      "--boundary",
      "all_projects",
    ]);
    assertEquals(roleCreated.code, 0, roleCreated.stderr);
    assertEquals(policyCreated.code, 0, policyCreated.stderr);
    const roleAssignment = JSON.parse(roleCreated.stdout).data;
    const policyAssignment = JSON.parse(policyCreated.stdout).data;
    assertEquals(
      (await harness.login({
        username: "race-user",
        password: "assignment race user password",
      })).code,
      0,
    );
    const actor = await credentials(harness);
    const actorContext = await authContextFor(harness, actor.token);
    const grantability = new PostgresAgentAuthorizationGrantabilityState(
      harness.server.sql,
    );
    const grantBeforeRole = await grantability.current({
      auth: actorContext,
      roles: ["optd/test:operator"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(grantBeforeRole.ok && grantBeforeRole.value.canDecide, true);

    const roleLock = lockRow(
      harness.server.sql,
      "role_assignments",
      roleAssignment.id,
    );
    await roleLock.locked;
    const disableRole = post(
      harness,
      root,
      `/api/v1/auth/users/${user.id}/role-assignments/${roleAssignment.id}/disable`,
      {
        expected_version: roleAssignment.version,
      },
    );
    await waitForBlockedDisable(harness, "role_assignments");
    assertEquals(
      await auditCount(harness, "role_assignment.disabled", roleAssignment.id),
      0,
    );
    const beforeRole = await authority(harness, actor, project);
    assertEquals(beforeRole.effective_roles, ["optd/test:operator"]);
    assertEquals(
      beforeRole.capabilities.some((item: Record<string, unknown>) =>
        item.action === "auth.request.decide"
      ),
      true,
    );
    roleLock.release();
    assertEquals((await disableRole).status, 200);
    await roleLock.done;
    const afterRole = await authority(harness, actor, project);
    assertEquals(afterRole.effective_roles, []);
    const grantAfterRole = await grantability.current({
      auth: actorContext,
      roles: ["optd/test:operator"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(grantAfterRole.ok && grantAfterRole.value.canDecide, false);
    assertEquals(
      await auditCount(harness, "role_assignment.disabled", roleAssignment.id),
      1,
    );
    assertEquals(
      (await query<{ count: number }>(
        harness.server.sql,
        "select count(*)::int count from auth_context_role_assignments where auth_context_id=$1 and role_id='optd/test:operator'",
        [beforeRole.auth_context_id],
      )).rows[0].count,
      1,
    );
    assertEquals(
      (await query<{ count: number }>(
        harness.server.sql,
        "select count(*)::int count from auth_context_role_assignments where auth_context_id=$1 and role_id='optd/test:operator'",
        [afterRole.auth_context_id],
      )).rows[0].count,
      0,
    );
    await assertRejects(() =>
      query(
        harness.server.sql,
        "delete from auth_context_role_assignments where auth_context_id=$1",
        [beforeRole.auth_context_id],
      )
    );

    const replacementRole = await post(
      harness,
      root,
      `/api/v1/auth/users/${user.id}/role-assignments`,
      {
        role: "optd/test:operator",
        boundary: { type: "all_projects" },
      },
    );
    assertEquals(replacementRole.status, 201);
    const grantBeforePolicy = await grantability.current({
      auth: actorContext,
      roles: ["optd/test:operator"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(
      grantBeforePolicy.ok && grantBeforePolicy.value.canDecide,
      true,
    );
    const policyLock = lockRow(
      harness.server.sql,
      "policy_assignments",
      policyAssignment.id,
    );
    await policyLock.locked;
    const disablePolicy = post(
      harness,
      root,
      `/api/v1/policy-assignments/${policyAssignment.id}/disable`,
      {
        expected_version: policyAssignment.version,
      },
    );
    await waitForBlockedDisable(harness, "policy_assignments");
    assertEquals(
      await auditCount(
        harness,
        "policy_assignment.disabled",
        policyAssignment.id,
      ),
      0,
    );
    const beforePolicy = await authority(harness, actor, project);
    assertEquals(beforePolicy.effective_roles, ["optd/test:operator"]);
    assertEquals(beforePolicy.capabilities.length, 1);
    policyLock.release();
    assertEquals((await disablePolicy).status, 200);
    await policyLock.done;
    const afterPolicy = await authority(harness, actor, project);
    assertEquals(afterPolicy.effective_roles, ["optd/test:operator"]);
    assertEquals(afterPolicy.capabilities, []);
    const grantAfterPolicy = await grantability.current({
      auth: actorContext,
      roles: ["optd/test:operator"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(
      grantAfterPolicy.ok && grantAfterPolicy.value.canDecide,
      false,
    );
    assertEquals(
      await auditCount(
        harness,
        "policy_assignment.disabled",
        policyAssignment.id,
      ),
      1,
    );

    const columns = (await query<{ column_name: string }>(
      harness.server.sql,
      `select column_name from information_schema.columns
       where table_name in ('system_roles','role_definition_versions') order by column_name`,
    )).rows.map((row) => row.column_name);
    assertEquals(columns.includes("allow"), false);
    assertEquals(columns.includes("roles"), false);
  } finally {
    await harness.close();
  }
});

Deno.test("agent all-project grantability is current, same-human, and Project-only", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "agent-boundary-root",
        password: "agent boundary root password",
      })).code,
      0,
    );
    const project = await createProject(harness);
    const human = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='agent-boundary-root'",
    )).rows[0];
    const context = (await query<{ id: string }>(
      harness.server.sql,
      "select id from auth_contexts order by created_at desc limit 1",
    )).rows[0];
    const principalId = uuidV7();
    const agentUserId = uuidV7();
    const authorizationId = uuidV7();
    await harness.server.sql.begin(async (tx) => {
      await query(
        tx as Queryable,
        "insert into principals(id,type,active) values($1,'agent_user',true)",
        [principalId],
      );
      await query(
        tx as Queryable,
        "insert into agent_users(id,principal_id,human_user_id,name) values($1,$2,$3,'boundary-agent')",
        [agentUserId, principalId, human.id],
      );
      await query(
        tx as Queryable,
        `insert into agent_authorizations(id,agent_user_id,human_user_id,root_authorization_id,approved_by_auth_context_id)
        values($1,$2,$3,$1,$4)`,
        [authorizationId, agentUserId, human.id, context.id],
      );
      await query(
        tx as Queryable,
        `insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type)
        values($1,$2,'system:admin','all_projects')`,
        [uuidV7(), authorizationId],
      );
    });
    const auth: AuthContext = {
      id: uuidV7(),
      principalId,
      principalType: "agent_user",
      humanUserId: human.id,
      sessionId: uuidV7(),
      authorizationId,
      credentialKind: "agent_authorization",
      roles: ["system:admin"],
      createdAt: new Date().toISOString(),
    };
    const state = new PostgresAgentAuthorizationGrantabilityState(
      harness.server.sql,
    );
    const projectState = await state.current({
      auth,
      roles: ["system:admin"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(projectState.ok && projectState.value.canDecide, true);
    assertEquals(projectState.ok && projectState.value.effectiveRoles, [
      "system:admin",
    ]);
    const systemState = await state.current({
      auth,
      roles: ["system:admin"],
      boundary: { type: "system" },
    });
    assertEquals(systemState.ok && systemState.value.canDecide, false);
    assertEquals(systemState.ok && systemState.value.effectiveRoles, []);
    const wrongHuman = await state.current({
      auth: { ...auth, humanUserId: uuidV7() },
      roles: ["system:admin"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(wrongHuman.ok && wrongHuman.value.effectiveRoles, []);
    await query(
      harness.server.sql,
      "update agent_authorizations set revoked_at=now() where id=$1",
      [authorizationId],
    );
    const revoked = await state.current({
      auth,
      roles: ["system:admin"],
      boundary: { type: "project", projectId: project },
    });
    assertEquals(revoked.ok && revoked.value.effectiveRoles, []);
    assertEquals(revoked.ok && revoked.value.canDecide, false);
  } finally {
    await harness.close();
  }
});

function lockRow(
  sql: LiveHarness["server"]["sql"],
  table: "role_assignments" | "policy_assignments",
  id: string,
) {
  let lockedResolve!: () => void;
  let releaseResolve!: () => void;
  const locked = new Promise<void>((resolve) => lockedResolve = resolve);
  const release = new Promise<void>((resolve) => releaseResolve = resolve);
  const done = sql.begin(async (tx) => {
    await query(
      tx as Queryable,
      `select id from ${table} where id=$1 for update`,
      [id],
    );
    lockedResolve();
    await release;
  });
  return { locked, release: releaseResolve, done };
}
async function waitForBlockedDisable(harness: LiveHarness, table: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from pg_stat_activity where wait_event_type='Lock' and query ilike $1`,
      [`%${table}%`],
    )).rows[0].count;
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`disable did not block on ${table}`);
}
async function authority(
  harness: LiveHarness,
  actor: Credentials,
  project: string,
) {
  const response = await fetch(
    `${harness.baseUrl}/api/v1/authorization/authority?boundary_type=project&project_id=${project}`,
    {
      headers: { authorization: `Bearer ${actor.token}` },
    },
  );
  assertEquals(response.status, 200);
  return (await response.json()).data;
}
async function post(
  harness: LiveHarness,
  actor: Credentials,
  path: string,
  body: unknown,
) {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${actor.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}
async function auditCount(
  harness: LiveHarness,
  event: string,
  assignment: string,
) {
  return (await query<{ count: number }>(
    harness.server.sql,
    "select count(*)::int count from authorization_audit_events where event_type=$1 and assignment_id=$2",
    [event, assignment],
  )).rows[0].count;
}
async function createProject(harness: LiveHarness) {
  const result = await harness.runOptctl([
    "--json",
    "project",
    "create",
    "race-project",
    "--display-name",
    "Race Project",
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.id as string;
}
async function authContextFor(
  harness: LiveHarness,
  token: string,
): Promise<AuthContext> {
  const row = (await query<{
    id: string;
    principal_id: string;
    principal_type: "human_user" | "agent_user";
    human_user_id: string;
    credential_kind:
      | "human_full"
      | "authorization_request"
      | "agent_authorization";
    authorization_id: string | null;
  }>(
    harness.server.sql,
    `select s.id,s.principal_id,p.type principal_type,s.human_user_id,
            s.credential_kind,s.authorization_id
       from auth_sessions s join principals p on p.id=s.principal_id
      where s.token_digest=$1`,
    [await tokenDigest(token)],
  )).rows[0];
  return {
    id: uuidV7(),
    principalId: row.principal_id,
    principalType: row.principal_type,
    humanUserId: row.human_user_id,
    sessionId: row.id,
    ...(row.authorization_id ? { authorizationId: row.authorization_id } : {}),
    credentialKind: row.credential_kind,
    roles: [],
    createdAt: new Date().toISOString(),
  };
}
async function credentials(harness: LiveHarness): Promise<Credentials> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "optd", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
