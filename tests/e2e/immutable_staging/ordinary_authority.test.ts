import { assert, assertEquals } from "jsr:@std/assert@1";
import { join } from "jsr:@std/path";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

Deno.test({
  name:
    "ordinary principals stage and access only under current Project authority",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const harness = await startLiveHarness();
    try {
      assertEquals(
        (await harness.bootstrap({
          username: "authority-root",
          password: "Authority-root-password-42!",
        })).code,
        0,
      );
      const alpha = await createProject(harness, "authority-alpha");
      const beta = await createProject(harness, "authority-beta");
      await applyAuthorityPack(harness);
      const rootAuth = (await query<{ id: string }>(
        harness.server.sql,
        "select id from auth_contexts order by created_at desc limit 1",
      )).rows[0].id;
      await createUser(harness, "stage-human", "Stage-human-password-42!");
      await createUser(harness, "stage-other", "Stage-other-password-42!");
      const human = await identity(harness, "stage-human");
      const other = await identity(harness, "stage-other");
      const humanProcess = await harness.loginProcess({
        username: "stage-human",
        password: "Stage-human-password-42!",
      });
      const otherProcess = await harness.loginProcess({
        username: "stage-other",
        password: "Stage-other-password-42!",
      });
      assertEquals(humanProcess.result.code, 0, humanProcess.result.stderr);
      assertEquals(otherProcess.result.code, 0, otherProcess.result.stderr);
      const facts = await seedObjects(harness, alpha, beta, rootAuth, human);
      const baseline = await stageCount(harness);
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        create(alpha, 50),
      );
      assertEquals(await stageCount(harness), baseline);

      const authority = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:writer",
        actions: ["create", "update", "link"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
      });
      const exact = await stage(
        harness,
        humanProcess.launcher,
        create(alpha, 50),
      );
      assertEquals(exact.code, 0, exact.stderr);

      await query(
        harness.server.sql,
        "update role_assignments set boundary_type='all_projects',project_id=null where id=$1",
        [authority.roleAssignment],
      );
      await query(
        harness.server.sql,
        "update policy_assignments set boundary_type='all_projects',project_id=null where id=$1",
        [authority.policyAssignment],
      );
      const allProjects = await stage(
        harness,
        humanProcess.launcher,
        create(beta, 50),
      );
      assertEquals(allProjects.code, 0, allProjects.stderr);

      await query(
        harness.server.sql,
        "update role_assignments set boundary_type='system',project_id=null where id=$1",
        [authority.roleAssignment],
      );
      await query(
        harness.server.sql,
        "update policy_assignments set boundary_type='system',project_id=null where id=$1",
        [authority.policyAssignment],
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        create(alpha, 50),
      );
      await query(
        harness.server.sql,
        "update role_assignments set boundary_type='project',project_id=$2 where id=$1",
        [authority.roleAssignment, alpha],
      );
      await query(
        harness.server.sql,
        "update policy_assignments set active=false,disabled_at=now() where id=$1",
        [authority.policyAssignment],
      );

      const abac = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:abac",
        actions: ["create", "update"],
        condition: "abac",
        predicate: "score >= 40",
        boundary: "project",
        rootAuth,
      });
      assertEquals(
        (await stage(harness, humanProcess.launcher, create(alpha, 40))).code,
        0,
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        create(alpha, 39),
      );
      assertEquals(
        (await stage(
          harness,
          humanProcess.launcher,
          update(alpha, facts.low, 45),
        )).code,
        0,
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.high, 10),
      );
      await disableAuthority(harness, abac);

      const actor = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:actor",
        actions: ["update"],
        condition: "rebac",
        relationSubject: "actor.id",
        boundary: "project",
        rootAuth,
      });
      assertEquals(
        (await stage(
          harness,
          humanProcess.launcher,
          update(alpha, facts.actor, 51),
        )).code,
        0,
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.human, 51),
      );
      await disableAuthority(harness, actor);

      const humanRelation = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:human",
        actions: ["update"],
        condition: "rebac",
        relationSubject: "actor.human_user_id",
        boundary: "project",
        rootAuth,
      });
      assertEquals(
        (await stage(
          harness,
          humanProcess.launcher,
          update(alpha, facts.human, 52),
        )).code,
        0,
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.actor, 52),
      );
      await disableAuthority(harness, humanRelation);

      const combined = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:combined",
        actions: ["update"],
        condition: "rebac",
        predicate: "score >= 40",
        relationSubject: "actor.id",
        boundary: "project",
        rootAuth,
      });
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.whereOnly, 55),
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.relationOnly, 10),
      );
      assertEquals(
        (await stage(
          harness,
          humanProcess.launcher,
          update(alpha, facts.both, 55),
        )).code,
        0,
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.neither, 10),
      );
      await expectStageDenied(
        harness,
        humanProcess.launcher,
        update(alpha, facts.crossProjectEdge, 55),
      );
      await disableAuthority(harness, combined);

      await query(
        harness.server.sql,
        "update role_assignments set active=true,disabled_at=null where id=any($1::uuid[])",
        [[actor.roleAssignment, humanRelation.roleAssignment]],
      );
      await seedAgentDecidePolicy(harness, alpha);
      const agent = await createPublicAgent(
        harness,
        humanProcess.launcher,
        alpha,
      );
      await query(
        harness.server.sql,
        `insert into ${quoteIdentifier(facts.viewerTable)}
         (id,project_id,from_object_id,to_object_id,created_by,updated_by)
         values($1,$2,$3,$4,$5,$5)`,
        [uuidV7(), alpha, facts.actor, agent.principal, rootAuth],
      );
      await query(
        harness.server.sql,
        "update policy_assignments set active=true,disabled_at=null where id=any($1::uuid[])",
        [[actor.policyAssignment, humanRelation.policyAssignment]],
      );
      const agentAllowed = await stage(
        harness,
        agent.launcher,
        update(alpha, facts.actor, 53),
      );
      assertEquals(agentAllowed.code, 0, agentAllowed.stderr);
      await expectStageDenied(
        harness,
        agent.launcher,
        update(alpha, facts.human, 53),
      );
      await mutateAfterAuthority(
        harness,
        facts.actor,
        () => stage(harness, agent.launcher, update(alpha, facts.actor, 55)),
        () =>
          query(
            harness.server.sql,
            "update agent_authorizations set superseded_at=now() where id=$1",
            [agent.authorization],
          ),
        "%update agent_authorizations%",
      );
      const beforeInvalidAncestor = await stageCount(harness);
      const invalidAncestor = await stage(
        harness,
        agent.launcher,
        update(alpha, facts.actor, 56),
      );
      assertEquals(invalidAncestor.code, 1, invalidAncestor.stderr);
      assertEquals(
        JSON.parse(invalidAncestor.stderr).error.code,
        "authorization_insufficient",
      );
      assert(
        !/agent_authorizations|select |superseded/i.test(
          invalidAncestor.stderr,
        ),
      );
      assertEquals(await stageCount(harness), beforeInvalidAncestor);
      await query(
        harness.server.sql,
        "update agent_authorizations set superseded_at=null where id=$1",
        [agent.authorization],
      );
      await query(
        harness.server.sql,
        "update policy_assignments set active=false,disabled_at=now() where id=any($1::uuid[])",
        [[actor.policyAssignment, humanRelation.policyAssignment]],
      );

      await query(
        harness.server.sql,
        "update policy_assignments set active=true,disabled_at=null where id=$1",
        [authority.policyAssignment],
      );
      const beforeMulti = await stageCount(harness);
      await expectStageDenied(harness, humanProcess.launcher, {
        operations: [
          create(alpha, 50).operations[0],
          create(beta, 50).operations[0],
        ],
      });
      assertEquals(await stageCount(harness), beforeMulti);

      const creatorStage = JSON.parse(exact.stdout).data.id as string;
      const freshLogin = await humanProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-human",
        "--password-stdin",
      ], "Stage-human-password-42!\n");
      assertEquals(freshLogin.code, 0, freshLogin.stderr);
      assertEquals(
        (await inspect(humanProcess.launcher, creatorStage)).code,
        0,
      );
      const otherRelogin = await otherProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-other",
        "--password-stdin",
      ], "Stage-other-password-42!\n");
      assertEquals(otherRelogin.code, 0, otherRelogin.stderr);
      await expectHidden(otherProcess.launcher, "inspect", creatorStage);
      await expectHidden(otherProcess.launcher, "cancel", creatorStage);

      const inspectGrant = await installAuthority(harness, {
        principal: other.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:inspector",
        actions: ["changeset.inspect"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
        resource: "*",
      });
      assertEquals(
        (await inspect(otherProcess.launcher, creatorStage)).code,
        0,
      );
      await expectHidden(otherProcess.launcher, "cancel", creatorStage);
      const cancelGrant = await installAuthority(harness, {
        principal: other.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:canceller",
        actions: ["changeset.cancel"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
        resource: "*",
      });
      assertEquals((await cancel(otherProcess.launcher, creatorStage)).code, 0);

      const alphaMultiAuthority = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:alpha-multi-writer",
        actions: ["create"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
      });
      const multiAuthority = await installAuthority(harness, {
        principal: human.principal_id,
        project: beta,
        candidate: facts.candidate,
        role: "test/stage:beta-writer",
        actions: ["create"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
      });
      const humanMultiLogin = await humanProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-human",
        "--password-stdin",
      ], "Stage-human-password-42!\n");
      assertEquals(humanMultiLogin.code, 0, humanMultiLogin.stderr);
      const multi = await stage(harness, humanProcess.launcher, {
        operations: [
          create(alpha, 61).operations[0],
          create(beta, 62).operations[0],
        ],
      });
      assertEquals(multi.code, 0, multi.stderr);
      const multiId = JSON.parse(multi.stdout).data.id;
      const otherMultiLogin = await otherProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-other",
        "--password-stdin",
      ], "Stage-other-password-42!\n");
      assertEquals(otherMultiLogin.code, 0, otherMultiLogin.stderr);
      await expectHidden(otherProcess.launcher, "inspect", multiId);
      await installAuthority(harness, {
        principal: other.principal_id,
        project: beta,
        candidate: facts.candidate,
        role: "test/stage:beta-inspector",
        actions: ["changeset.inspect"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
        resource: "*",
      });
      assertEquals((await inspect(otherProcess.launcher, multiId)).code, 0);

      await query(
        harness.server.sql,
        "update projects set status='archived',version=version+1 where id=$1",
        [beta],
      );
      await expectHidden(otherProcess.launcher, "inspect", multiId);
      const inactive = await stage(
        harness,
        humanProcess.launcher,
        create(beta, 70),
      );
      assertEquals(inactive.code, 1);
      assertEquals(JSON.parse(inactive.stderr).error.code, "project_inactive");
      await query(
        harness.server.sql,
        "update projects set status='active',version=version+1 where id=$1",
        [beta],
      );
      const humanRaceLogin = await humanProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-human",
        "--password-stdin",
      ], "Stage-human-password-42!\n");
      assertEquals(humanRaceLogin.code, 0, humanRaceLogin.stderr);
      await disableAuthority(harness, alphaMultiAuthority);
      await disableAuthority(harness, authority);
      const raceAuthority = await installAuthority(harness, {
        principal: human.principal_id,
        project: alpha,
        candidate: facts.candidate,
        role: "test/stage:race-writer",
        actions: ["create", "update"],
        condition: "unconditional",
        boundary: "project",
        rootAuth,
      });

      await proveAuthorityOrdering(
        harness,
        humanProcess.launcher,
        alpha,
        facts,
        raceAuthority,
        rootAuth,
      );
      const otherRaceLogin = await otherProcess.launcher.runOptctl([
        "--json",
        "auth",
        "login",
        "--username",
        "stage-other",
        "--password-stdin",
      ], "Stage-other-password-42!\n");
      assertEquals(otherRaceLogin.code, 0, otherRaceLogin.stderr);
      await proveAccessOrdering(
        harness,
        otherProcess.launcher,
        creatorStage,
        alpha,
        inspectGrant,
        cancelGrant,
      );
      await disableAuthority(harness, multiAuthority);
    } catch (error) {
      console.error(await harness.diagnostics());
      throw error;
    } finally {
      await harness.close();
    }
  },
});

