import { assertEquals, assertFalse } from "jsr:@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";

Deno.test("destructive confirmations share serialized login throttling", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "destructive-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const originalRequest = await query<{ id: string }>(
      harness.server.sql,
      `select id from auth_sessions where human_user_id=(select id from human_users where username='destructive-admin') and credential_kind='authorization_request' and revoked_at is null`,
    );
    const rotatedLogin = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "destructive-admin",
        password: "administrator password",
        existing_request_session_id: crypto.randomUUID(),
      }),
    });
    const rotatedBody = await rotatedLogin.json();
    assertEquals(rotatedLogin.status, 200);
    assertFalse(
      rotatedBody.data.credentials.authorization_request_session_id ===
        originalRequest.rows[0].id,
    );
    const boundedRequests = await query<
      { active: string; old_revoked: boolean }
    >(
      harness.server.sql,
      `select count(*) filter(where revoked_at is null)::text active,bool_and(case when id=$2 then revoked_at is not null else true end) old_revoked from auth_sessions where human_user_id=(select id from human_users where username=$1) and credential_kind='authorization_request'`,
      ["destructive-admin", originalRequest.rows[0].id],
    );
    assertEquals(boundedRequests.rows[0]?.active, "1");
    assertEquals(boundedRequests.rows[0]?.old_revoked, true);
    const rotatedLogout = await fetch(`${harness.baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${rotatedBody.data.credentials.token}`,
      },
      body: "{}",
    });
    await rotatedLogout.body?.cancel();
    assertEquals(rotatedLogout.status, 200);
    const failures = await harness.runConcurrent([
      {
        args: [
          "--json",
          "auth",
          "logout",
          "--all",
          "--yes",
          "--password-stdin",
        ],
        stdin: "wrong password one\n",
      },
      {
        args: [
          "--json",
          "auth",
          "logout",
          "--all",
          "--yes",
          "--password-stdin",
        ],
        stdin: "wrong password two\n",
      },
      {
        args: ["--json", "auth", "password", "change", "--password-stdin"],
        stdin: "wrong password three\nunused replacement password\n",
      },
      {
        args: ["--json", "auth", "password", "change", "--password-stdin"],
        stdin: "wrong password four\nunused replacement password\n",
      },
    ]);
    assertEquals(failures.every((result) => result.code === 1), true);
    const throttle = await query<{ failure_count: number }>(
      harness.server.sql,
      `select failure_count from login_throttles where username='destructive-admin'`,
    );
    assertEquals(throttle.rows[0]?.failure_count, 4);
    const fifth = await harness.runOptctl([
      "--json",
      "auth",
      "password",
      "change",
      "--password-stdin",
    ], "wrong password five\nunused replacement password\n");
    assertEquals(JSON.parse(fifth.stderr).error.code, "login_invalid");
    const blocked = await harness.runOptctl([
      "--json",
      "auth",
      "logout",
      "--all",
      "--yes",
      "--password-stdin",
    ], "administrator password\n");
    assertEquals(JSON.parse(blocked.stderr).error.code, "login_throttled");
    const active = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where human_user_id=(select id from human_users where username='destructive-admin') and revoked_at is null`,
    );
    assertEquals(active.rows[0]?.count, "2");
  } finally {
    await harness.close();
  }
});

Deno.test("reset decisions redemption completion and anchored revocation serialize", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "race-admin",
        password: "administrator password",
      })).code,
      0,
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "user",
        "create",
        "--username",
        "race-user",
        "--password-stdin",
      ], "original race password\n")).code,
      0,
    );
    assertEquals(
      (await harness.login({
        username: "race-user",
        password: "original race password",
      })).code,
      0,
    );
    const oldSessions = await query<{ id: string }>(
      harness.server.sql,
      `select id from auth_sessions where human_user_id=(select id from human_users where username='race-user') and revoked_at is null`,
    );
    assertEquals(oldSessions.rows.length, 2);
    assertEquals(
      (await harness.login({
        username: "race-admin",
        password: "administrator password",
      })).code,
      0,
    );

    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "race-user",
    ]);
    const requestId = JSON.parse(requested.stdout).data.request_id;
    const nonce = await resetNonce(harness.rootDir, harness.baseUrl, requestId);
    const decisions = await harness.runConcurrent([
      { args: ["--json", "auth", "password-reset", "approve", requestId] },
      { args: ["--json", "auth", "password-reset", "approve", requestId] },
    ]);
    assertEquals(decisions.every((result) => result.code === 0), true);

    const redeem = () =>
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/redeem`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redemption_nonce: nonce }),
        },
      );
    const redemptionResponses = await Promise.all([redeem(), redeem()]);
    const redemptionBodies = await Promise.all(
      redemptionResponses.map((response) => response.json()),
    );
    assertEquals(
      redemptionResponses.every((response) => response.status === 200),
      true,
    );
    const capabilities = redemptionBodies.map((body) =>
      body.data.capability as string
    );

    const invalid = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability: "invalid-capability",
          password: "replacement race password",
        }),
      },
    );
    await invalid.body?.cancel();
    assertEquals(invalid.status, 401);
    const beforeCompletion = await query<{ count: string }>(
      harness.server.sql,
      `select count(*)::text count from auth_sessions where id=any($1::uuid[]) and revoked_at is null`,
      [oldSessions.rows.map((row) => row.id)],
    );
    assertEquals(beforeCompletion.rows[0]?.count, "2");

    const complete = (capability: string, suffix: string) =>
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            capability,
            password: `replacement race password ${suffix}`,
          }),
        },
      );
    const completionResponses = await Promise.all([
      complete(capabilities[0], "one"),
      complete(capabilities[1], "two"),
    ]);
    await Promise.all(
      completionResponses.map((response) => response.body?.cancel()),
    );
    assertEquals(
      completionResponses.filter((response) => response.status === 200).length,
      1,
    );
    const finalSessions = await query<{ active: string; old_active: string }>(
      harness.server.sql,
      `select count(*) filter(where revoked_at is null)::text active,count(*) filter(where id=any($2::uuid[]) and revoked_at is null)::text old_active from auth_sessions where human_user_id=(select id from human_users where username=$1)`,
      ["race-user", oldSessions.rows.map((row) => row.id)],
    );
    assertEquals(finalSessions.rows[0]?.active, "2");
    assertEquals(finalSessions.rows[0]?.old_active, "0");

    const second = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "race-user",
    ]);
    const secondId = JSON.parse(second.stdout).data.request_id;
    const secondNonce = await resetNonce(
      harness.rootDir,
      harness.baseUrl,
      secondId,
    );
    const [approval, cancellation] = await Promise.all([
      harness.runOptctl([
        "--json",
        "auth",
        "password-reset",
        "approve",
        secondId,
      ]),
      fetch(
        `${harness.baseUrl}/api/v1/auth/password-reset/requests/${secondId}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redemption_nonce: secondNonce }),
        },
      ),
    ]);
    await cancellation.body?.cancel();
    assertEquals(
      Number(approval.code === 0) + Number(cancellation.status === 200),
      1,
    );
    const terminal = await query<{ status: string }>(
      harness.server.sql,
      `select status from password_reset_requests where id=$1`,
      [secondId],
    );
    assertEquals(
      ["approved", "cancelled"].includes(terminal.rows[0]?.status),
      true,
    );
  } finally {
    await harness.close();
  }
});

Deno.test("reset completion rejects capabilities after request expiry", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "expiry-admin",
        password: "administrator password",
      })).code,
      0,
    );
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "password-reset",
      "request",
      "--username",
      "expiry-admin",
    ]);
    const requestId = JSON.parse(requested.stdout).data.request_id;
    const nonce = await resetNonce(harness.rootDir, harness.baseUrl, requestId);
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "password-reset",
        "approve",
        requestId,
      ])).code,
      0,
    );
    const redeemed = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/redeem`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemption_nonce: nonce }),
      },
    );
    const capability = (await redeemed.json()).data.capability;
    await query(
      harness.server.sql,
      `update password_reset_requests set expires_at=now()-interval '1 second' where id=$1`,
      [requestId],
    );
    const completion = await fetch(
      `${harness.baseUrl}/api/v1/auth/password-reset/requests/${requestId}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          capability,
          password: "expired replacement password",
        }),
      },
    );
    const body = await completion.json();
    assertEquals(completion.status, 410);
    assertEquals(body.error.code, "password_reset_expired");
    const state = await query<{ status: string }>(
      harness.server.sql,
      `select status from password_reset_requests where id=$1`,
      [requestId],
    );
    assertEquals(state.rows[0]?.status, "expired");
  } finally {
    await harness.close();
  }
});

async function resetNonce(
  rootDir: string,
  baseUrl: string,
  requestId: string,
): Promise<string> {
  const store = JSON.parse(
    await Deno.readTextFile(`${rootDir}/xdg-config/operant/auth.json`),
  );
  const nonce = store.origins[new URL(baseUrl).origin].resetNonces[requestId];
  assertFalse(typeof nonce !== "string");
  return nonce;
}
