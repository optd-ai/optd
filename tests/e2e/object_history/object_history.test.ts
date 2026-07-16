import { assert, assertEquals } from "jsr:@std/assert";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { seedObjectHistoryFixture } from "../../support/object_history_fixtures.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { opaqueToken, tokenDigest } from "../../../src/domain/auth/token.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

Deno.test("compiled optctl reads Project-scoped object and relationship history", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "history-admin",
      password: "History-Admin-Password-42!",
      displayName: "History Admin",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const apply = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      "prototypes/crm-default-pack",
      "--safe",
    ]);
    assertEquals(apply.code, 0, apply.stderr);
    const sales = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "history-sales",
      "--display-name",
      "History Sales",
    ]);
    const other = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "history-other",
      "--display-name",
      "History Other",
    ]);
    assertEquals(sales.code, 0, sales.stderr);
    assertEquals(other.code, 0, other.stderr);
    const projectOne = JSON.parse(sales.stdout).data.id;
    const projectTwo = JSON.parse(other.stdout).data.id;
    const auth = (await query<{ id: string }>(
      harness.server.sql,
      "select id from auth_contexts order by created_at desc limit 1",
    )).rows[0].id;
    const ids = await seedObjectHistoryFixture({
      sql: harness.server.sql,
      publisher: "operant",
      pack: "crm",
      resource: "lead",
      relationship: "contact_company",
      projectIds: [projectOne, projectTwo],
      authContextId: auth,
      resourceData: { name: "Fixture Lead", status: "new" },
      relationshipFields: { role: "buyer", primary: true },
    });
    const relationshipTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='relationship' and definition_name='contact_company'",
    )).rows[0].table_name;
    await query(
      harness.server.sql,
      `insert into ${
        quoteIdentifier(relationshipTable)
      }(id,project_id,from_object_id,to_object_id,created_by,updated_by,${
        quoteIdentifier("role")
      },${quoteIdentifier("primary")}) values($1,$2,$3,$4,$5,$5,$6,$7)`,
      [
        uuidV7(),
        projectOne,
        ids.object,
        ids.otherObject,
        auth,
        "replacement",
        false,
      ],
    );
    const object = await harness.runOptctl([
      "--json",
      "--project",
      "history-sales",
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(object.code, 0, object.stderr);
    assertEquals(
      JSON.parse(object.stdout).data.object_version_id,
      ids.objectVersionTwo,
    );
    const history = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(history.code, 0, `${history.stderr}\n${history.stdout}`);
    const historyEnvelope = JSON.parse(history.stdout);
    assertEquals(
      historyEnvelope.data.items.map((entry: { kind: string }) => entry.kind),
      ["comment", "object_version", "object_version"],
    );
    const firstPage = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
    ]);
    assertEquals(firstPage.code, 0, firstPage.stderr);
    const cursor = JSON.parse(firstPage.stdout).meta.next_cursor as string;
    const secondPage = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
      "--cursor",
      cursor,
    ]);
    assertEquals(secondPage.code, 0, secondPage.stderr);
    const firstId = JSON.parse(firstPage.stdout).data.items[0].comment_id;
    const secondId =
      JSON.parse(secondPage.stdout).data.items[0].object_version_id;
    assert(firstId !== secondId);
    await harness.restart();
    const afterRestart = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
      "--cursor",
      cursor,
    ]);
    assertEquals(afterRestart.code, 0, afterRestart.stderr);
    assertEquals(
      JSON.parse(afterRestart.stdout).data.items[0].object_version_id,
      secondId,
    );
    const tampered = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
      "--limit",
      "1",
      "--cursor",
      `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`,
    ]);
    assertEquals(tampered.code, 1);
    assertEquals(JSON.parse(tampered.stderr).error.code, "invalid_cursor");
    const relationship = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "view",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ]);
    assertEquals(relationship.code, 0, relationship.stderr);
    assertEquals(JSON.parse(relationship.stdout).data.kind, "relationship");
    const relationshipHistory = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "history",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ]);
    assertEquals(relationshipHistory.code, 0, relationshipHistory.stderr);
    assertEquals(JSON.parse(relationshipHistory.stdout).data.items.length, 2);
    const toon = await harness.runOptctl([
      "--project",
      projectOne,
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(toon.code, 0, toon.stderr);
    assertEquals(toon.stdout.includes("object_version_id"), true);
    assertEquals(toon.stdout.includes("Fixture Lead"), true);
    const hookDefault = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "hook",
      "operant/crm:validate_lead",
    ]);
    assertEquals(hookDefault.code, 0, hookDefault.stderr);
    assertEquals("script_digest" in JSON.parse(hookDefault.stdout).data, false);
    const hookSecurity = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "hook",
      "operant/crm:validate_lead",
      "--include-security",
    ]);
    assertEquals(hookSecurity.code, 0, hookSecurity.stderr);
    assertEquals(
      typeof JSON.parse(hookSecurity.stdout).data.script_digest,
      "string",
    );
    const packSecurity = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "pack",
      "operant/crm",
      "--include-security",
    ]);
    assertEquals(packSecurity.code, 0, packSecurity.stderr);
    assert(Array.isArray(JSON.parse(packSecurity.stdout).data.security.hooks));
    const policySecurity = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "metadata",
      "policy",
      "operant/crm:sales_access",
      "--include-security",
    ]);
    assertEquals(policySecurity.code, 0, policySecurity.stderr);
    assert(Array.isArray(JSON.parse(policySecurity.stdout).data.rules));
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "metadata",
      "resource",
      "operant/crm:lead",
      "--include-security",
    ], "bad_request");
    const metadataWithoutBoundary = await harness.runOptctl([
      "--json",
      "metadata",
      "resource",
      "operant/crm:lead",
    ]);
    assertEquals(
      metadataWithoutBoundary.code,
      0,
      metadataWithoutBoundary.stderr,
    );
    assertEquals(
      JSON.parse(metadataWithoutBoundary.stdout).data.capability_projection
        .boundary_required,
      true,
    );
    assertNoMetadataLeaks(JSON.parse(hookDefault.stdout).data);

    const readerPassword = "History-Reader-Password-42!";
    await createUser(harness, "history-reader", readerPassword);
    const readerPrincipal = await principalFor(harness, "history-reader");
    await installCapability(
      harness,
      readerPrincipal,
      projectOne,
      auth,
      "history_read",
      "read",
      "unconditional",
    );
    assertEquals(
      (await harness.login({
        username: "history-reader",
        password: readerPassword,
      })).code,
      0,
    );
    const readerView = await harness.runOptctl([
      "--json",
      "--project",
      projectOne,
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(readerView.code, 0, readerView.stderr);
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "history",
      "operant/crm:lead",
      ids.object,
    ], "not_found");
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "view",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ], "not_found");
    await installCapability(
      harness,
      readerPrincipal,
      projectOne,
      auth,
      "history_history",
      "history.read",
      "unconditional",
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "--project",
        projectOne,
        "history",
        "operant/crm:lead",
        ids.object,
      ])).code,
      0,
    );
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "history",
      "relationship",
      "operant/crm:contact_company",
      ids.relationship,
    ], "not_found");
    await installCapability(
      harness,
      readerPrincipal,
      projectOne,
      auth,
      "history_archive",
      "read_archived",
      "unconditional",
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "--project",
        projectOne,
        "view",
        "relationship",
        "operant/crm:contact_company",
        ids.relationship,
      ])).code,
      0,
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "--project",
        projectOne,
        "history",
        "relationship",
        "operant/crm:contact_company",
        ids.relationship,
      ])).code,
      0,
    );
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "metadata",
      "hook",
      "operant/crm:validate_lead",
      "--include-security",
    ], "policy_denied");

    const leadTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    await proveRevocationOrdering(
      harness,
      leadTable,
      [
        "--json",
        "--project",
        projectOne,
        "view",
        "operant/crm:lead",
        ids.object,
      ],
      readerPrincipal,
      "test:history_read",
    );
    await query(
      harness.server.sql,
      "update role_assignments set active=true,disabled_at=null where principal_id=$1 and role_id='test:history_read'",
      [readerPrincipal],
    );
    await proveRevocationOrdering(
      harness,
      leadTable,
      [
        "--json",
        "--project",
        projectOne,
        "history",
        "operant/crm:lead",
        ids.object,
      ],
      readerPrincipal,
      "test:history_history",
    );

    const conditionalPassword = "History-Conditional-Password-42!";
    await harness.login({
      username: "history-admin",
      password: "History-Admin-Password-42!",
    });
    await createUser(harness, "history-conditional", conditionalPassword);
    const conditionalPrincipal = await principalFor(
      harness,
      "history-conditional",
    );
    await installCapability(
      harness,
      conditionalPrincipal,
      projectOne,
      auth,
      "history_conditional",
      "read",
      "abac",
    );
    await installCapability(
      harness,
      conditionalPrincipal,
      projectOne,
      auth,
      "history_conditional_rebac",
      "read",
      "rebac",
    );
    assertEquals(
      (await harness.login({
        username: "history-conditional",
        password: conditionalPassword,
      })).code,
      0,
    );
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "view",
      "operant/crm:lead",
      ids.object,
    ], "not_found");

    await harness.login({
      username: "history-admin",
      password: "History-Admin-Password-42!",
    });
    const agent = await createAgentLineage(harness, auth);
    const currentUrl =
      `${harness.baseUrl}/api/v1/projects/${projectOne}/objects/operant/crm/lead/${ids.object}`;
    const historyUrl = `${currentUrl}/history`;
    const agentSmoke = await fetch(currentUrl, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    assertEquals(
      agentSmoke.status,
      200,
      JSON.stringify(await agentSmoke.json()),
    );
    await mutateBeforeAgentBoundary(
      harness,
      agent,
      currentUrl,
      () =>
        query(
          harness.server.sql,
          "update agent_authorizations set revoked_at=now() where id=$1",
          [agent.rootId],
        ),
    );
    await query(
      harness.server.sql,
      "update agent_authorizations set revoked_at=null where id=$1",
      [agent.rootId],
    );
    await mutateBeforeAgentBoundary(
      harness,
      agent,
      historyUrl,
      () =>
        query(
          harness.server.sql,
          "update agent_authorizations set superseded_at=now() where id=$1",
          [agent.rootId],
        ),
    );
    await query(
      harness.server.sql,
      "update agent_authorizations set superseded_at=null where id=$1",
      [agent.rootId],
    );
    await mutateBeforeAgentBoundary(
      harness,
      agent,
      currentUrl,
      () =>
        query(
          harness.server.sql,
          "update principals set active=false where id=$1",
          [agent.principalId],
        ),
    );
    await query(
      harness.server.sql,
      "update principals set active=true where id=$1",
      [agent.principalId],
    );
    await mutateAfterAgentLocks(
      harness,
      agent,
      leadTable,
      currentUrl,
      () =>
        query(
          harness.server.sql,
          "update agent_authorizations set revoked_at=now() where id=$1",
          [agent.rootId],
        ),
    );
    await query(
      harness.server.sql,
      "update agent_authorizations set revoked_at=null where id=$1",
      [agent.rootId],
    );
    await mutateAfterAgentLocks(
      harness,
      agent,
      leadTable,
      historyUrl,
      () =>
        query(
          harness.server.sql,
          "update agent_authorizations set superseded_at=now() where id=$1",
          [agent.rootId],
        ),
    );
    await query(
      harness.server.sql,
      "update agent_authorizations set superseded_at=null where id=$1",
      [agent.rootId],
    );
    const agentFirstPage = await fetch(`${historyUrl}?limit=1`, {
      headers: { authorization: `Bearer ${agent.token}` },
    });
    assertEquals(agentFirstPage.status, 200);
    const agentCursor = (await agentFirstPage.json()).meta.next_cursor;
    const alternate = await createAlternateAgentRoot(harness, agent, auth);
    await query(
      harness.server.sql,
      "update auth_sessions set authorization_id=$1 where id=$2",
      [alternate.leafId, agent.sessionId],
    );
    const changedRootContinuation = await fetch(
      `${historyUrl}?limit=1&cursor=${encodeURIComponent(agentCursor)}`,
      {
        headers: { authorization: `Bearer ${agent.token}` },
      },
    );
    assertEquals(changedRootContinuation.status, 400);
    assertEquals(
      (await changedRootContinuation.json()).error.code,
      "invalid_cursor",
    );
    const mismatch = await harness.runOptctl([
      "--json",
      "--project",
      projectTwo,
      "view",
      "operant/crm:lead",
      ids.object,
    ]);
    assertEquals(mismatch.code, 1);
    assertEquals(JSON.parse(mismatch.stderr).error.code, "not_found");
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "view",
      "operant/crm:company",
      ids.object,
    ], "not_found");
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "--project",
        projectOne,
        "view",
        "operant/crm:lead",
        ids.object.toUpperCase(),
      ])).code,
      2,
    );
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "--project",
        projectOne,
        "view",
        "Operant/crm:lead",
        ids.object,
      ])).code,
      2,
    );
    const freshLogin = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "history-admin",
        password: "History-Admin-Password-42!",
      }),
    });
    assertEquals(freshLogin.status, 200);
    const freshCredentials = (await freshLogin.json()).data.credentials;
    const requestToken = freshCredentials.authorization_request_token;
    const fullToken = freshCredentials.token;
    for (
      const path of [
        `/api/v1/projects/${projectOne}/objects/operant/crm/lead/${ids.object.toUpperCase()}`,
        `/api/v1/projects/${projectOne}/objects/operant/crm/lead/not-a-uuid`,
        `/api/v1/projects/${projectOne}/objects/Operant/crm/lead/${ids.object}`,
      ]
    ) {
      const invalid = await fetch(`${harness.baseUrl}${path}`, {
        headers: { authorization: `Bearer ${fullToken}` },
      });
      assertEquals(invalid.status, 400);
      assertEquals((await invalid.json()).error.code, "bad_request");
    }
    const invalidMetadataQuery = await fetch(
      `${harness.baseUrl}/metadata/packs/operant/crm/hooks/validate_lead?include_security=false`,
      { headers: { authorization: `Bearer ${fullToken}` } },
    );
    assertEquals(invalidMetadataQuery.status, 400);
    assertEquals((await invalidMetadataQuery.json()).error.code, "bad_request");
    const denied = await fetch(
      `${harness.baseUrl}/api/v1/projects/${projectOne}/objects/operant/crm/lead/${ids.object}`,
      {
        headers: { authorization: `Bearer ${requestToken}` },
      },
    );
    assertEquals(denied.status, 403);
    assertEquals(
      (await denied.json()).error.code,
      "authorization_insufficient",
    );
    assertEquals(
      (await harness.runOptctl(["project", "select", "history-other"])).code,
      0,
    );
    await expectCode(harness, [
      "--json",
      "--project",
      projectOne,
      "view",
      "operant/crm:lead",
      ids.object,
    ], "project_conflict");
  } catch (error) {
    console.error(error);
    console.error(await harness.diagnostics());
    throw error;
  } finally {
    await harness.close();
  }
});

