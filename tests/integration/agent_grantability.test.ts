import { assertEquals, assertExists } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { type LiveHarness, startLiveHarness } from "../support/live_harness.ts";

type Credentials = { token: string; requestToken: string };

Deno.test("Postgres grantability revalidates policy, roles, boundary, anchor, and revocation", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "root-admin",
        password: "grantability root password",
      })).code,
      0,
    );
    const root = await credentials(harness);
    const created = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "policy-decider",
      "--password-stdin",
    ], "policy decider password\n");
    assertEquals(created.code, 0, created.stderr);
    const decider = (await query<{ id: string; principal_id: string }>(
      harness.server.sql,
      `select id,principal_id from human_users where username='policy-decider'`,
    )).rows[0]!;
    await query(
      harness.server.sql,
      `insert into role_assignments(id,principal_id,role_id,boundary_type,active) values($1,$2,'system:admin','system',true)`,
      [uuidV7(), decider.principal_id],
    );
    const policy = await seedDecidePolicy(harness, "system");
    const login = await harness.login({
      username: "policy-decider",
      password: "policy decider password",
    });
    assertEquals(login.code, 0, login.stderr);
    const actor = await credentials(harness);

    const approvedId = await request(harness, "policy approved");
    const approved = await decide(harness, actor.token, approvedId, "approved");
    assertEquals(approved.status, 200);
    assertEquals(JSON.stringify(approved.body).includes("token"), false);
    const rawSnapshot =
      (await query<{ decision_snapshot: Record<string, unknown> | string }>(
        harness.server.sql,
        `select decision_snapshot from agent_authorization_requests where id=$1`,
        [approvedId],
      )).rows[0]!.decision_snapshot;
    const snapshot = typeof rawSnapshot === "string"
      ? JSON.parse(rawSnapshot) as Record<string, unknown>
      : rawSnapshot;
    assertExists(snapshot.capability_summary_digest);
    assertEquals((snapshot.role_definition_versions as unknown[]).length, 1);
    assertEquals((snapshot.policy_definition_versions as unknown[]).length, 1);

    const denyWithoutRole = await request(
      harness,
      "deny without requested role",
    );
    await query(
      harness.server.sql,
      `update agent_authorization_requests set roles=array['system:super_admin'] where id=$1`,
      [denyWithoutRole],
    );
    assertEquals(
      (await decide(
        harness,
        actor.token,
        denyWithoutRole,
        "denied",
        "not appropriate",
      )).status,
      200,
    );

    const missingRole = await request(harness, "missing requested role");
    await query(
      harness.server.sql,
      `update agent_authorization_requests set roles=array['system:super_admin'] where id=$1`,
      [missingRole],
    );
    const missing = await decide(harness, actor.token, missingRole, "approved");
    assertEquals(missing.status, 403);
    assertEquals(missing.body.error.code, "authorization_insufficient");

    const wrongBoundary = await request(harness, "wrong boundary");
    await query(
      harness.server.sql,
      `update agent_authorization_requests set boundary_type='all_projects' where id=$1`,
      [wrongBoundary],
    );
    const boundaryDenied = await decide(
      harness,
      actor.token,
      wrongBoundary,
      "denied",
      "wrong boundary",
    );
    assertEquals(boundaryDenied.status, 403);
    assertEquals(boundaryDenied.body.error.code, "authorization_insufficient");

    const wrongHuman = await request(harness, "wrong human anchor");
    const rootHuman = (await query<{ id: string }>(
      harness.server.sql,
      `select id from human_users where username='root-admin'`,
    )).rows[0]!.id;
    await query(
      harness.server.sql,
      `update agent_authorization_requests set human_user_id=$2 where id=$1`,
      [wrongHuman, rootHuman],
    );
    const anchorDenied = await decide(
      harness,
      actor.token,
      wrongHuman,
      "denied",
      "wrong anchor",
    );
    assertEquals(anchorDenied.status, 404);
    assertEquals(anchorDenied.body.error.code, "not_found");

    const disabled = await request(harness, "disabled assignment");
    await query(
      harness.server.sql,
      `update policy_assignments set active=false,disabled_at=now() where id=$1`,
      [policy.assignmentId],
    );
    const disabledResult = await decide(
      harness,
      actor.token,
      disabled,
      "denied",
      "disabled",
    );
    assertEquals(disabledResult.status, 403);
    assertEquals(disabledResult.body.error.code, "authorization_insufficient");

    await query(
      harness.server.sql,
      `update policy_assignments set active=true,disabled_at=null where id=$1`,
      [policy.assignmentId],
    );
    const raced = await request(harness, "concurrent revocation");
    let release!: () => void;
    let locked!: () => void;
    const releasePromise = new Promise<void>((resolve) => release = resolve);
    const lockedPromise = new Promise<void>((resolve) => locked = resolve);
    const blocker = harness.server.sql.begin(async (tx) => {
      await query(
        tx,
        `select * from policy_assignments where id=$1 for update`,
        [policy.assignmentId],
      );
      locked();
      await releasePromise;
    });
    await lockedPromise;
    const revoke = query(
      harness.server.sql,
      `update policy_assignments set active=false,disabled_at=now() where id=$1`,
      [policy.assignmentId],
    );
    await waitForPolicyLock(harness, 1);
    const concurrentDecision = decide(harness, actor.token, raced, "approved");
    await waitForPolicyLock(harness, 2);
    release();
    await blocker;
    await revoke;
    const revokedResult = await concurrentDecision;
    assertEquals(revokedResult.status, 403);
    assertEquals(revokedResult.body.error.code, "authorization_insufficient");
    const terminal =
      (await query<{ status: string; authorization_id: string | null }>(
        harness.server.sql,
        `select status,authorization_id from agent_authorization_requests where id=$1`,
        [raced],
      )).rows[0]!;
    assertEquals(terminal, { status: "pending", authorization_id: null });

    await selectCredentials(harness, root);
    const bypassId = await request(
      harness,
      "super admin bypass",
      "system:super_admin",
    );
    const bypass = await decide(harness, root.token, bypassId, "approved");
    assertEquals(bypass.status, 200);
  } finally {
    await harness.close();
  }
});

