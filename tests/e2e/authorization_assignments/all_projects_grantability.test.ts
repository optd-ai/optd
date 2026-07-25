import { assertEquals } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

type Stored = { token: string; requestToken: string };

Deno.test("compiled optctl grantability inherits all-project authority only into Projects", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "inherit-root",
        password: "all projects inheritance root password",
      })).code,
      0,
    );
    const first = await createProject(harness, "inherit-first");
    const second = await createProject(harness, "inherit-second");
    assertEquals(
      (await harness.runOptctl([
        "--json",
        "auth",
        "user",
        "create",
        "--username",
        "all-project-admin",
        "--password-stdin",
      ], "all projects admin password\n")).code,
      0,
    );
    const user = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='all-project-admin'",
    )).rows[0];
    const assignment = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      user.id,
      "--role",
      "system:admin",
      "--boundary",
      "all_projects",
    ]);
    assertEquals(assignment.code, 0, assignment.stderr);
    const assignmentBody = JSON.parse(assignment.stdout).data;
    assertEquals(
      (await harness.login({
        username: "all-project-admin",
        password: "all projects admin password",
      })).code,
      0,
    );
    const admin = await stored(harness);

    const authority = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      first,
    ]);
    assertEquals(authority.code, 0, authority.stderr);
    assertEquals(JSON.parse(authority.stdout).data.effective_roles, [
      "system:admin",
    ]);
    assertEquals(
      JSON.parse(authority.stdout).data.capabilities.some(
        (item: Record<string, unknown>) =>
          item.action === "auth.request.decide",
      ),
      true,
    );

    const approved = await createRequest(harness, admin, [
      "--role",
      "system:admin",
      "--project",
      first,
      "--reason",
      "approve inherited Project authority",
    ]);
    const approve = await harness.runOptctl([
      "--json",
      "auth",
      "approve",
      approved,
    ]);
    assertEquals(approve.code, 0, approve.stderr);

    const denied = await createRequest(harness, admin, [
      "--role",
      "system:admin",
      "--project",
      second,
      "--reason",
      "deny inherited Project authority",
    ]);
    const deny = await harness.runOptctl([
      "--json",
      "auth",
      "deny",
      denied,
      "--reason",
      "not needed",
    ]);
    assertEquals(deny.code, 0, deny.stderr);

    await select(harness, {
      token: admin.requestToken,
      requestToken: admin.requestToken,
    });
    const systemRequest = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "system:admin",
      "--boundary",
      "system",
      "--reason",
      "must not cross into system",
    ]);
    assertEquals(systemRequest.code, 1);

    const exactRole = "operant/test:project_reviewer";
    await query(
      harness.server.sql,
      "insert into system_roles(id,display_name,active) values($1,'Project Reviewer',true)",
      [exactRole],
    );
    await query(
      harness.server.sql,
      "insert into role_definition_versions(id,role_id,version,active) values($1,$2,1,true)",
      [uuidV7(), exactRole],
    );
    await login(
      harness,
      "inherit-root",
      "all projects inheritance root password",
    );
    const exact = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      user.id,
      "--role",
      exactRole,
      "--project",
      first,
    ]);
    assertEquals(exact.code, 0, exact.stderr);
    const exactAssignment = JSON.parse(exact.stdout).data;
    await select(harness, {
      token: admin.requestToken,
      requestToken: admin.requestToken,
    });
    const wrongProject = await harness.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      exactRole,
      "--project",
      second,
      "--reason",
      "must not cross Projects",
    ]);
    assertEquals(wrongProject.code, 1);
    const missingRole = await createRequest(harness, admin, [
      "--role",
      exactRole,
      "--project",
      first,
      "--reason",
      "missing role at decision time",
    ]);
    await login(
      harness,
      "inherit-root",
      "all projects inheritance root password",
    );
    const removeExactRole = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "disable",
      user.id,
      "--assignment",
      exactAssignment.id,
      "--expected-version",
      String(exactAssignment.version),
    ]);
    assertEquals(removeExactRole.code, 0, removeExactRole.stderr);
    const missingApproval = await decide(harness, admin.token, missingRole);
    assertEquals(missingApproval.error.code, "authorization_insufficient");

    const pendingPolicyDisable = await createRequest(harness, admin, [
      "--role",
      "system:admin",
      "--project",
      first,
      "--reason",
      "policy current-state cutoff",
    ]);
    const platformPolicy = (await query<{ id: string }>(
      harness.server.sql,
      "select id from policy_assignments where source='platform' and boundary_type='all_projects' and active",
    )).rows[0];
    await query(
      harness.server.sql,
      "update policy_assignments set active=false where id=$1",
      [platformPolicy.id],
    );
    const disabledPolicyDecision = await decide(
      harness,
      admin.token,
      pendingPolicyDisable,
    );
    assertEquals(disabledPolicyDecision.ok, false);
    const authorityWithoutPolicy = await fetchAuthority(
      harness,
      admin.token,
      first,
    );
    assertEquals(authorityWithoutPolicy.data.capabilities, []);
    await query(
      harness.server.sql,
      "update policy_assignments set active=true where id=$1",
      [platformPolicy.id],
    );

    const pendingRoleDisable = await createRequest(harness, admin, [
      "--role",
      "system:admin",
      "--project",
      first,
      "--reason",
      "role current-state cutoff",
    ]);
    await login(
      harness,
      "inherit-root",
      "all projects inheritance root password",
    );
    const disabledRole = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "disable",
      user.id,
      "--assignment",
      assignmentBody.id,
      "--expected-version",
      String(assignmentBody.version),
    ]);
    assertEquals(disabledRole.code, 0, disabledRole.stderr);
    const disabledRoleDecision = await decide(
      harness,
      admin.token,
      pendingRoleDisable,
    );
    assertEquals(disabledRoleDecision.ok, false);
    const authorityWithoutRole = await fetchAuthority(
      harness,
      admin.token,
      first,
    );
    assertEquals(authorityWithoutRole.data.effective_roles, []);
    assertEquals(
      authorityWithoutRole.data.capabilities.some(
        (item: Record<string, unknown>) =>
          item.action === "auth.request.decide",
      ),
      false,
    );
  } finally {
    await harness.close();
  }
});