function create(project: string, score: number) {
  return {
    project_id: project,
    operations: [{
      op: "create",
      project_id: project,
      resource: "test/stage:item",
      fields: { name: `score-${score}-${uuidV7()}`, score },
    }],
  };
}
function update(project: string, object: string, score: number) {
  return {
    project_id: project,
    operations: [{
      op: "update",
      project_id: project,
      resource: "test/stage:item",
      object_id: object,
      set: { score },
    }],
  };
}
async function stage(
  harness: LiveHarness,
  launcher: CliLauncher,
  body: unknown,
) {
  return await harness.runJson(
    ["--json", "changeset", "stage"],
    body,
    launcher,
  );
}
async function inspect(launcher: CliLauncher, id: string) {
  return await launcher.runOptctl(["--json", "changeset", "inspect", id]);
}
async function cancel(launcher: CliLauncher, id: string) {
  return await launcher.runOptctl(["--json", "changeset", "cancel", id]);
}
async function expectStageDenied(
  harness: LiveHarness,
  launcher: CliLauncher,
  body: unknown,
) {
  const result = await stage(harness, launcher, body);
  assertEquals(result.code, 1, result.stdout);
  const parsed = JSON.parse(result.stderr);
  assert(
    ["policy_denied", "authorization_insufficient"].includes(parsed.error.code),
    result.stderr,
  );
  assert(!/policy_rules|select |relation_/i.test(result.stderr), result.stderr);
}
async function expectHidden(
  launcher: CliLauncher,
  action: "inspect" | "cancel",
  id: string,
) {
  const result = action === "inspect"
    ? await inspect(launcher, id)
    : await cancel(launcher, id);
  assertEquals(result.code, 1, result.stdout);
  assertEquals(JSON.parse(result.stderr).error.code, "not_found");
  assert(!/policy_rules|select |project/i.test(result.stderr), result.stderr);
}
async function stageCount(harness: LiveHarness) {
  return Number(
    (await query<{ count: string }>(
      harness.server.sql,
      "select count(*)::text count from staged_changesets",
    )).rows[0].count,
  );
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
    "--password-stdin",
  ], `${password}\n`);
  assertEquals(result.code, 0, result.stderr);
}
type StoredAuthState = { token: string; requestToken: string };
async function storedAuthState(harness: LiveHarness): Promise<StoredAuthState> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "operant", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}
async function selectStoredCredential(
  harness: LiveHarness,
  update: { token?: string; requestToken?: string },
) {
  const path = join(harness.rootDir, "xdg-config", "operant", "auth.json");
  const store = JSON.parse(await Deno.readTextFile(path));
  const origin = new URL(harness.baseUrl).origin;
  store.origins[origin] = { ...store.origins[origin], ...update };
  if (update.token === undefined) delete store.origins[origin].token;
  if (update.requestToken === undefined) {
    delete store.origins[origin].requestToken;
  }
  await Deno.writeTextFile(path, JSON.stringify(store));
}
async function createPublicAgent(
  harness: LiveHarness,
  approver: CliLauncher,
  project: string,
) {
  assertEquals(
    (await harness.login({
      username: "stage-human",
      password: "Stage-human-password-42!",
    })).code,
    0,
  );
  const requesterState = await storedAuthState(harness);
  const requestLauncher = await harness.createProcessTreeLauncher(
    "request_only",
  );
  const agentLauncher = await harness.createAgentLauncher();
  await selectStoredCredential(harness, {
    token: undefined,
    requestToken: requesterState.requestToken,
  });
  const requested = await requestLauncher.runOptctl([
    "--json",
    "auth",
    "request",
    "--role",
    "test/stage:actor",
    "--role",
    "test/stage:human",
    "--project",
    project,
    "--reason",
    "ordinary stage agent",
  ]);
  assertEquals(requested.code, 0, requested.stderr);
  const requestId = JSON.parse(requested.stdout).data.id as string;
  const approved = await approver.runOptctl([
    "--json",
    "auth",
    "approve",
    requestId,
    "--yes",
    "--agent-name",
    "ordinary-stage-agent",
  ]);
  assertEquals(approved.code, 0, approved.stderr);
  await selectStoredCredential(harness, {
    token: undefined,
    requestToken: requesterState.requestToken,
  });
  const waited = await agentLauncher.runOptctl([
    "--json",
    "auth",
    "wait",
    requestId,
  ]);
  assertEquals(waited.code, 0, waited.stderr);
  const authorization = (await query<{ authorization_id: string }>(
    harness.server.sql,
    "select authorization_id from agent_authorization_requests where id=$1",
    [requestId],
  )).rows[0].authorization_id;
  const principal = (await query<{ principal_id: string }>(
    harness.server.sql,
    `select u.principal_id from agent_authorizations a
     join agent_users u on u.id=a.agent_user_id where a.id=$1`,
    [authorization],
  )).rows[0].principal_id;
  return { launcher: agentLauncher, authorization, principal };
}

