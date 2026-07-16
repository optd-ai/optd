import { assertEquals, assertMatch } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";

Deno.test("compiled optctl resolves current explicit assignment boundaries and safe denial", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "root",
        password: "authorization root password",
      })).code,
      0,
    );
    const root = await selectedCredentials(harness);
    const createdUser = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "bounded-admin",
      "--password-stdin",
    ], "bounded admin password\n");
    assertEquals(createdUser.code, 0, createdUser.stderr);
    const userId = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='bounded-admin'",
    )).rows[0].id;
    const first = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "first",
      "--display-name",
      "First",
    ]);
    const second = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "second",
      "--display-name",
      "Second",
    ]);
    assertEquals(first.code, 0, first.stderr);
    assertEquals(second.code, 0, second.stderr);
    const firstId = JSON.parse(first.stdout).data.id as string;
    const secondId = JSON.parse(second.stdout).data.id as string;

    const assigned = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      userId,
      "--role",
      "system:admin",
      "--project",
      firstId,
    ]);
    assertEquals(assigned.code, 0, assigned.stderr);
    const assignment = JSON.parse(assigned.stdout).data;

    const login = await harness.login({
      username: "bounded-admin",
      password: "bounded admin password",
    });
    assertEquals(login.code, 0, login.stderr);
    const bounded = await selectedCredentials(harness);
    const allowed = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      firstId,
    ]);
    assertEquals(allowed.code, 0, allowed.stderr);
    assertEquals(JSON.parse(allowed.stdout).data.effective_roles, [
      "system:admin",
    ]);
    const empty = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      secondId,
    ]);
    assertEquals(empty.code, 0, empty.stderr);
    assertEquals(JSON.parse(empty.stdout).data.effective_roles, []);

    const denial = await fetch(
      `${harness.baseUrl}/api/v1/auth/users/${userId}/role-assignments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bounded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          role: "system:admin",
          boundary: { type: "project", project_id: secondId },
        }),
      },
    );
    assertEquals(denial.status, 403);
    const deniedBody = await denial.json();
    assertEquals(deniedBody.error.code, "policy_denied");
    assertMatch(deniedBody.error.message, /^current authority does not allow /);
    assertEquals(
      /auth request|grant command|escalat/i.test(JSON.stringify(deniedBody)),
      false,
    );
    const denialAudit = await query<{ event_type: string; details: unknown }>(
      harness.server.sql,
      "select event_type,details from authorization_audit_events where event_type='policy.denied' order by created_at desc limit 1",
    );
    assertEquals(denialAudit.rows[0].event_type, "policy.denied");
    assertEquals(
      JSON.stringify(denialAudit.rows[0].details).includes("token"),
      false,
    );

    const injected = await fetch(
      `${harness.baseUrl}/api/v1/auth/users/${userId}/role-assignments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bounded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          role: "system:admin",
          boundary: { type: "project", project_id: firstId },
          attributes: { roles: ["system:super_admin"] },
        }),
      },
    );
    assertEquals(injected.status, 422);
    await injected.body?.cancel();

    await selectCredentials(harness, root);
    const disabled = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "disable",
      userId,
      "--assignment",
      assignment.id,
      "--expected-version",
      String(assignment.version),
    ]);
    assertEquals(disabled.code, 0, disabled.stderr);
    await selectCredentials(harness, bounded);
    const revoked = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      firstId,
    ]);
    assertEquals(revoked.code, 0, revoked.stderr);
    assertEquals(JSON.parse(revoked.stdout).data.effective_roles, []);

    await selectCredentials(harness, root);
    const allProjects = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      userId,
      "--role",
      "system:admin",
      "--boundary",
      "all_projects",
    ]);
    const system = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      userId,
      "--role",
      "system:admin",
      "--boundary",
      "system",
    ]);
    assertEquals(allProjects.code, 0, allProjects.stderr);
    assertEquals(system.code, 0, system.stderr);
    await selectCredentials(harness, bounded);
    const inheritedAllProjects = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      secondId,
    ]);
    const explicitSystem = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--boundary",
      "system",
    ]);
    assertEquals(
      JSON.parse(inheritedAllProjects.stdout).data.effective_roles,
      ["system:admin"],
    );
    assertEquals(JSON.parse(explicitSystem.stdout).data.effective_roles, [
      "system:admin",
    ]);

    await selectCredentials(harness, root);
    const rootUser = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='root'",
    )).rows[0];
    const grantedSuperAdmin = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      userId,
      "--role",
      "system:super_admin",
      "--boundary",
      "system",
    ]);
    assertEquals(grantedSuperAdmin.code, 0, grantedSuperAdmin.stderr);
    const granted = JSON.parse(grantedSuperAdmin.stdout).data;
    const original = (await query<{ id: string; version: number }>(
      harness.server.sql,
      `select ra.id,ra.version::int version from role_assignments ra
       join human_users u on u.principal_id=ra.principal_id
       where u.id=$1 and ra.role_id='system:super_admin' and ra.active`,
      [rootUser.id],
    )).rows[0];
    await selectCredentials(harness, bounded);
    const removeOriginal = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "disable",
      rootUser.id,
      "--assignment",
      original.id,
      "--expected-version",
      String(original.version),
    ]);
    assertEquals(removeOriginal.code, 0, removeOriginal.stderr);
    const rejectFinal = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "disable",
      userId,
      "--assignment",
      granted.id,
      "--expected-version",
      String(granted.version),
    ]);
    assertEquals(rejectFinal.code, 1);
    assertEquals(
      JSON.parse(rejectFinal.stderr).error.code,
      "last_human_super_admin",
    );
    const invariant = await query<
      { active_humans: number; rejected_audits: number }
    >(
      harness.server.sql,
      `select
        (select count(distinct u.id)::int from human_users u join role_assignments ra on ra.principal_id=u.principal_id where u.status='active' and ra.active and ra.role_id='system:super_admin') active_humans,
        (select count(*)::int from authorization_audit_events where event_type='role_assignment.disable_rejected' and assignment_id=$1) rejected_audits`,
      [granted.id],
    );
    assertEquals(invariant.rows[0], { active_humans: 1, rejected_audits: 1 });
  } finally {
    await harness.close();
  }
});

async function selectedCredentials(
  harness: LiveHarness,
): Promise<{ token: string }> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "operant", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
async function selectCredentials(
  harness: LiveHarness,
  credentials: { token: string },
) {
  const path = join(harness.rootDir, "xdg-config", "operant", "auth.json");
  const store = JSON.parse(await Deno.readTextFile(path));
  store.origins[new URL(harness.baseUrl).origin] = {
    ...store.origins[new URL(harness.baseUrl).origin],
    ...credentials,
  };
  await Deno.writeTextFile(path, JSON.stringify(store));
}
