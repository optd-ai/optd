import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";
import { query } from "../../src/adapters/outbound/postgres/client.ts";

Deno.test("agent denial is terminal and returns no credential", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "denial-admin",
        password: "agent denial password",
      })).code,
      0,
    );
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "overbroad request",
    ]);
    assertEquals(requested.code, 0, requested.stderr);
    const requestId = JSON.parse(requested.stdout).data.id as string;
    const denied = await harness.runOptctl([
      "--json",
      "auth",
      "deny",
      requestId,
      "--reason",
      "Requested authority is too broad",
    ]);
    assertEquals(denied.code, 0, denied.stderr);
    assertEquals(denied.stdout.includes("token"), false);
    const waited = await harness.runOptctl([
      "--json",
      "auth",
      "wait",
      requestId,
    ]);
    assertEquals(waited.code, 1);
    assertEquals(JSON.parse(waited.stderr).error.code, "request_denied");
    assertEquals(
      JSON.parse(waited.stderr).error.message,
      "Requested authority is too broad",
    );
    const sessions = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from auth_sessions where credential_kind='agent_authorization'`,
    )).rows[0]!;
    assertEquals(sessions.count, 0);
  } finally {
    await harness.close();
  }
});

Deno.test("agent approval is requester-redeemed and replacement preserves lineage", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "agent-admin",
        password: "agent authorization password",
      })).code,
      0,
    );
    const requested = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
      "--reason",
      "delegated administration",
    ]);
    assertEquals(requested.code, 0, requested.stderr);
    const requestId = JSON.parse(requested.stdout).data.id as string;
    const approved = await harness.runOptctl([
      "--json",
      "auth",
      "approve",
      requestId,
      "--yes",
      "--agent-name",
      "test-agent",
    ]);
    assertEquals(approved.code, 0, approved.stderr);
    assertEquals(
      approved.stdout.includes("token"),
      false,
      "approver response must not contain bearer material",
    );

    const redeemed = await harness.runOptctl([
      "--json",
      "auth",
      "wait",
      requestId,
    ]);
    assertEquals(redeemed.code, 0, redeemed.stderr);
    const first = (await query<
      {
        authorization_id: string;
        parent_authorization_id: string | null;
        root_authorization_id: string;
      }
    >(
      harness.server.sql,
      `select r.authorization_id,a.parent_authorization_id,a.root_authorization_id from agent_authorization_requests r join agent_authorizations a on a.id=r.authorization_id where r.id=$1`,
      [requestId],
    )).rows[0];
    assertExists(first);
    assertEquals(first.parent_authorization_id, null);
    assertEquals(first.root_authorization_id, first.authorization_id);

    const replacementRequest = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "extend current authorization",
    ]);
    assertEquals(replacementRequest.code, 0, replacementRequest.stderr);
    const replacementRequestId = JSON.parse(replacementRequest.stdout).data
      .id as string;
    const replacementApproved = await harness.runOptctl([
      "--json",
      "auth",
      "approve",
      replacementRequestId,
      "--yes",
    ]);
    assertEquals(replacementApproved.code, 0, replacementApproved.stderr);
    const replacementRedeemed = await harness.runOptctl([
      "--json",
      "auth",
      "wait",
      replacementRequestId,
    ]);
    assertEquals(replacementRedeemed.code, 0, replacementRedeemed.stderr);
    const replacement = (await query<
      {
        authorization_id: string;
        parent_authorization_id: string | null;
        root_authorization_id: string;
      }
    >(
      harness.server.sql,
      `select r.authorization_id,a.parent_authorization_id,a.root_authorization_id from agent_authorization_requests r join agent_authorizations a on a.id=r.authorization_id where r.id=$1`,
      [replacementRequestId],
    )).rows[0];
    assertExists(replacement);
    assertNotEquals(replacement.authorization_id, first.authorization_id);
    assertEquals(
      replacement.parent_authorization_id,
      first.parent_authorization_id,
    );
    assertEquals(
      replacement.root_authorization_id,
      first.root_authorization_id,
    );
    const requestCountBefore = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from agent_authorization_requests`,
    )).rows[0]!.count;
    const already = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "no request churn",
    ]);
    assertEquals(already.code, 0, already.stderr);
    assertEquals(JSON.parse(already.stdout).data.already_authorized, true);
    const requestCountAfter = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from agent_authorization_requests`,
    )).rows[0]!.count;
    assertEquals(requestCountAfter, requestCountBefore);
    const forbiddenEvidence = (await query<{ column_name: string }>(
      harness.server.sql,
      `select column_name from information_schema.columns where table_name in ('agent_users','agent_authorizations','agent_authorization_requests') and column_name in ('pid','ppid','cwd','host','hostname','process_start')`,
    )).rows;
    assertEquals(forbiddenEvidence, []);

    const revoked = await harness.runOptctl([
      "--json",
      "auth",
      "revoke",
      replacement.authorization_id,
    ]);
    assertEquals(revoked.code, 0, revoked.stderr);
    const denied = await harness.runOptctl(["--json", "auth", "whoami"]);
    assertEquals(denied.code, 1);
  } finally {
    await harness.close();
  }
});
