import { assertEquals, assertExists } from "jsr:@std/assert";
import { join } from "jsr:@std/path";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

Deno.test("compiled optctl administers and redacts explicit policy assignments", async () => {
  const harness = await startLiveHarness();
  try {
    assertEquals(
      (await harness.bootstrap({
        username: "policy-root",
        password: "policy assignment root password",
      })).code,
      0,
    );
    const projectOne = await createProject(harness, "policy-one");
    const projectTwo = await createProject(harness, "policy-two");

    const createUser = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "policy-admin",
      "--password-stdin",
    ], "policy admin password\n");
    assertEquals(createUser.code, 0, createUser.stderr);
    const user = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='policy-admin'",
    )).rows[0];
    const rootUser = (await query<{ id: string }>(
      harness.server.sql,
      "select id from human_users where username='policy-root'",
    )).rows[0];

    const roleVersionId = uuidV7();
    const policyVersionId = uuidV7();
    const ruleId = uuidV7();
    await query(
      harness.server.sql,
      `insert into system_roles(id,display_name,active,description,axi_summary)
       values('operant/test:reviewer','Reviewer',true,'Reviews test records','Review records conditionally')`,
    );
    await query(
      harness.server.sql,
      `insert into role_definition_versions(id,role_id,version,active)
       values($1,'operant/test:reviewer',1,true)`,
      [roleVersionId],
    );
    await query(
      harness.server.sql,
      `insert into policy_definition_versions(id,policy_id,version,active)
       values($1,'operant/test:conditional_access',1,true)`,
      [policyVersionId],
    );
    await query(
      harness.server.sql,
      `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,summary,predicate)
       values($1,$2,'operant/test:reviewer','read','operant/test:record','abac','Read records owned by the current principal.','owner_id == actor.id')`,
      [ruleId, policyVersionId],
    );

    const roleAssignment = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      user.id,
      "--role",
      "operant/test:reviewer",
      "--project",
      projectOne,
    ]);
    const rootRoleAssignment = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      rootUser.id,
      "--role",
      "operant/test:reviewer",
      "--project",
      projectOne,
    ]);
    const adminAssignment = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      user.id,
      "--role",
      "system:admin",
      "--project",
      projectOne,
    ]);
    assertEquals(roleAssignment.code, 0, roleAssignment.stderr);
    assertEquals(rootRoleAssignment.code, 0, rootRoleAssignment.stderr);
    assertEquals(adminAssignment.code, 0, adminAssignment.stderr);

    const created = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--project",
      projectOne,
    ]);
    assertEquals(created.code, 0, created.stderr);
    const createdAssignment = JSON.parse(created.stdout).data;
    assertEquals(createdAssignment.boundary, {
      type: "project",
      project_id: projectOne,
    });

    const systemCreated = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--boundary",
      "system",
    ]);
    const allProjectsCreated = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--boundary",
      "all_projects",
    ]);
    assertEquals(systemCreated.code, 0, systemCreated.stderr);
    assertEquals(allProjectsCreated.code, 0, allProjectsCreated.stderr);

    const packDefaultId = uuidV7();
    const rootContext = (await query<{ id: string }>(
      harness.server.sql,
      "select id from auth_contexts order by created_at desc limit 1",
    )).rows[0].id;
    await query(
      harness.server.sql,
      `insert into policy_assignments(id,policy_definition_version_id,boundary_type,active,source,created_by_auth_context_id)
       values($1,$2,'all_projects',true,'pack_default',$3)`,
      [packDefaultId, policyVersionId, rootContext],
    );
    const listed = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "list",
      "--active",
      "true",
    ]);
    assertEquals(listed.code, 0, listed.stderr);
    const items = JSON.parse(listed.stdout).data.items as Array<
      Record<string, unknown>
    >;
    const packDefault = items.find((item) => item.id === packDefaultId);
    assertExists(packDefault);
    assertEquals(packDefault.source, "pack_default");
    assertEquals(packDefault.boundary, { type: "all_projects" });

    const login = await harness.login({
      username: "policy-admin",
      password: "policy admin password",
    });
    assertEquals(login.code, 0, login.stderr);
    const bounded = await selectedCredentials(harness);
    const normal = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      projectOne,
    ]);
    assertEquals(normal.code, 0, normal.stderr);
    const normalBody = JSON.parse(normal.stdout).data;
    const conditional = normalBody.capabilities.find((
      item: Record<string, unknown>,
    ) => item.rule_id === ruleId);
    assertEquals(conditional.condition, "abac");
    assertEquals(Object.hasOwn(conditional, "predicate"), false);

    const privilegedDenied = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      projectOne,
      "--include-security",
    ]);
    assertEquals(privilegedDenied.code, 1);
    const privilegedError = JSON.parse(privilegedDenied.stderr);
    assertEquals(privilegedError.error.code, "policy_denied");
    assertEquals(
      /escalat|auth request|grant command/i.test(privilegedDenied.stderr),
      false,
    );

    const exactAllowed = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--project",
      projectOne,
    ]);
    assertEquals(exactAllowed.code, 0, exactAllowed.stderr);
    const wrongBoundary = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--project",
      projectTwo,
    ]);
    assertEquals(wrongBoundary.code, 1);
    assertEquals(JSON.parse(wrongBoundary.stderr).error.code, "policy_denied");

    const missingBoundary = await fetch(
      `${harness.baseUrl}/api/v1/policy-assignments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${bounded.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ policy_revision_id: policyVersionId }),
      },
    );
    assertEquals(missingBoundary.status, 422);
    await missingBoundary.body?.cancel();

    const rootLogin = await harness.login({
      username: "policy-root",
      password: "policy assignment root password",
    });
    assertEquals(rootLogin.code, 0, rootLogin.stderr);
    const privileged = await harness.runOptctl([
      "--json",
      "auth",
      "authority",
      "--project",
      projectOne,
      "--include-security",
    ]);
    assertEquals(privileged.code, 0, privileged.stderr);
    const inspected = JSON.parse(privileged.stdout).data.capabilities.find(
      (item: Record<string, unknown>) => item.rule_id === ruleId,
    );
    assertEquals(inspected.predicate, "owner_id == actor.id");

    const disabled = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "disable",
      "--assignment",
      createdAssignment.id,
      "--expected-version",
      String(createdAssignment.version),
    ]);
    assertEquals(disabled.code, 0, disabled.stderr);
    assertEquals(JSON.parse(disabled.stdout).data.active, false);

    await query(
      harness.server.sql,
      "update policy_definition_versions set active=false where id=$1",
      [policyVersionId],
    );
    const disabledDefinition = await harness.runOptctl([
      "--json",
      "policy",
      "assignment",
      "create",
      "--policy-revision",
      policyVersionId,
      "--project",
      projectOne,
    ]);
    assertEquals(disabledDefinition.code, 1);
    assertEquals(JSON.parse(disabledDefinition.stderr).error.code, "not_found");

    await query(
      harness.server.sql,
      "update system_roles set active=false where id='operant/test:reviewer'",
    );
    const disabledRole = await harness.runOptctl([
      "--json",
      "assignment",
      "role",
      "create",
      rootUser.id,
      "--role",
      "operant/test:reviewer",
      "--project",
      projectTwo,
    ]);
    assertEquals(disabledRole.code, 1);
    assertEquals(JSON.parse(disabledRole.stderr).error.code, "not_found");
  } finally {
    await harness.close();
  }
});

async function createProject(
  harness: LiveHarness,
  slug: string,
): Promise<string> {
  const result = await harness.runOptctl([
    "--json",
    "project",
    "create",
    slug,
    "--display-name",
    slug,
  ]);
  assertEquals(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).data.id;
}
async function selectedCredentials(
  harness: LiveHarness,
): Promise<{ token: string }> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "optd", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