async function seedAgentDecidePolicy(
  harness: LiveHarness,
  project: string,
) {
  const version = uuidV7();
  await query(
    harness.server.sql,
    "insert into policy_definition_versions(id,policy_id,version,active) values($1,'test/stage:agent_decider',1,true)",
    [version],
  );
  await query(
    harness.server.sql,
    "insert into policy_rules(id,policy_definition_version_id,role_id,capability) values($1,$2,'test/stage:actor','auth.request.decide')",
    [uuidV7(), version],
  );
  await query(
    harness.server.sql,
    "insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active) values($1,$2,'project',$3,true)",
    [uuidV7(), version, project],
  );
}

async function identity(harness: LiveHarness, username: string) {
  return (await query<{ principal_id: string; human_user_id: string }>(
    harness.server.sql,
    "select principal_id,h.id human_user_id from human_users h where username=$1",
    [username],
  )).rows[0];
}

async function applyAuthorityPack(harness: LiveHarness) {
  const pack = join(harness.rootDir, "authority-pack");
  await Deno.mkdir(join(pack, "resources"), { recursive: true });
  await Deno.mkdir(join(pack, "relationships"), { recursive: true });
  await Deno.writeTextFile(
    join(pack, "pack.yaml"),
    JSON.stringify({
      kind: "Pack",
      apiVersion: "operant.dev/v1",
      metadata: { publisher: "test", name: "stage", version: "1.0.0" },
      spec: { purpose: "ordinary authority", axi: {} },
    }),
  );
  await Deno.writeTextFile(
    join(pack, "resources", "item.yaml"),
    JSON.stringify({
      kind: "Resource",
      apiVersion: "operant.dev/v1",
      metadata: { name: "item" },
      spec: {
        fields: {
          name: { type: "string", required: true },
          score: { type: "integer", required: true },
        },
        axi: {},
      },
    }),
  );
  await Deno.writeTextFile(
    join(pack, "relationships", "viewer.yaml"),
    JSON.stringify({
      kind: "Relationship",
      apiVersion: "operant.dev/v1",
      metadata: { name: "viewer" },
      spec: {
        from: { resource: "test/stage:item" },
        to: { resource: "system:principal" },
        fields: {},
        axi: {},
      },
    }),
  );
  const apply = await harness.runOptctl([
    "--json",
    "pack",
    "apply",
    pack,
    "--safe",
  ]);
  assertEquals(apply.code, 0, apply.stderr);
}

