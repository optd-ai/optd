import {
  assert,
  assertEquals,
  assertExists,
  assertFalse,
} from "jsr:@std/assert@1";
import { createAuthPrototype } from "./auth-flow.ts";

type Json = Record<string, any>;

async function call(
  app: {
    request: (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => Response | Promise<Response>;
  },
  path: string,
  init: RequestInit = {},
) {
  const response = await app.request(`http://operant.test${path}`, init);
  return { status: response.status, body: await response.json() as Json };
}
function json(
  body: unknown,
  headers: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
async function sha(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(
    new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

Deno.test("complete public auth lifecycle", async () => {
  const prototype = await createAuthPrototype("bootstrap-strong-secret");
  const { app, state } = prototype;

  let result = await call(app, "/api/v1/auth/bootstrap/status");
  assertEquals(result.body.data.state, "bootstrap_required");

  result = await call(
    app,
    "/api/v1/auth/bootstrap",
    json(
      { username: "jordan", password: "initial-password-123" },
      { authorization: "Operant-Bootstrap wrong" },
    ),
  );
  assertEquals(result.status, 401);
  assertEquals(result.body.error.code, "bootstrap_credential_invalid");

  result = await call(
    app,
    "/api/v1/auth/bootstrap",
    json(
      { username: "jordan", password: "initial-password-123" },
      { authorization: "Operant-Bootstrap bootstrap-strong-secret" },
    ),
  );
  assertEquals(result.status, 201);
  const humanToken = result.body.data.human_session.token as string;
  const humanSessionId = result.body.data.human_session.id as string;
  const requestToken = result.body.data.request_credential.token as string;
  const requestSessionId = result.body.data.request_credential.id as string;

  result = await call(
    app,
    "/api/v1/auth/bootstrap",
    json(
      { username: "other", password: "another-password-123" },
      { authorization: "Operant-Bootstrap bootstrap-strong-secret" },
    ),
  );
  assertEquals(result.body.error.code, "bootstrap_already_completed");

  result = await call(
    app,
    "/api/v1/auth/login",
    json({ username: "jordan", password: "wrong-password" }),
  );
  assertEquals(result.body.error.code, "login_invalid");
  result = await call(
    app,
    "/api/v1/auth/login",
    json({
      username: "jordan",
      password: "initial-password-123",
      existing_request_session_id: requestSessionId,
    }),
  );
  assertEquals(result.body.data.request_credential, {
    status: "retained",
    id: requestSessionId,
  });
  const secondHumanToken = result.body.data.human_session.token as string;

  result = await call(
    app,
    "/api/v1/test/work",
    json({ project: "sales", required_role: "operant/crm:sales_manager" }),
  );
  assertEquals(result.body.error.code, "authentication_required");
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "sales", required_role: "operant/crm:sales_manager" },
      bearer(requestToken),
    ),
  );
  assertEquals(result.body.error.code, "authorization_insufficient");

  const nonce1 = "nonce-for-agent-request-1";
  const requestBody = {
    roles: ["operant/crm:sales_manager", "operant/crm:sales_rep"],
    boundary: { type: "project", project_id: "sales" },
    reason: "Need to qualify CRM leads",
    redemption_nonce_hash: await sha(nonce1),
    agent: { name: "crm-agent", harness: "pi", model: "test-model" },
  };
  const requestHeaders = {
    ...bearer(requestToken),
    "idempotency-key": "request-1",
  };
  result = await call(
    app,
    "/api/v1/auth/requests",
    json(requestBody, requestHeaders),
  );
  assertEquals(result.status, 201);
  const requestId1 = result.body.data.id as string;
  result = await call(
    app,
    "/api/v1/auth/requests",
    json(requestBody, requestHeaders),
  );
  assertEquals(result.body.data.id, requestId1);
  assertEquals(state.requests.size, 1);

  result = await call(
    app,
    `/api/v1/auth/requests/${requestId1}/decision`,
    json(
      { decision: "approved", agent_name: "crm-lead-agent" },
      bearer(humanToken),
    ),
  );
  assertEquals(result.body.data.status, "approved");
  assertEquals(result.body.data.token, undefined);

  result = await call(
    app,
    `/api/v1/auth/requests/${requestId1}/redeem`,
    json({ redemption_nonce: "wrong" }, bearer(requestToken)),
  );
  assertEquals(result.body.error.code, "redemption_invalid");
  result = await call(
    app,
    `/api/v1/auth/requests/${requestId1}/redeem`,
    json({ redemption_nonce: nonce1 }, bearer(requestToken)),
  );
  assertEquals(result.body.data.authorization.roles.length, 2);
  const agentToken1 = result.body.data.session.token as string;
  const authorization1 = result.body.data.authorization.id as string;

  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "sales", required_role: "operant/crm:sales_manager" },
      bearer(agentToken1),
    ),
  );
  assertEquals(result.body.data.worked, true);
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "delivery", required_role: "operant/projects:viewer" },
      bearer(agentToken1),
    ),
  );
  assertEquals(result.status, 403);
  assertEquals(result.body.error.code, "authorization_insufficient");
  assertEquals(result.body.error.details.suggestion, undefined);

  const nonce2 = "nonce-for-agent-request-2";
  result = await call(
    app,
    "/api/v1/auth/requests",
    json({
      roles: ["operant/projects:viewer"],
      boundary: { type: "project", project_id: "delivery" },
      reason: "Need to inspect delivery project",
      redemption_nonce_hash: await sha(nonce2),
      agent: { name: "crm-lead-agent" },
    }, { ...bearer(agentToken1), "idempotency-key": "request-2" }),
  );
  const requestId2 = result.body.data.id as string;
  result = await call(
    app,
    `/api/v1/auth/requests/${requestId2}/decision`,
    json({ decision: "approved" }, bearer(secondHumanToken)),
  );
  assertEquals(result.body.data.status, "approved");
  result = await call(
    app,
    `/api/v1/auth/requests/${requestId2}/redeem`,
    json({ redemption_nonce: nonce2 }, bearer(agentToken1)),
  );
  const agentToken2 = result.body.data.session.token as string;
  const authorization2 = result.body.data.authorization.id as string;
  assertEquals(result.body.data.authorization.roles.length, 3);
  assertEquals(result.body.data.supersedes, authorization1);

  result = await call(app, "/api/v1/auth/me", { headers: bearer(agentToken1) });
  assertEquals(result.body.error.code, "authorization_ancestor_invalid");
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "sales", required_role: "operant/crm:sales_manager" },
      bearer(agentToken2),
    ),
  );
  assertEquals(result.body.data.worked, true);
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "delivery", required_role: "operant/projects:viewer" },
      bearer(agentToken2),
    ),
  );
  assertEquals(result.body.data.worked, true);

  const childNonce = "nonce-for-child-agent";
  result = await call(
    app,
    "/api/v1/auth/requests",
    json({
      roles: ["operant/crm:sales_rep"],
      boundary: { type: "project", project_id: "sales" },
      reason: "Subagent needs sales rep authority",
      redemption_nonce_hash: await sha(childNonce),
      agent: { name: "crm-subagent" },
    }, { ...bearer(requestToken), "idempotency-key": "request-child" }),
  );
  const childRequestId = result.body.data.id as string;
  result = await call(
    app,
    `/api/v1/auth/requests/${childRequestId}/decision`,
    json({ decision: "approved" }, bearer(agentToken2)),
  );
  assertEquals(result.body.data.status, "approved");
  result = await call(
    app,
    `/api/v1/auth/requests/${childRequestId}/redeem`,
    json({ redemption_nonce: childNonce }, bearer(requestToken)),
  );
  const childToken = result.body.data.session.token as string;
  assertEquals(result.body.data.authorization.roles.length, 1);
  assertEquals(result.body.data.supersedes, undefined);
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "sales", required_role: "operant/crm:sales_rep" },
      bearer(childToken),
    ),
  );
  assertEquals(result.body.data.worked, true);
  result = await call(
    app,
    "/api/v1/test/work",
    json(
      { project: "sales", required_role: "operant/crm:sales_manager" },
      bearer(childToken),
    ),
  );
  assertEquals(result.body.error.code, "authorization_insufficient");

  const denialNonce = "nonce-for-denied-request";
  result = await call(
    app,
    "/api/v1/auth/requests",
    json({
      roles: ["system:super_admin"],
      boundary: { type: "system" },
      reason: "Try elevated work",
      redemption_nonce_hash: await sha(denialNonce),
      agent: { name: "crm-lead-agent" },
    }, { ...bearer(agentToken2), "idempotency-key": "request-denied" }),
  );
  const deniedRequestId = result.body.data.id as string;
  result = await call(
    app,
    `/api/v1/auth/requests/${deniedRequestId}/decision`,
    json(
      { decision: "denied", reason: "Stay within the assigned task" },
      bearer(secondHumanToken),
    ),
  );
  assertEquals(result.body.data.status, "denied");
  result = await call(
    app,
    `/api/v1/auth/requests/${deniedRequestId}/redeem`,
    json({ redemption_nonce: denialNonce }, bearer(agentToken2)),
  );
  assertEquals(result.body.error.code, "request_denied");
  assertEquals(
    result.body.error.details.reason,
    "Stay within the assigned task",
  );
  assertEquals(result.body.error.details.suggested_roles, undefined);

  result = await call(
    app,
    `/api/v1/auth/authorizations/${authorization2}/revoke`,
    json({}, bearer(agentToken2)),
  );
  assertEquals(result.body.data.revoked, authorization2);
  result = await call(app, "/api/v1/auth/me", { headers: bearer(agentToken2) });
  assertEquals(result.body.error.code, "credential_invalid");
  result = await call(app, "/api/v1/auth/me", { headers: bearer(childToken) });
  assertEquals(result.body.error.code, "authorization_ancestor_invalid");

  result = await call(
    app,
    "/api/v1/auth/logout-all",
    json(
      { password: "initial-password-123", confirm: true },
      bearer(secondHumanToken),
    ),
  );
  assertEquals(result.body.data.revoked_all, true);
  result = await call(app, "/api/v1/auth/me", { headers: bearer(humanToken) });
  assertEquals(result.body.error.code, "credential_invalid");
  assertFalse(state.sessions.get(humanSessionId)?.active ?? true);

  await prototype.beginRecovery({
    username: "jordan",
    token: "recovery-secret",
    restoreSuperAdmin: true,
  });
  result = await call(
    app,
    "/api/v1/auth/recovery/complete",
    json(
      { username: "jordan", password: "recovered-password-456" },
      { authorization: "Operant-Recovery recovery-secret" },
    ),
  );
  assertEquals(result.status, 200);
  const recoveredHumanToken = result.body.data.human_session.token as string;
  result = await call(
    app,
    "/api/v1/auth/login",
    json({ username: "jordan", password: "initial-password-123" }),
  );
  assertEquals(result.body.error.code, "login_invalid");
  result = await call(
    app,
    "/api/v1/auth/login",
    json({
      username: "jordan",
      password: "recovered-password-456",
      existing_request_session_id: result.body.data?.request_credential?.id,
    }),
  );
  assertEquals(result.status, 200);
  result = await call(app, "/api/v1/auth/me", {
    headers: bearer(recoveredHumanToken),
  });
  assertEquals(result.body.data.credential_kind, "human_session");

  assert(state.contexts.length > 0);
  for (const context of state.contexts) {
    assertEquals((context as any).pid, undefined);
    assertEquals((context as any).cwd, undefined);
    assertExists(context.principalId);
  }
  assert(
    state.audit.some((event) => event.event === "auth.bootstrap.completed"),
  );
  assert(state.audit.some((event) => event.event === "auth.request.redeemed"));
  assert(
    state.audit.some((event) => event.event === "auth.recovery.completed"),
  );
});

Deno.test("argon2id password hashing is salted and verifies", async () => {
  const prototype = await createAuthPrototype();
  const first = await prototype.password.hash("long-password-for-testing");
  const second = await prototype.password.hash("long-password-for-testing");
  assert(first.startsWith("$argon2id$"));
  assert(second.startsWith("$argon2id$"));
  assert(first !== second);
  assert(await prototype.password.verify(first, "long-password-for-testing"));
  assertFalse(await prototype.password.verify(first, "wrong-password"));
});