async function createUser(
  harness: LiveHarness,
  username: string,
  password: string,
) {
  const result = await harness.runOptctl([
    "--json",
    "auth",
    "user",
    "create",
    "--username",
    username,
    "--display-name",
    username,
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(result.code, 0, result.stderr);
}
async function principalFor(harness: LiveHarness, username: string) {
  return (await query<{ principal_id: string }>(
    harness.server.sql,
    "select principal_id::text principal_id from human_users where username=$1",
    [username],
  )).rows[0].principal_id;
}
async function installCapability(
  harness: LiveHarness,
  principalId: string,
  projectId: string,
  authContextId: string,
  suffix: string,
  action: string,
  condition: "unconditional" | "abac" | "rebac",
) {
  const role = `test:${suffix}`;
  const roleVersion = uuidV7();
  const policyVersion = uuidV7();
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      "insert into system_roles(id,display_name,active) values($1,$1,true)",
      [role],
    );
    await query(
      tx,
      "insert into role_definition_versions(id,role_id,version,active) values($1,$2,1,true)",
      [roleVersion, role],
    );
    await query(
      tx,
      "insert into policy_definition_versions(id,policy_id,version,active) values($1,$2,1,true)",
      [policyVersion, `test:${suffix}`],
    );
    await query(
      tx,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,predicate) values($1,$2,$3,$4,'*',$5,$6)",
      [
        uuidV7(),
        policyVersion,
        role,
        action,
        condition,
        condition === "unconditional" ? null : "true",
      ],
    );
    await query(
      tx,
      "insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind) values($1,$2,$3,'project.read','*','unconditional')",
      [uuidV7(), policyVersion, role],
    );
    await query(
      tx,
      "insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,source,created_by_auth_context_id) values($1,$2,'project',$3,true,'operator',$4)",
      [uuidV7(), policyVersion, projectId, authContextId],
    );
    await query(
      tx,
      "insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active,created_by_auth_context_id) values($1,$2,$3,'project',$4,true,$5)",
      [uuidV7(), principalId, role, projectId, authContextId],
    );
  });
}
async function expectCode(harness: LiveHarness, args: string[], code: string) {
  const result = await harness.runOptctl(args);
  assertEquals(result.code, 1, result.stderr);
  assertEquals(JSON.parse(result.stderr).error.code, code);
}
function assertNoMetadataLeaks(value: unknown) {
  const forbidden = new Set([
    "manifest",
    "normalized",
    "spec",
    "predicate",
    "source",
    "path",
    "secret",
    "grant",
    "value",
    "roles",
  ]);
  const visit = (item: unknown) => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    for (
      const [key, child] of Object.entries(item as Record<string, unknown>)
    ) {
      assertEquals(
        forbidden.has(key.toLowerCase()),
        false,
        `metadata leaked ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
}

async function proveRevocationOrdering(
  harness: LiveHarness,
  table: string,
  readArgs: string[],
  principalId: string,
  role: string,
) {
  let release!: () => void;
  let locked!: () => void;
  const releaseWait = new Promise<void>((resolve) => release = resolve);
  const lockReady = new Promise<void>((resolve) => locked = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `lock table ${quoteIdentifier(table)} in access exclusive mode`,
    );
    locked();
    await releaseWait;
  });
  await lockReady;
  const disclosure = harness.runOptctl(readArgs);
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (await query<{ waiting: boolean }>(
      harness.server.sql,
      "select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%'||$1||'%') waiting",
      [table],
    )).rows[0].waiting;
    if (waiting) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (attempt === 99) {
      throw new Error("read did not reach deterministic table barrier");
    }
  }
  let revoked = false;
  const revocation = query(
    harness.server.sql,
    "update role_assignments set active=false,disabled_at=now() where principal_id=$1 and role_id=$2",
    [principalId, role],
  ).then(() => revoked = true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEquals(
    revoked,
    false,
    "revocation must wait for the disclosure authority lock",
  );
  release();
  await blocker;
  const result = await disclosure;
  assertEquals(result.code, 0, result.stderr);
  await revocation;
  await expectCode(harness, readArgs, "not_found");
}

type AgentLineageFixture = {
  token: string;
  sessionId: string;
  principalId: string;
  rootId: string;
  leafId: string;
  agentUserId: string;
};

async function createAgentLineage(
  harness: LiveHarness,
  approvedByAuthContextId: string,
): Promise<AgentLineageFixture> {
  const principalId = uuidV7();
  const agentUserId = uuidV7();
  const rootId = uuidV7();
  const leafId = uuidV7();
  const sessionId = uuidV7();
  const token = opaqueToken();
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      "insert into principals(id,type,active) values($1,'agent_user',true)",
      [principalId],
    );
    await query(
      tx,
      `insert into agent_users(id,principal_id,human_user_id,name)
      select $1,$2,human_user_id,'history-lineage-agent' from auth_contexts where id=$3`,
      [agentUserId, principalId, approvedByAuthContextId],
    );
    await query(
      tx,
      `insert into agent_authorizations(
      id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id)
      select $1,$2,human_user_id,null,$1,$3 from auth_contexts where id=$3`,
      [rootId, agentUserId, approvedByAuthContextId],
    );
    await query(
      tx,
      `insert into agent_authorizations(
      id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id)
      select $1,$2,human_user_id,$3,$3,$4 from auth_contexts where id=$4`,
      [leafId, agentUserId, rootId, approvedByAuthContextId],
    );
    for (const authorizationId of [rootId, leafId]) {
      for (
        const role of [
          "test:history_read",
          "test:history_history",
          "test:history_archive",
        ]
      ) {
        await query(
          tx,
          "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type,project_id) select $1,$2,$3,'project',project_id from role_assignments where role_id=$3 limit 1",
          [uuidV7(), authorizationId, role],
        );
      }
    }
    await query(
      tx,
      `insert into auth_sessions(
      id,principal_id,human_user_id,credential_kind,token_digest,authorization_id)
      select $1,$2,human_user_id,'agent_authorization',$3,$4 from auth_contexts where id=$5`,
      [
        sessionId,
        principalId,
        await tokenDigest(token),
        leafId,
        approvedByAuthContextId,
      ],
    );
  });
  return { token, sessionId, principalId, rootId, leafId, agentUserId };
}

async function mutateBeforeAgentBoundary(
  _harness: LiveHarness,
  agent: AgentLineageFixture,
  url: string,
  mutate: () => Promise<unknown>,
) {
  await mutate();
  const denied = await fetch(url, {
    headers: { authorization: `Bearer ${agent.token}` },
  });
  assert(denied.status === 401 || denied.status === 404);
  assertEquals((await denied.json()).ok, false);
}

async function mutateAfterAgentLocks(
  harness: LiveHarness,
  agent: AgentLineageFixture,
  table: string,
  url: string,
  mutate: () => Promise<unknown>,
) {
  let release!: () => void;
  let ready!: () => void;
  const releaseWait = new Promise<void>((resolve) => release = resolve);
  const readyWait = new Promise<void>((resolve) => ready = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `lock table ${quoteIdentifier(table)} in access exclusive mode`,
    );
    ready();
    await releaseWait;
  });
  await readyWait;
  const response = fetch(url, {
    headers: { authorization: `Bearer ${agent.token}` },
  }).catch((error) => error as Error);
  await waitForTableBarrier(harness, table);
  let changed = false;
  const mutation = mutate().then(() => changed = true);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assertEquals(changed, false, "ancestor mutation must wait for lineage locks");
  release();
  await blocker;
  const disclosed = await response;
  if (disclosed instanceof Error) throw disclosed;
  assertEquals(disclosed.status, 200);
  await mutation;
}

async function waitForTableBarrier(harness: LiveHarness, table: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (await query<{ waiting: boolean }>(
      harness.server.sql,
      "select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%'||$1||'%') waiting",
      [table],
    )).rows[0].waiting;
    if (waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("agent read did not reach the deterministic table barrier");
}

async function createAlternateAgentRoot(
  harness: LiveHarness,
  agent: AgentLineageFixture,
  approvedByAuthContextId: string,
) {
  const rootId = uuidV7();
  const leafId = uuidV7();
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into agent_authorizations(
      id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id)
      select $1,$2,human_user_id,null,$1,$3 from auth_contexts where id=$3`,
      [rootId, agent.agentUserId, approvedByAuthContextId],
    );
    await query(
      tx,
      `insert into agent_authorizations(
      id,agent_user_id,human_user_id,parent_authorization_id,root_authorization_id,approved_by_auth_context_id)
      select $1,$2,human_user_id,$3,$3,$4 from auth_contexts where id=$4`,
      [leafId, agent.agentUserId, rootId, approvedByAuthContextId],
    );
    for (const authorizationId of [rootId, leafId]) {
      for (
        const role of [
          "test:history_read",
          "test:history_history",
          "test:history_archive",
        ]
      ) {
        await query(
          tx,
          "insert into agent_authorization_roles(id,authorization_id,role_id,boundary_type,project_id) select $1,$2,$3,'project',project_id from role_assignments where role_id=$3 limit 1",
          [uuidV7(), authorizationId, role],
        );
      }
    }
  });
  return { rootId, leafId };
}