type Authority = {
  roleAssignment: string;
  policyAssignment: string;
  policyVersion: string;
  ruleIds: string[];
};
async function installAuthority(
  harness: LiveHarness,
  input: {
    principal: string;
    project: string;
    candidate: string;
    role: string;
    actions: string[];
    condition: "unconditional" | "abac" | "rebac";
    predicate?: string;
    relationSubject?: "actor.id" | "actor.human_user_id";
    boundary: "project" | "all_projects" | "system";
    rootAuth: string;
    resource?: string;
  },
): Promise<Authority> {
  const roleVersion = uuidV7(),
    policyVersion = uuidV7(),
    roleAssignment = uuidV7(),
    policyAssignment = uuidV7();
  const ruleIds: string[] = [];
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      "insert into system_roles(id,display_name,active) values($1,$1,true)",
      [input.role],
    );
    await query(
      tx,
      "insert into role_definition_versions(id,role_id,version,active,candidate_revision_id,definition_name) values($1,$2,1,true,$3,$4)",
      [roleVersion, input.role, input.candidate, input.role.split(":")[1]],
    );
    await query(
      tx,
      "insert into policy_definition_versions(id,policy_id,version,active,candidate_revision_id,definition_name) values($1,$2,1,true,$3,$4)",
      [
        policyVersion,
        `${input.role}:policy`,
        input.candidate,
        input.role.split(":")[1],
      ],
    );
    for (const action of input.actions) {
      const rule = uuidV7();
      ruleIds.push(rule);
      await query(
        tx,
        `insert into policy_rules(id,policy_definition_version_id,role_id,capability,resource,condition_kind,predicate,rule_name,relation_relationship,relation_object_side,relation_subject_side,relation_subject)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,'from','to',$10)`,
        [
          rule,
          policyVersion,
          input.role,
          action,
          input.resource ?? "test/stage:item",
          input.condition,
          input.predicate ?? null,
          action.replace(".", "_"),
          input.relationSubject ? "test/stage:viewer" : null,
          input.relationSubject ?? null,
        ],
      );
    }
    await query(
      tx,
      `insert into role_assignments(id,principal_id,role_id,boundary_type,project_id,active,created_by_auth_context_id) values($1,$2,$3,$4,$5,true,$6)`,
      [
        roleAssignment,
        input.principal,
        input.role,
        input.boundary,
        input.boundary === "project" ? input.project : null,
        input.rootAuth,
      ],
    );
    await query(
      tx,
      `insert into policy_assignments(id,policy_definition_version_id,boundary_type,project_id,active,source,created_by_auth_context_id) values($1,$2,$3,$4,true,'operator',$5)`,
      [
        policyAssignment,
        policyVersion,
        input.boundary,
        input.boundary === "project" ? input.project : null,
        input.rootAuth,
      ],
    );
  });
  return { roleAssignment, policyAssignment, policyVersion, ruleIds };
}
async function disableAuthority(harness: LiveHarness, authority: Authority) {
  await query(
    harness.server.sql,
    "update role_assignments set active=false,disabled_at=now() where id=$1",
    [authority.roleAssignment],
  );
  await query(
    harness.server.sql,
    "update policy_assignments set active=false,disabled_at=now() where id=$1",
    [authority.policyAssignment],
  );
}

