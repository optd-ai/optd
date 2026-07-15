import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import type { Sql } from "../../src/adapters/outbound/postgres/client.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";
import { opaqueToken, tokenDigest } from "../../src/domain/auth/token.ts";
import { type LiveHarness, startLiveHarness } from "../support/live_harness.ts";

type StoredAuth = {
  token?: string;
  requestToken?: string;
  authorizationNonces?: Record<string, string>;
};

Deno.test("authorization decisions serialize approve, deny, cancel, and duplicate approve", async () => {
  const harness = await startLiveHarness();
  try {
    await bootstrap(harness, "decision-race");
    const credentials = await storedAuth(harness);

    const approveWins = await createRequest(harness, "approve beats deny");
    const [approved, denied] = await raceRequestRow(
      harness.server.sql,
      approveWins,
      [
        () => decide(harness, credentials.token!, approveWins, "approved"),
        () =>
          decide(
            harness,
            credentials.token!,
            approveWins,
            "denied",
            "too broad",
          ),
      ],
    );
    assertEquals(approved.status, 200);
    assertEquals(denied.status, 409);
    assertEquals((await denied.json()).error.code, "request_already_decided");
    assertEquals(
      JSON.stringify(await approved.json()).includes("token"),
      false,
    );
    await assertTerminalFacts(harness, approveWins, "approved", 1);

    const cancelWins = await createRequest(harness, "cancel beats approve");
    const [cancelled, lateApprove] = await raceRequestRow(
      harness.server.sql,
      cancelWins,
      [
        () =>
          post(
            harness,
            credentials.requestToken!,
            `/api/v1/auth/requests/${cancelWins}/cancel`,
            {},
          ),
        () => decide(harness, credentials.token!, cancelWins, "approved"),
      ],
    );
    assertEquals(cancelled.status, 200);
    assertEquals(lateApprove.status, 409);
    assertEquals(
      (await lateApprove.json()).error.code,
      "request_already_decided",
    );
    await assertTerminalFacts(harness, cancelWins, "cancelled", 0);

    const duplicate = await createRequest(harness, "duplicate approval");
    const [first, second] = await raceRequestRow(
      harness.server.sql,
      duplicate,
      [
        () => decide(harness, credentials.token!, duplicate, "approved"),
        () => decide(harness, credentials.token!, duplicate, "approved"),
      ],
    );
    assertEquals([first.status, second.status], [200, 200]);
    assertEquals(JSON.stringify(await first.json()).includes("token"), false);
    assertEquals(JSON.stringify(await second.json()).includes("token"), false);
    await assertTerminalFacts(harness, duplicate, "approved", 1);
  } finally {
    await harness.close();
  }
});