async function createRequest(
  harness: LiveHarness,
  admin: Stored,
  args: string[],
) {
  await select(harness, {
    token: admin.requestToken,
    requestToken: admin.requestToken,
  });
  const request = await harness.runOptctl([
    "--json",
    "auth",
    "request",
    ...args,
  ]);
  assertEquals(request.code, 0, request.stderr);
  await select(harness, admin);
  return JSON.parse(request.stdout).data.id as string;
}
async function createProject(harness: LiveHarness, slug: string) {
  const result = await harness.runOptctl([
    "--json",
    "project",
    "create",
    slug,
    "--display-name",
    slug,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.id as string;
}
async function stored(harness: LiveHarness): Promise<Stored> {
  const value = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "operant", "auth.json"),
    ),
  );
  return value.origins[new URL(harness.baseUrl).origin];
}
async function decide(harness: LiveHarness, token: string, id: string) {
  const response = await fetch(
    `${harness.baseUrl}/api/v1/auth/requests/${id}/decision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approved" }),
    },
  );
  return await response.json();
}

async function fetchAuthority(
  harness: LiveHarness,
  token: string,
  project: string,
) {
  const url = new URL(`${harness.baseUrl}/api/v1/authorization/authority`);
  url.searchParams.set("boundary_type", "project");
  url.searchParams.set("project_id", project);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  assertEquals(response.status, 200);
  return await response.json();
}

async function login(
  harness: LiveHarness,
  username: string,
  password: string,
) {
  const result = await harness.login({ username, password });
  assertEquals(result.code, 0, result.stderr);
}

async function select(harness: LiveHarness, selected: Partial<Stored>) {
  const path = join(harness.rootDir, "xdg-config", "operant", "auth.json");
  const value = JSON.parse(await Deno.readTextFile(path));
  value.origins[new URL(harness.baseUrl).origin] = {
    ...value.origins[new URL(harness.baseUrl).origin],
    ...selected,
  };
  await Deno.writeTextFile(path, JSON.stringify(value));
}