async function seedObjects(
  harness: LiveHarness,
  alpha: string,
  beta: string,
  auth: string,
  human: { principal_id: string; human_user_id: string },
) {
  const metadata = (await query<
    { candidate: string; item_table: string; viewer_table: string }
  >(
    harness.server.sql,
    `select ar.candidate_revision_id candidate,
    (select table_name from pack_runtime_tables where publisher='test' and pack_name='stage' and definition_kind='resource' and definition_name='item') item_table,
    (select table_name from pack_runtime_tables where publisher='test' and pack_name='stage' and definition_kind='relationship' and definition_name='viewer') viewer_table
    from pack_active_revisions ar where publisher='test' and pack_name='stage'`,
  )).rows[0];
  const names = [
    "low",
    "high",
    "actor",
    "human",
    "whereOnly",
    "relationOnly",
    "both",
    "neither",
    "crossProjectEdge",
  ] as const;
  const values = Object.fromEntries(
    names.map((name) => [name, uuidV7()]),
  ) as Record<typeof names[number], string>;
  for (const [name, id] of Object.entries(values)) {
    const project = name === "crossProjectEdge" ? alpha : alpha;
    const score =
      ["high", "whereOnly", "both", "crossProjectEdge"].includes(name) ? 50 : 5;
    const commit = await prerequisiteCommit(harness, auth), version = uuidV7();
    await query(
      harness.server.sql,
      `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id)
      values($1,$2,'resource','test/stage:item',$3,1,$4,'create',$5,$6::jsonb,array['name','score'],$7)`,
      [version, project, id, commit, metadata.candidate, {
        data: { name, score },
        archived_at: null,
      }, auth],
    );
    await query(
      harness.server.sql,
      `insert into ${
        quoteIdentifier(metadata.item_table)
      }(id,project_id,version,current_object_version_id,created_by,updated_by,name,score) values($1,$2,1,$3,$6,$6,$4,$5)`,
      [id, project, version, name, score, auth],
    );
  }
  const edges = [
    [values.actor, human.principal_id, alpha],
    [values.human, human.human_user_id, alpha],
    [values.relationOnly, human.principal_id, alpha],
    [values.both, human.principal_id, alpha],
    [values.crossProjectEdge, human.principal_id, beta],
  ];
  for (const [object, subject, project] of edges) {
    await query(
      harness.server.sql,
      `insert into ${
        quoteIdentifier(metadata.viewer_table)
      }(id,project_id,from_object_id,to_object_id,created_by,updated_by) values($1,$2,$3,$4,$5,$5)`,
      [uuidV7(), project, object, subject, auth],
    );
  }
  return {
    candidate: metadata.candidate,
    viewerTable: metadata.viewer_table,
    ...values,
  };
}
async function prerequisiteCommit(harness: LiveHarness, auth: string) {
  const stageId = uuidV7(),
    commitId = uuidV7(),
    digest = `sha256:${"0".repeat(64)}`;
  await harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `insert into staged_changesets(id,schema_version,source_kind,source_identity_json,created_auth_context_id,created_principal_id,creating_context_json,operation_graph_digest,stage_digest,canonical_graph_json,projects_json,pack_revisions_json,warnings_json,planned_events_json,planned_deliveries_json) values($1,1,'seed','{}',$2,(select principal_id from auth_contexts where id=$2),'{}',$3,$3,'{}','[]','[]','[]','[]','[]')`,
      [stageId, auth, digest],
    );
    await query(
      tx,
      "insert into staged_changeset_lifecycle(stage_id,status,version,committed_at) values($1,'committed',1,now())",
      [stageId],
    );
    await query(
      tx,
      "insert into changeset_commits(id,stage_id,committed_auth_context_id,authorization_cutoff_at,operation_graph_digest) values($1,$2,$3,now(),$4)",
      [commitId, stageId, auth, digest],
    );
  });
  return commitId;
}