Deno.test("concurrent replacement preserves parent/root and upstream role filtering uses current authority", async () => {
  const harness = await startLiveHarness();
  try {
    await bootstrap(harness, "lineage-race");
    const human = await storedAuth(harness);
    const parentRequest = await createRequest(harness, "parent authorization");
    assertEquals(
      (await decide(harness, human.token!, parentRequest, "approved")).status,
      200,
    );
    const parentNonce =
      (await storedAuth(harness)).authorizationNonces![parentRequest];
    const parentRedemption = await post(
      harness,
      human.requestToken!,
      `/api/v1/auth/requests/${parentRequest}/redeem`,
      { redemption_nonce: parentNonce },
    );
    const parentToken = (await parentRedemption.json()).data.token as string;
    const parentId = (await query<{ authorization_id: string }>(
      harness.server.sql,
      `select authorization_id from agent_authorization_requests where id=$1`,
      [parentRequest],
    )).rows[0]!.authorization_id;

    const childNonce = opaqueToken();
    const childCreated = await postRequest(
      harness,
      human.requestToken!,
      "child authorization",
      childNonce,
    );
    const childId = (await childCreated.json()).data.id as string;
    assertEquals(
      (await decide(harness, parentToken, childId, "approved")).status,
      200,
    );
    const childRedemption = await post(
      harness,
      human.requestToken!,
      `/api/v1/auth/requests/${childId}/redeem`,
      { redemption_nonce: childNonce },
    );
    const childToken = (await childRedemption.json()).data.token as string;
    const childLineage = (await query<
      { parent_authorization_id: string; root_authorization_id: string }
    >(
      harness.server.sql,
      `select parent_authorization_id,root_authorization_id from agent_authorizations where id=(select authorization_id from agent_authorization_requests where id=$1)`,
      [childId],
    )).rows[0]!;
    assertEquals(childLineage, {
      parent_authorization_id: parentId,
      root_authorization_id: parentId,
    });

    const replacementNonce = opaqueToken();
    const replacementCreated = await postRequest(
      harness,
      parentToken,
      "concurrent parent replacement",
      replacementNonce,
      "system:admin",
    );
    const replacementRequestId = (await replacementCreated.json()).data
      .id as string;
    const [firstApproval, duplicateApproval] = await raceRequestRow(
      harness.server.sql,
      replacementRequestId,
      [
        () => decide(harness, parentToken, replacementRequestId, "approved"),
        () => decide(harness, parentToken, replacementRequestId, "approved"),
      ],
    );
    assertEquals([firstApproval.status, duplicateApproval.status], [200, 200]);
    const replacementId = (await query<{ authorization_id: string }>(
      harness.server.sql,
      `select authorization_id from agent_authorization_requests where id=$1`,
      [replacementRequestId],
    )).rows[0]!.authorization_id;
    const replacementLineage = (await query<
      {
        parent_authorization_id: string | null;
        root_authorization_id: string;
      }
    >(
      harness.server.sql,
      `select parent_authorization_id,root_authorization_id from agent_authorizations where id=$1`,
      [replacementId],
    )).rows[0]!;
    assertEquals(replacementLineage, {
      parent_authorization_id: null,
      root_authorization_id: parentId,
    });
    const replacementCount = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from agent_authorizations where id=$1`,
      [replacementId],
    )).rows[0]!.count;
    assertEquals(replacementCount, 1);
    const replacementRedeemed = await post(
      harness,
      parentToken,
      `/api/v1/auth/requests/${replacementRequestId}/redeem`,
      { redemption_nonce: replacementNonce },
    );
    assertEquals(replacementRedeemed.status, 200);

    assertEquals(
      (await get(harness, childToken, "/api/v1/projects")).status,
      200,
    );
    await query(
      harness.server.sql,
      `delete from agent_authorization_roles where authorization_id=$1 and role_id='system:super_admin'`,
      [replacementId],
    );
    const filtered = await get(harness, childToken, "/api/v1/projects");
    assertEquals(filtered.status, 403);
    assertEquals(
      (await filtered.json()).error.code,
      "authorization_insufficient",
    );
    const latestContext = (await query<{ roles: string[] }>(
      harness.server.sql,
      `select roles from auth_contexts where session_id=(select id from auth_sessions where token_digest=$1) order by created_at desc limit 1`,
      [await tokenDigest(childToken)],
    )).rows[0]!;
    assertEquals(latestContext.roles.includes("system:super_admin"), false);
  } finally {
    await harness.close();
  }
});

Deno.test("redemption serializes with revoke and remint leaves one active session", async () => {
  const harness = await startLiveHarness();
  try {
    await bootstrap(harness, "redemption-race");
    const credentials = await storedAuth(harness);
    const requestId = await createRequest(harness, "redemption race");
    assertEquals(
      (await decide(harness, credentials.token!, requestId, "approved")).status,
      200,
    );
    const authorizationId = (await query<{ authorization_id: string }>(
      harness.server.sql,
      `select authorization_id from agent_authorization_requests where id=$1`,
      [requestId],
    )).rows[0]!.authorization_id;
    const nonce = (await storedAuth(harness)).authorizationNonces![requestId];

    const [redeemed, revoked] = await raceAuthorizationRow(
      harness.server.sql,
      authorizationId,
      [
        () =>
          post(
            harness,
            credentials.requestToken!,
            `/api/v1/auth/requests/${requestId}/redeem`,
            { redemption_nonce: nonce },
          ),
        () =>
          post(
            harness,
            credentials.token!,
            `/api/v1/auth/authorizations/${authorizationId}/revoke`,
            {},
          ),
      ],
    );
    assertEquals(redeemed.status, 200);
    const firstToken = (await redeemed.json()).data.token as string;
    assertEquals(revoked.status, 200);
    assertEquals(
      (await bearerGet(harness, firstToken, "/api/v1/auth/me")).status,
      401,
    );
    await assertNoActiveAuthority(harness, authorizationId);

    const revokeFirstRequest = await createRequest(
      harness,
      "revoke beats redemption",
    );
    assertEquals(
      (await decide(
        harness,
        credentials.token!,
        revokeFirstRequest,
        "approved",
      )).status,
      200,
    );
    const revokeFirstAuthorization = (await query<{ authorization_id: string }>(
      harness.server.sql,
      `select authorization_id from agent_authorization_requests where id=$1`,
      [revokeFirstRequest],
    )).rows[0]!.authorization_id;
    const revokeFirstNonce =
      (await storedAuth(harness)).authorizationNonces![revokeFirstRequest];
    const [earlyRevoke, lateRedemption] = await raceAuthorizationRow(
      harness.server.sql,
      revokeFirstAuthorization,
      [
        () =>
          post(
            harness,
            credentials.token!,
            `/api/v1/auth/authorizations/${revokeFirstAuthorization}/revoke`,
            {},
          ),
        () =>
          post(
            harness,
            credentials.requestToken!,
            `/api/v1/auth/requests/${revokeFirstRequest}/redeem`,
            { redemption_nonce: revokeFirstNonce },
          ),
      ],
    );
    assertEquals(earlyRevoke.status, 200);
    assertEquals(lateRedemption.status, 409);
    assertEquals(
      (await lateRedemption.json()).error.code,
      "request_invalidated",
    );
    await assertNoActiveAuthority(harness, revokeFirstAuthorization);

    const replayRequest = await createRequest(
      harness,
      "single active redemption",
    );
    assertEquals(
      (await decide(harness, credentials.token!, replayRequest, "approved"))
        .status,
      200,
    );
    const replayNonce =
      (await storedAuth(harness)).authorizationNonces![replayRequest];
    const first = await post(
      harness,
      credentials.requestToken!,
      `/api/v1/auth/requests/${replayRequest}/redeem`,
      { redemption_nonce: replayNonce },
    );
    assertEquals(first.status, 200);
    const firstBearer = (await first.json()).data.token as string;
    const wrongRequester = await post(
      harness,
      credentials.token!,
      `/api/v1/auth/requests/${replayRequest}/redeem`,
      { redemption_nonce: replayNonce },
    );
    assertEquals(wrongRequester.status, 401);
    assertEquals(
      (await wrongRequester.json()).error.code,
      "redemption_invalid",
    );
    const reminted = await post(
      harness,
      credentials.requestToken!,
      `/api/v1/auth/requests/${replayRequest}/redeem`,
      { redemption_nonce: replayNonce },
    );
    assertEquals(reminted.status, 200);
    const secondBearer = (await reminted.json()).data.token as string;
    assertEquals(
      (await bearerGet(harness, firstBearer, "/api/v1/auth/me")).status,
      401,
    );
    assertEquals(
      (await bearerGet(harness, secondBearer, "/api/v1/auth/me")).status,
      200,
    );
    const active = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from auth_sessions where authorization_id=(select authorization_id from agent_authorization_requests where id=$1) and revoked_at is null`,
      [replayRequest],
    )).rows[0]!.count;
    assertEquals(active, 1);
  } finally {
    await harness.close();
  }
});

