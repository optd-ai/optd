import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

Deno.test("distinct compiled process trees reconnect wait, delegate, replace, and revoke", async () => {
  const harness = await startLiveHarness();
  const launchers: CliLauncher[] = [];
  try {
    const human = await launcher(harness, launchers, "human");
    const requestOnly = await launcher(harness, launchers, "request_only");
    const waitingAgent = await launcher(harness, launchers, "agent");
    const delegatedAgent = await launcher(harness, launchers, "agent");
    const replacementAgent = await launcher(harness, launchers, "agent");
    const revocationAgent = await launcher(harness, launchers, "agent");
    assertEquals([
      human.kind,
      requestOnly.kind,
      waitingAgent.kind,
      delegatedAgent.kind,
      replacementAgent.kind,
      revocationAgent.kind,
    ], ["human", "request_only", "agent", "agent", "agent", "agent"]);

    const boot = await human.runOptctl([
      "--json",
      "bootstrap",
      "init",
      "--username",
      "wait-admin",
      "--password-stdin",
    ], "interrupted websocket password\n");
    assertEquals(boot.code, 0, boot.stderr);
    const initial = await storedState(harness);
    const project = await human.runOptctl([
      "--json",
      "project",
      "create",
      "agent-work",
      "--display-name",
      "Agent Work",
    ]);
    assertEquals(project.code, 0, project.stderr);
    await selectCredential(harness, {
      token: initial.requestToken,
      requestToken: initial.requestToken,
    });
    const discovered = await requestOnly.runOptctl([
      "--json",
      "auth",
      "roles",
      "--boundary",
      "system",
    ]);
    assertEquals(discovered.code, 0, discovered.stderr);
    assertEquals(JSON.parse(discovered.stdout).data.roles, [
      "system:admin",
      "system:super_admin",
    ]);
    const requestOnlyWork = await requestOnly.runOptctl([
      "--json",
      "project",
      "list",
    ]);
    assertEquals(requestOnlyWork.code, 1);
    assertEquals(
      JSON.parse(requestOnlyWork.stderr).error.code,
      "authorization_insufficient",
    );
    await selectCredential(harness, {
      token: initial.token,
      requestToken: initial.requestToken,
    });

    const request = await requestOnly.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "in-flight interrupted wait",
    ]);
    assertEquals(request.code, 0, request.stderr);
    const requestId = JSON.parse(request.stdout).data.id as string;
    const requestState = await storedState(harness);
    const contextsBefore = await requestContextCount(
      harness,
      initial.requestSessionId,
    );

    const waitResult = waitingAgent.runOptctl([
      "--json",
      "auth",
      "wait",
      requestId,
    ]);
    await waitForUsedTickets(harness, requestId, 1);
    await harness.restart();
    await waitForUsedTickets(harness, requestId, 2);

    const approval = await human.runOptctl([
      "--json",
      "auth",
      "approve",
      requestId,
      "--yes",
      "--agent-name",
      "top-agent",
    ]);
    assertEquals(approval.code, 0, approval.stderr);
    assertEquals(approval.stdout.includes("token"), false);
    const waited = await waitResult;
    assertEquals(waited.code, 0, waited.stderr);
    const topState = await storedState(harness);
    const topToken = topState.token;
    assertExists(topToken);
    const topAuthorizationId = await requestAuthorizationId(harness, requestId);
    await selectCredential(harness, {
      token: topToken,
      requestToken: undefined,
    });
    const allowedWork = await waitingAgent.runOptctl([
      "--json",
      "project",
      "list",
    ]);
    assertEquals(allowedWork.code, 0, allowedWork.stderr);
    const contextsAfter = await requestContextCount(
      harness,
      initial.requestSessionId,
    );
    assertEquals(
      contextsAfter - contextsBefore,
      3,
      "two ticket exchanges plus redemption; no authenticated polling",
    );

    const topIdentity = await inspectJson(
      harness.baseUrl,
      topToken,
      "/api/v1/auth/me",
    );
    assertEquals(topIdentity.status, 200);
    const replay = await postJson(
      harness.baseUrl,
      initial.requestToken,
      `/api/v1/auth/requests/${requestId}/redeem`,
      { redemption_nonce: requestState.authorizationNonces[requestId] },
    );
    assertEquals(replay.status, 409);
    assertEquals(replay.body.error.code, "redemption_already_used");
    const wrongRequester = await postJson(
      harness.baseUrl,
      initial.token,
      `/api/v1/auth/requests/${requestId}/redeem`,
      { redemption_nonce: requestState.authorizationNonces[requestId] },
    );
    assertEquals(wrongRequester.status, 401);
    assertEquals(wrongRequester.body.error.code, "redemption_invalid");

    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const deniedRequest = await requestOnly.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "public denial",
    ]);
    assertEquals(deniedRequest.code, 0, deniedRequest.stderr);
    const deniedRequestId = JSON.parse(deniedRequest.stdout).data.id as string;
    await selectCredential(harness, {
      token: topToken,
      requestToken: undefined,
    });
    const deniedDecision = await waitingAgent.runOptctl([
      "--json",
      "auth",
      "deny",
      deniedRequestId,
      "--reason",
      "not appropriate",
    ]);
    assertEquals(deniedDecision.code, 0, deniedDecision.stderr);

    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const narrowRequest = await requestOnly.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "narrow decider",
    ]);
    assertEquals(narrowRequest.code, 0, narrowRequest.stderr);
    const narrowRequestId = JSON.parse(narrowRequest.stdout).data.id as string;
    await selectCredential(harness, {
      token: topToken,
      requestToken: undefined,
    });
    const narrowApproval = await waitingAgent.runOptctl([
      "--json",
      "auth",
      "approve",
      narrowRequestId,
      "--yes",
    ]);
    assertEquals(narrowApproval.code, 0, narrowApproval.stderr);
    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const narrowWait = await delegatedAgent.runOptctl([
      "--json",
      "auth",
      "wait",
      narrowRequestId,
    ]);
    assertEquals(narrowWait.code, 0, narrowWait.stderr);
    const narrowToken = (await storedState(harness)).token;
    await seedAgentDecidePolicy(harness);
    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const broadRequest = await requestOnly.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "under-authorized decision",
    ]);
    assertEquals(broadRequest.code, 0, broadRequest.stderr);
    const broadRequestId = JSON.parse(broadRequest.stdout).data.id as string;
    await selectCredential(harness, {
      token: narrowToken,
      requestToken: undefined,
    });
    const underAuthorized = await delegatedAgent.runOptctl([
      "--json",
      "auth",
      "approve",
      broadRequestId,
      "--yes",
    ]);
    assertEquals(underAuthorized.code, 1);
    assertEquals(
      JSON.parse(underAuthorized.stderr).error.code,
      "authorization_insufficient",
    );

    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const delegatedRequest = await requestOnly.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "delegated subagent",
    ]);
    assertEquals(delegatedRequest.code, 0, delegatedRequest.stderr);
    const delegatedRequestId = JSON.parse(delegatedRequest.stdout).data
      .id as string;
    await selectCredential(harness, {
      token: topToken,
      requestToken: undefined,
    });
    const delegatedApproval = await waitingAgent.runOptctl([
      "--json",
      "auth",
      "approve",
      delegatedRequestId,
      "--yes",
      "--agent-name",
      "delegated-agent",
    ]);
    assertEquals(delegatedApproval.code, 0, delegatedApproval.stderr);
    assertEquals(delegatedApproval.stdout.includes("token"), false);
    await selectCredential(harness, {
      token: undefined,
      requestToken: initial.requestToken,
    });
    const delegatedWait = await delegatedAgent.runOptctl([
      "--json",
      "auth",
      "wait",
      delegatedRequestId,
    ]);
    assertEquals(delegatedWait.code, 0, delegatedWait.stderr);
    const delegatedToken = (await storedState(harness)).token;
    const delegatedAuthorizationId = await requestAuthorizationId(
      harness,
      delegatedRequestId,
    );
    const delegatedLineage = await lineage(harness, delegatedAuthorizationId);
    assertEquals(delegatedLineage.parent_authorization_id, topAuthorizationId);
    assertEquals(delegatedLineage.root_authorization_id, topAuthorizationId);

    await selectCredential(harness, {
      token: delegatedToken,
      requestToken: undefined,
    });
    const replacementRequest = await replacementAgent.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "replace delegated authority",
    ]);
    assertEquals(replacementRequest.code, 0, replacementRequest.stderr);
    const replacementRequestId = JSON.parse(replacementRequest.stdout).data
      .id as string;
    const replacementApproval = await delegatedAgent.runOptctl([
      "--json",
      "auth",
      "approve",
      replacementRequestId,
      "--yes",
    ]);
    assertEquals(replacementApproval.code, 0, replacementApproval.stderr);
    const replacementWait = await replacementAgent.runOptctl([
      "--json",
      "auth",
      "wait",
      replacementRequestId,
    ]);
    assertEquals(replacementWait.code, 0, replacementWait.stderr);
    const replacementToken = (await storedState(harness)).token;
    const replacementAuthorizationId = await requestAuthorizationId(
      harness,
      replacementRequestId,
    );
    const replacementLineage = await lineage(
      harness,
      replacementAuthorizationId,
    );
    assertEquals(
      replacementLineage,
      delegatedLineage,
      "replacement preserves parent/root instead of parenting to superseded authorization",
    );

    await selectCredential(harness, {
      token: replacementToken,
      requestToken: undefined,
    });
    const revoked = await revocationAgent.runOptctl([
      "--json",
      "auth",
      "revoke",
      replacementAuthorizationId,
    ]);
    assertEquals(revoked.code, 0, revoked.stderr);
    const rejected = await revocationAgent.runOptctl([
      "--json",
      "auth",
      "whoami",
    ]);
    assertEquals(rejected.code, 1);
    assertEquals(JSON.parse(rejected.stderr).error.code, "credential_invalid");

    const provenance = (await query<
      {
        agent_user_id: string;
        parent_authorization_id: string | null;
        root_authorization_id: string;
        approved_by_auth_context_id: string;
      }
    >(
      harness.server.sql,
      `select agent_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id from agent_authorizations where id=$1`,
      [replacementAuthorizationId],
    )).rows[0]!;
    assertExists(provenance.agent_user_id);
    assertExists(provenance.approved_by_auth_context_id);
    assertEquals(provenance.parent_authorization_id, topAuthorizationId);
    assertEquals(provenance.root_authorization_id, topAuthorizationId);
  } finally {
    for (const value of launchers.reverse()) {
      await value.close().catch(() => undefined);
    }
    await harness.close();
  }
});

