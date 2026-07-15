import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { startLiveHarness } from "../../support/live_harness.ts";

Deno.test("compiled auth wait reconnects after interruption without polling and redeems requester-bound authority", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "wait-admin",
      password: "interrupted websocket password",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const request = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "interrupted wait",
    ]);
    assertEquals(request.code, 0, request.stderr);
    const requestId = JSON.parse(request.stdout).data.id as string;
    const state = await storedState(harness.rootDir, harness.baseUrl);

    const ticketResponse = await post(
      harness.baseUrl,
      state.requestToken,
      `/api/v1/auth/requests/${requestId}/watch-ticket`,
      {},
    );
    assertEquals(ticketResponse.status, 200);
    const ticket = (await ticketResponse.json()).data.ticket as string;
    const socketUrl = new URL(
      `${harness.baseUrl}/api/v1/auth/requests/${requestId}/watch`,
    );
    socketUrl.protocol = "ws:";
    socketUrl.searchParams.set("ticket", ticket);
    const pending = await openUntilMessage(socketUrl);
    assertEquals(pending.status, "pending");

    await harness.restart();
    const approval = await post(
      harness.baseUrl,
      state.token,
      `/api/v1/auth/requests/${requestId}/decision`,
      { decision: "approved" },
    );
    assertEquals(approval.status, 200);
    assertEquals(
      JSON.stringify(await approval.json()).includes("token"),
      false,
    );
    const contextsBefore = await requestContextCount(
      harness.server.sql,
      state.requestSessionId,
    );

    const waited = await harness.runOptctl([
      "--json",
      "auth",
      "wait",
      requestId,
    ]);
    assertEquals(waited.code, 0, waited.stderr);
    const agentToken =
      (await storedState(harness.rootDir, harness.baseUrl)).token;
    assertEquals(
      (await get(harness.baseUrl, agentToken, "/api/v1/auth/me")).status,
      200,
    );
    const contextsAfter = await requestContextCount(
      harness.server.sql,
      state.requestSessionId,
    );
    assertEquals(
      contextsAfter - contextsBefore,
      2,
      "wait performs one ticket exchange and one redemption; no authenticated polling",
    );
    const tickets = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from agent_authorization_watch_tickets where request_id=$1`,
      [requestId],
    )).rows[0]!.count;
    assertEquals(tickets, 2);

    const nonce = state.authorizationNonces[requestId];
    const wrongRequester = await post(
      harness.baseUrl,
      state.token,
      `/api/v1/auth/requests/${requestId}/redeem`,
      { redemption_nonce: nonce },
    );
    assertEquals(wrongRequester.status, 401);
    assertEquals(
      (await wrongRequester.json()).error.code,
      "redemption_invalid",
    );
    const replay = await post(
      harness.baseUrl,
      state.requestToken,
      `/api/v1/auth/requests/${requestId}/redeem`,
      { redemption_nonce: nonce },
    );
    assertEquals(replay.status, 200);
    const remintedToken = (await replay.json()).data.token as string;
    assertEquals(
      (await get(harness.baseUrl, agentToken, "/api/v1/auth/me")).status,
      401,
      "replayed delivery cannot reuse the prior bearer",
    );
    assertEquals(
      (await get(harness.baseUrl, remintedToken, "/api/v1/auth/me")).status,
      200,
    );
    const active = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from auth_sessions where authorization_id=(select authorization_id from agent_authorization_requests where id=$1) and revoked_at is null`,
      [requestId],
    )).rows[0]!.count;
    assertEquals(active, 1);
  } finally {
    await harness.close();
  }
});

type State = {
  token: string;
  requestToken: string;
  requestSessionId: string;
  authorizationNonces: Record<string, string>;
};
async function storedState(root: string, origin: string): Promise<State> {
  const store = JSON.parse(
    await Deno.readTextFile(join(root, "xdg-config", "operant", "auth.json")),
  );
  return store.origins[new URL(origin).origin];
}
function post(
  origin: string,
  token: string,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
function get(origin: string, token: string, path: string): Promise<Response> {
  return fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
async function openUntilMessage(url: URL): Promise<{ status: string }> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("websocket did not emit pending state"));
    }, 5_000);
    socket.onmessage = (event) => {
      clearTimeout(timeout);
      const message = JSON.parse(String(event.data));
      socket.close(1000, "intentional interruption");
      resolve(message);
    };
    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("websocket connection failed"));
    };
  });
}
async function requestContextCount(
  sql: Parameters<typeof query>[0],
  sessionId: string,
): Promise<number> {
  return (await query<{ count: number }>(
    sql,
    `select count(*)::int count from auth_contexts where session_id=$1`,
    [sessionId],
  )).rows[0]!.count;
}