async function bootstrap(harness: LiveHarness, username: string) {
  const result = await harness.bootstrap({
    username,
    password: "authorization race password",
  });
  assertEquals(result.code, 0, result.stderr);
}
async function storedAuth(harness: LiveHarness): Promise<StoredAuth> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "operant", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
async function createRequest(
  harness: LiveHarness,
  reason: string,
): Promise<string> {
  const result = await harness.runOptctl([
    "--json",
    "auth",
    "request",
    "--role",
    "system:super_admin",
    "--boundary",
    "system",
    "--reason",
    reason,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.id;
}
function post(
  harness: LiveHarness,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
function decide(
  harness: LiveHarness,
  token: string,
  id: string,
  decision: "approved" | "denied",
  reason?: string,
): Promise<Response> {
  return post(harness, token, `/api/v1/auth/requests/${id}/decision`, {
    decision,
    ...(reason ? { reason } : {}),
  });
}
function bearerGet(
  harness: LiveHarness,
  token: string,
  path: string,
): Promise<Response> {
  return fetch(`${harness.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
function get(
  harness: LiveHarness,
  token: string,
  path: string,
): Promise<Response> {
  return bearerGet(harness, token, path);
}
async function postRequest(
  harness: LiveHarness,
  token: string,
  reason: string,
  nonce: string,
  role = "system:super_admin",
): Promise<Response> {
  return fetch(`${harness.baseUrl}/api/v1/auth/requests`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": opaqueToken(),
    },
    body: JSON.stringify({
      roles: [role],
      boundary: { type: "system" },
      reason,
      redemption_nonce_hash: await tokenDigest(nonce),
    }),
  });
}
async function raceRequestRow(
  sql: Sql,
  id: string,
  actions: [() => Promise<Response>, () => Promise<Response>],
) {
  return await raceLocked(
    sql,
    `select * from agent_authorization_requests where id=$1 for update`,
    id,
    actions,
  );
}
async function raceAuthorizationRow(
  sql: Sql,
  id: string,
  actions: [() => Promise<Response>, () => Promise<Response>],
) {
  return await raceLocked(
    sql,
    `select * from agent_authorizations where id=$1 for update`,
    id,
    actions,
  );
}
async function raceLocked(
  sql: Sql,
  lockSql: string,
  id: string,
  actions: [() => Promise<Response>, () => Promise<Response>],
): Promise<[Response, Response]> {
  let unlock!: () => void;
  let locked!: () => void;
  const lockedPromise = new Promise<void>((resolve) => locked = resolve);
  const unlockPromise = new Promise<void>((resolve) => unlock = resolve);
  const locker = sql.begin(async (tx) => {
    await query(tx, lockSql, [id]);
    locked();
    await unlockPromise;
  });
  await lockedPromise;
  const first = actions[0]();
  await waitForLockWaiters(sql, 1);
  const second = actions[1]();
  await waitForLockWaiters(sql, 2);
  unlock();
  await locker;
  return [await first, await second];
}
async function waitForLockWaiters(sql: Sql, minimum: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const count = (await query<{ count: number }>(
      sql,
      `select count(*)::int count from pg_stat_activity where wait_event_type='Lock' and query ilike '%agent_authorization%'`,
    )).rows[0]!.count;
    if (count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for ${minimum} authorization lock waiters`,
  );
}
async function assertTerminalFacts(
  harness: LiveHarness,
  id: string,
  status: string,
  authorizationCount: number,
) {
  const row = (await query<
    { status: string; version: number; decision_snapshot: unknown }
  >(
    harness.server.sql,
    `select status,version,decision_snapshot from agent_authorization_requests where id=$1`,
    [id],
  )).rows[0]!;
  assertEquals(row.status, status);
  assertEquals(Number(row.version), 2);
  assertExists(row.decision_snapshot);
  const authorizations = (await query<{ count: number }>(
    harness.server.sql,
    `select count(*)::int count from agent_authorizations where id=(select authorization_id from agent_authorization_requests where id=$1)`,
    [id],
  )).rows[0]!.count;
  assertEquals(authorizations, authorizationCount);
  const audits = (await query<{ count: number }>(
    harness.server.sql,
    `select count(*)::int count from auth_audit_events where event_type=$2 and auth_context_id=(select decided_by_auth_context_id from agent_authorization_requests where id=$1)`,
    [id, `auth.authorization_request.${status}`],
  )).rows[0]!.count;
  assertEquals(audits, 1);
  if (audits) {
    await assertRejects(() =>
      query(
        harness.server.sql,
        `update auth_audit_events set details='{}' where auth_context_id=(select decided_by_auth_context_id from agent_authorization_requests where id=$1) and event_type=$2`,
        [id, `auth.authorization_request.${status}`],
      )
    );
  }
}
async function assertNoActiveAuthority(
  harness: LiveHarness,
  authorizationId: string,
) {
  const row =
    (await query<{ active_authorizations: number; active_sessions: number }>(
      harness.server.sql,
      `select count(*) filter(where revoked_at is null)::int active_authorizations,(select count(*)::int from auth_sessions where authorization_id=$1 and revoked_at is null) active_sessions from agent_authorizations where id=$1`,
      [authorizationId],
    )).rows[0]!;
  assertEquals(row, { active_authorizations: 0, active_sessions: 0 });
}