async function proveAuthorityOrdering(
  harness: LiveHarness,
  launcher: CliLauncher,
  project: string,
  facts: { high: string },
  authority: Authority,
  rootAuth: string,
) {
  await query(
    harness.server.sql,
    "update policy_assignments set active=true,disabled_at=null where id=$1",
    [authority.policyAssignment],
  );
  await query(
    harness.server.sql,
    "update role_assignments set active=true,disabled_at=null,boundary_type='project',project_id=$2 where id=$1",
    [authority.roleAssignment, project],
  );
  const before = await stageCount(harness);
  await mutateBeforeAuthority(
    harness,
    () => stage(harness, launcher, create(project, 80)),
    () =>
      query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [authority.roleAssignment],
      ),
  );
  assertEquals(await stageCount(harness), before);
  await query(
    harness.server.sql,
    "update role_assignments set active=true,disabled_at=null where id=$1",
    [authority.roleAssignment],
  );
  const raceSmoke = await stage(
    harness,
    launcher,
    update(project, facts.high, 79),
  );
  assertEquals(raceSmoke.code, 0, raceSmoke.stderr);
  await mutateAfterAuthority(
    harness,
    facts.high,
    () => stage(harness, launcher, update(project, facts.high, 81)),
    () =>
      query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [authority.roleAssignment],
      ),
    "%update role_assignments%",
  );
  await expectStageDenied(harness, launcher, update(project, facts.high, 82));
  await query(
    harness.server.sql,
    "update role_assignments set active=true,disabled_at=null where id=$1",
    [authority.roleAssignment],
  );

  const beforePolicy = await stageCount(harness);
  await mutateBeforeAuthority(
    harness,
    () => stage(harness, launcher, create(project, 83)),
    () =>
      query(
        harness.server.sql,
        "update policy_definition_versions set active=false where id=$1",
        [authority.policyVersion],
      ),
  );
  assertEquals(await stageCount(harness), beforePolicy);
  await query(
    harness.server.sql,
    "update policy_definition_versions set active=true where id=$1",
    [authority.policyVersion],
  );
  await mutateAfterAuthority(
    harness,
    facts.high,
    () => stage(harness, launcher, update(project, facts.high, 84)),
    () =>
      query(
        harness.server.sql,
        "update policy_definition_versions set active=false where id=$1",
        [authority.policyVersion],
      ),
    "%update policy_definition_versions%",
  );
  await expectStageDenied(harness, launcher, update(project, facts.high, 85));
  await query(
    harness.server.sql,
    "update policy_definition_versions set active=true where id=$1",
    [authority.policyVersion],
  );

  const beforeProject = await stageCount(harness);
  await mutateBeforeAuthority(
    harness,
    () => stage(harness, launcher, create(project, 86)),
    () =>
      query(
        harness.server.sql,
        "update projects set status='archived',version=version+1 where id=$1",
        [project],
      ),
  );
  assertEquals(await stageCount(harness), beforeProject);
  await query(
    harness.server.sql,
    "update projects set status='active',version=version+1 where id=$1",
    [project],
  );
  await mutateAfterAuthority(
    harness,
    facts.high,
    () => stage(harness, launcher, update(project, facts.high, 87)),
    () =>
      query(
        harness.server.sql,
        "update projects set status='archived',version=version+1 where id=$1",
        [project],
      ),
    "%update projects%",
  );
  const projectDenied = await stage(
    harness,
    launcher,
    update(project, facts.high, 88),
  );
  assertEquals(projectDenied.code, 1, projectDenied.stderr);
  assertEquals(JSON.parse(projectDenied.stderr).error.code, "project_inactive");
  await query(
    harness.server.sql,
    "update projects set status='active',version=version+1 where id=$1",
    [project],
  );
  void rootAuth;
}
async function proveAccessOrdering(
  harness: LiveHarness,
  launcher: CliLauncher,
  stageId: string,
  _projectId: string,
  inspectGrant: Authority,
  cancelGrant: Authority,
) {
  await mutateBeforeAuthority(
    harness,
    () => inspect(launcher, stageId),
    () =>
      query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [inspectGrant.roleAssignment],
      ),
  );
  await query(
    harness.server.sql,
    "update role_assignments set active=true,disabled_at=null where id=$1",
    [inspectGrant.roleAssignment],
  );
  const inspectSmoke = await inspect(launcher, stageId);
  assertEquals(inspectSmoke.code, 0, inspectSmoke.stderr);

  const lifecycleBefore = (await query<{ version: string }>(
    harness.server.sql,
    "select version::text version from staged_changeset_lifecycle where stage_id=$1",
    [stageId],
  )).rows[0].version;
  await mutateBeforeAuthority(
    harness,
    () => cancel(launcher, stageId),
    () =>
      query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [cancelGrant.roleAssignment],
      ),
  );
  assertEquals(
    (await query<{ version: string }>(
      harness.server.sql,
      "select version::text version from staged_changeset_lifecycle where stage_id=$1",
      [stageId],
    )).rows[0].version,
    lifecycleBefore,
  );
  await query(
    harness.server.sql,
    "update role_assignments set active=true,disabled_at=null where id=$1",
    [cancelGrant.roleAssignment],
  );
  await mutateAfterAccess(
    harness,
    stageId,
    () => cancel(launcher, stageId),
    () =>
      query(
        harness.server.sql,
        "update role_assignments set active=false,disabled_at=now() where id=$1",
        [cancelGrant.roleAssignment],
      ),
    "lifecycle",
  );
  await expectHidden(launcher, "cancel", stageId);
}
async function mutateAfterAccess(
  harness: LiveHarness,
  id: string,
  request: () => Promise<{ code: number; stderr: string }>,
  mutate: () => Promise<unknown>,
  barrier: "project" | "lifecycle",
) {
  let release!: () => void, ready!: () => void;
  const released = new Promise<void>((resolve) => release = resolve),
    started = new Promise<void>((resolve) => ready = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    if (barrier === "project") {
      await query(tx, "lock table projects in access exclusive mode");
    } else {
      await query(
        tx,
        "select stage_id from staged_changeset_lifecycle where stage_id=$1 for update",
        [id],
      );
    }
    ready();
    await released;
  });
  await started;
  const pending = request();
  let mutation: Promise<unknown> | undefined;
  try {
    await waitForLock(
      harness,
      barrier === "project" ? "%projects%" : "%staged_changeset_lifecycle%",
    );
    mutation = mutate();
    await waitForLock(harness, "%update role_assignments%");
    release();
    await blocker;
    const result = await pending;
    assertEquals(result.code, 0, result.stderr);
    await mutation;
  } catch (error) {
    release();
    await Promise.allSettled([
      blocker,
      pending,
      ...(mutation ? [mutation] : []),
    ]);
    throw error;
  }
}