async function launcher(
  harness: LiveHarness,
  values: CliLauncher[],
  kind: "human" | "request_only" | "agent",
) {
  const value = await harness.createProcessTreeLauncher(kind);
  values.push(value);
  return value;
}
type State = {
  token: string;
  requestToken: string;
  requestSessionId: string;
  authorizationNonces: Record<string, string>;
};
async function storedState(harness: LiveHarness): Promise<State> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "optd", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
async function selectCredential(
  harness: LiveHarness,
  update: { token?: string; requestToken?: string },
) {
  const path = join(harness.rootDir, "xdg-config", "optd", "auth.json");
  const store = JSON.parse(await Deno.readTextFile(path));
  const origin = new URL(harness.baseUrl).origin;
  store.origins[origin] = { ...store.origins[origin], ...update };
  if (update.token === undefined) delete store.origins[origin].token;
  if (update.requestToken === undefined) {
    delete store.origins[origin].requestToken;
  }
  await Deno.writeTextFile(path, JSON.stringify(store));
}
async function waitForUsedTickets(
  harness: LiveHarness,
  requestId: string,
  minimum: number,
) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const count = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from agent_authorization_watch_tickets where request_id=$1 and used_at is not null`,
      [requestId],
    )).rows[0]!.count;
    if (count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`compiled wait did not consume watch ticket ${minimum}`);
}
async function requestContextCount(harness: LiveHarness, sessionId: string) {
  return (await query<{ count: number }>(
    harness.server.sql,
    `select count(*)::int count from auth_contexts where session_id=$1`,
    [sessionId],
  )).rows[0]!.count;
}
async function requestAuthorizationId(harness: LiveHarness, requestId: string) {
  return (await query<{ authorization_id: string }>(
    harness.server.sql,
    `select authorization_id from agent_authorization_requests where id=$1`,
    [requestId],
  )).rows[0]!.authorization_id;
}
async function lineage(harness: LiveHarness, authorizationId: string) {
  return (await query<
    { parent_authorization_id: string | null; root_authorization_id: string }
  >(
    harness.server.sql,
    `select parent_authorization_id,root_authorization_id from agent_authorizations where id=$1`,
    [authorizationId],
  )).rows[0]!;
}
async function seedAgentDecidePolicy(harness: LiveHarness) {
  const versionId = uuidV7();
  await query(
    harness.server.sql,
    `insert into policy_definition_versions(id,policy_id,version,active) values($1,'system:e2e_agent_decider',1,true)`,
    [versionId],
  );
  await query(
    harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability) values($1,$2,'system:admin','auth.request.decide')`,
    [uuidV7(), versionId],
  );
  await query(
    harness.server.sql,
    `insert into policy_assignments(id,policy_definition_version_id,boundary_type,active) values($1,$2,'system',true)`,
    [uuidV7(), versionId],
  );
}
async function postJson(
  origin: string,
  token: string,
  path: string,
  body: unknown,
) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function inspectJson(origin: string, token: string, path: string) {
  const response = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json() };
}