async function seedDecidePolicy(
  harness: LiveHarness,
  boundary: "system" | "all_projects",
) {
  const versionId = uuidV7();
  const assignmentId = uuidV7();
  await query(
    harness.server.sql,
    `insert into policy_definition_versions(id,policy_id,version,active) values($1,'system:auth_request_decider',1,true)`,
    [versionId],
  );
  await query(
    harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability) values($1,$2,'system:admin','auth.request.decide')`,
    [uuidV7(), versionId],
  );
  await query(
    harness.server.sql,
    `insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,$3,true)`,
    [assignmentId, versionId, boundary],
  );
  return { versionId, assignmentId };
}
async function request(
  harness: LiveHarness,
  reason: string,
  role = "system:admin",
) {
  const result = await harness.runOptctl([
    "--json",
    "auth",
    "request",
    "--role",
    role,
    "--boundary",
    "system",
    "--reason",
    reason,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.id as string;
}
async function decide(
  harness: LiveHarness,
  token: string,
  id: string,
  decision: "approved" | "denied",
  reason?: string,
) {
  const response = await fetch(
    `${harness.baseUrl}/api/v1/auth/requests/${id}/decision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision, ...(reason ? { reason } : {}) }),
    },
  );
  return { status: response.status, body: await response.json() };
}
async function credentials(harness: LiveHarness): Promise<Credentials> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "operant", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
async function selectCredentials(harness: LiveHarness, selected: Credentials) {
  const path = join(harness.rootDir, "xdg-config", "operant", "auth.json");
  const store = JSON.parse(await Deno.readTextFile(path));
  store.origins[new URL(harness.baseUrl).origin] = {
    ...store.origins[new URL(harness.baseUrl).origin],
    ...selected,
  };
  await Deno.writeTextFile(path, JSON.stringify(store));
}
async function waitForPolicyLock(harness: LiveHarness, minimum: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from pg_stat_activity where wait_event_type='Lock' and query ilike '%policy_assignments%'`,
    )).rows[0]!.count;
    if (count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for ${minimum} policy assignment lock waiters`,
  );
}