async function mutateBeforeAuthority(
  harness: LiveHarness,
  request: () => Promise<{ code: number; stderr: string }>,
  mutate: () => Promise<unknown>,
) {
  let release!: () => void, ready!: () => void;
  const released = new Promise<void>((resolve) => release = resolve),
    started = new Promise<void>((resolve) => ready = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    await query(tx, "lock table auth_contexts in access exclusive mode");
    ready();
    await released;
  });
  await started;
  const pending = request();
  try {
    await waitForLock(harness, "%auth_contexts%");
    await mutate();
    release();
    await blocker;
    const result = await pending;
    assertEquals(result.code, 1, result.stderr);
  } catch (error) {
    release();
    await Promise.allSettled([blocker, pending]);
    throw error;
  }
}
async function mutateAfterAuthority(
  harness: LiveHarness,
  objectId: string,
  request: () => Promise<{ code: number; stderr: string }>,
  mutate: () => Promise<unknown>,
  mutationPattern = "%update policy_assignments%",
) {
  const table = (await query<{ table_name: string }>(
    harness.server.sql,
    "select table_name from pack_runtime_tables where publisher='test' and pack_name='stage' and definition_kind='resource' and definition_name='item'",
  )).rows[0].table_name;
  let release!: () => void, ready!: () => void;
  const released = new Promise<void>((resolve) => release = resolve),
    started = new Promise<void>((resolve) => ready = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    await query(
      tx,
      `lock table ${quoteIdentifier(table)} in access exclusive mode`,
    );
    ready();
    await released;
  });
  await started;
  void objectId;
  const pending = request();
  let mutation: Promise<unknown> | undefined;
  try {
    await waitForLock(harness, `%${table}%`);
    mutation = mutate();
    await waitForLock(harness, mutationPattern);
    release();
    await blocker;
    const result = await pending;
    assertEquals(result.code, 0, result.stderr);
    await mutation;
  } catch (error) {
    release();
    await Promise.allSettled([
      blocker,
      pending,
      ...(mutation ? [mutation] : []),
    ]);
    throw error;
  }
}
async function waitForLock(harness: LiveHarness, pattern: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const count = Number(
      (await query<{ count: number }>(
        harness.server.sql,
        "select count(*)::int count from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike $1",
        [pattern],
      )).rows[0].count,
    );
    if (count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`lock wait not observed: ${pattern}`);
}
