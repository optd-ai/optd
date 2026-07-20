import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { walk } from "jsr:@std/fs/walk";
import { join, relative } from "jsr:@std/path";
import {
  query,
  quoteIdentifier,
} from "../../../src/adapters/outbound/postgres/client.ts";
import { seedObjectHistoryFixture } from "../../support/object_history_fixtures.ts";
import { parseYamlJsonObject } from "../../../src/adapters/outbound/yaml/pack_loader.ts";
import {
  type CliLauncher,
  startLiveHarness,
} from "../../support/live_harness.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";

type Envelope = {
  ok: boolean;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
  error?: { code?: string; details?: unknown };
};

Deno.test("fresh compiled optctl queries typed Project resources and relationships", async () => {
  const harness = await startLiveHarness();
  try {
    const boot = await harness.bootstrap({
      username: "query-admin",
      password: "Query-Admin-Password-42!",
    });
    assertEquals(boot.code, 0, boot.stderr);
    const pack = join(harness.rootDir, "query-pack");
    await copyDirectory("prototypes/crm-default-pack", pack);
    const manifestPath = join(pack, "pack.yaml");
    const manifest = parseYamlJsonObject(
      await Deno.readTextFile(manifestPath),
      manifestPath,
    ) as Record<string, unknown>;
    (manifest.metadata as Record<string, unknown>).version = "9.0.0";
    await Deno.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2));
    const leadPath = join(pack, "resources", "lead.yaml");
    const lead = parseYamlJsonObject(
      await Deno.readTextFile(leadPath),
      leadPath,
    ) as {
      spec: {
        fields: Record<string, unknown>;
        axi: { list: { fields: string[] } };
      };
    };
    Object.assign(lead.spec.fields, {
      enabled: { type: "boolean" },
      due_date: { type: "date" },
      amount: { type: "decimal", precision: 12, scale: 2 },
    });
    lead.spec.axi.list.fields = ["id", "name", "score", "amount"];
    await Deno.writeTextFile(leadPath, JSON.stringify(lead, null, 2));
    await Deno.writeTextFile(
      join(pack, "relationships", "lead_viewer.yaml"),
      JSON.stringify(
        {
          kind: "Relationship",
          apiVersion: "operant.dev/v1",
          metadata: { name: "lead_viewer" },
          spec: {
            from: { resource: "lead" },
            to: { resource: "system:principal" },
            fields: {},
            unique: ["from", "to"],
            axi: {},
          },
        },
        null,
        2,
      ),
    );
    const applied = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      pack,
      "--safe",
    ]);
    assertEquals(applied.code, 0, applied.stderr);
    const expressionHelp = await harness.runOptctl([
      "--json",
      "expression",
      "help",
      "partial-index",
    ]);
    assertEquals(expressionHelp.code, 0, expressionHelp.stderr);
    assertStringIncludes(expressionHelp.stdout, "partial-index");
    const expressionValid = await harness.runOptctl([
      "--json",
      "expression",
      "validate",
      "operant/crm:lead",
      "--context",
      "partial-index",
      'status == "new" && active()',
    ]);
    assertEquals(expressionValid.code, 0, expressionValid.stderr);
    const expressionInvalid = await harness.runOptctl([
      "--json",
      "expression",
      "validate",
      "operant/crm:lead",
      "--context",
      "query",
      "status ==",
    ]);
    assert(expressionInvalid.code !== 0);
    assertStringIncludes(expressionInvalid.stderr, "expression_syntax");
    assertStringIncludes(expressionInvalid.stderr, "line");
    for (
      const command of [
        ["expression", "help", "unknown-context"],
        [
          "expression",
          "validate",
          "operant/crm:missing",
          "--context",
          "query",
          "true",
        ],
        [
          "expression",
          "validate",
          "operant/crm:lead",
          "--context",
          "query",
          'score == "wrong"',
        ],
      ]
    ) {
      const rejected = await harness.runOptctl(["--json", ...command]);
      assert(rejected.code !== 0, rejected.stdout);
    }

    const created = await harness.runOptctl([
      "--json",
      "project",
      "create",
      "query-sales",
      "--display-name",
      "Query Sales",
    ]);
    assertEquals(created.code, 0, created.stderr);
    const project = JSON.parse(created.stdout).data.id as string;
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
      projectIds: [project, project],
      authContextId: auth,
      resourceData: {
        name: "Typed Lead",
        status: "new",
        score: 42,
        enabled: true,
        due_date: "2026-08-01",
        amount: "10.50",
        next_activity_at: "2026-08-01T12:00:00Z",
      },
      relationshipFields: { role: "buyer", primary: true },
    });
    const table = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='resource' and definition_name='lead'",
    )).rows[0].table_name;
    await query(
      harness.server.sql,
      `update ${
        quoteIdentifier(table)
      } set score=42,enabled=true,due_date='2026-08-01',amount=10.50,next_activity_at='2026-08-01T12:00:00Z' where id=$1`,
      [ids.object],
    );

    for (
      const where of [
        'name == "Typed Lead"',
        "score >= 42",
        "enabled == true",
        'due_date == "2026-08-01"',
        'next_activity_at >= "2026-08-01T12:00:00Z"',
        "amount >= 10",
      ]
    ) {
      const result = await runJson(harness, [
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--where",
        where,
        "--fields",
        "name,score,amount",
        "--sort",
        "score:asc",
        "--include-total",
      ]);
      const items = result.data.items as Array<{
        data: Record<string, unknown>;
      }>;
      assert(items.length > 0, where);
      assertEquals(result.meta.total, items.length, where);
      assertEquals(items[0].data.amount, "10.5");
    }
    const relationship = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "relationship",
      "operant/crm:contact_company",
      "--fields",
      "role,primary",
      "--sort",
      "created_at:asc",
      "--include-archived",
    ]);
    const relationItem = (relationship.data.items as Array<
      {
        kind: string;
        fields: Record<string, unknown>;
        from: string;
        to: string;
      }
    >)[0];
    assertEquals(relationItem.kind, "relationship");
    assertEquals(relationItem.fields, { role: "buyer", primary: true });
    assert(relationItem.from && relationItem.to);

    const firstPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
    ]);
    assertEquals(firstPage.data.items instanceof Array, true);
    assertEquals((firstPage.data.items as unknown[]).length, 1);
    assertEquals(firstPage.meta.has_more, true);
    assertEquals(firstPage.meta.total, 3);
    const cursor = String(firstPage.meta.next_cursor);
    const firstId = (firstPage.data.items as Array<{ id: string }>)[0].id;
    const secondPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      cursor,
    ]);
    assertEquals(secondPage.meta.total, 3);
    assert((secondPage.data.items as Array<{ id: string }>)[0].id !== firstId);
    for (
      const [changedArgs, expected] of [
        [["--where", 'name == "Other"'], "invalid_cursor"],
        [["--fields", "name"], "invalid_cursor"],
        [["--limit", "2"], "invalid_cursor"],
      ] as const
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--sort",
        "score:asc",
        "--sort",
        "updated_at:desc",
        "--limit",
        "1",
        "--include-total",
        "--cursor",
        cursor,
        ...changedArgs,
      ]);
      assert(failed.code !== 0);
      assertStringIncludes(failed.stderr, expected);
    }
    const forged = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const forgedResult = await harness.runOptctl([
      "--json",
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      forged,
    ]);
    assert(forgedResult.code !== 0);
    assertStringIncludes(forgedResult.stderr, "invalid_cursor");

    const toon = await harness.runOptctl([
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
    ]);
    assertEquals(toon.code, 0, toon.stderr);
    assertStringIncludes(toon.stdout, "Typed Lead");

    for (
      const invalid of [
        "amount > 1.2",
        "amount > 1e3",
        "score > 9007199254740992",
        "unknown == true",
        "actor.id == id",
        'matches(name, "x")',
        "name in []",
      ]
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--where",
        invalid,
      ]);
      assert(failed.code !== 0, `${invalid}: ${failed.stderr}`);
      const body = JSON.parse(failed.stderr) as Envelope;
      assertEquals(body.ok, false);
      assert(!failed.stderr.includes(table));
      assert(!failed.stderr.toLowerCase().includes("select "));
    }
    for (
      const args of [
        ["--fields", "name,name"],
        ["--fields", "id"],
        ["--fields", "missing"],
        ["--sort", "score:asc", "--sort", "score:desc"],
        ["--sort", "id:asc"],
        ["--sort", "missing:asc"],
      ]
    ) {
      const failed = await harness.runOptctl([
        "--json",
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        ...args,
      ]);
      assert(failed.code !== 0, failed.stderr);
    }
    const ordinaryPassword = "Ordinary-Query-Password-42!";
    const createdOrdinary = await harness.runOptctl([
      "--json",
      "auth",
      "user",
      "create",
      "--username",
      "ordinary-query",
      "--password-stdin",
    ], `${ordinaryPassword}\n`);
    assertEquals(createdOrdinary.code, 0, createdOrdinary.stderr);
    const requestLogin = await fetch(`${harness.baseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "ordinary-query",
        password: ordinaryPassword,
      }),
    });
    assertEquals(requestLogin.status, 200);
    const requestCredentials = (await requestLogin.json()).data.credentials;
    const requestToken = String(requestCredentials.authorization_request_token);
    const requestDenied = await fetch(`${harness.baseUrl}/api/v1/queries`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${requestToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        project_id: project,
        definition: {
          kind: "resource",
          publisher: "operant",
          pack: "crm",
          name: "lead",
        },
      }),
    });
    assertEquals(requestDenied.status, 403);
    assertStringIncludes(
      await requestDenied.text(),
      "authorization_insufficient",
    );
    const requestExpressionDenied = await fetch(
      `${harness.baseUrl}/api/v1/expressions/help`,
      { headers: { authorization: `Bearer ${requestToken}` } },
    );
    assertEquals(requestExpressionDenied.status, 403);
    assertStringIncludes(
      await requestExpressionDenied.text(),
      "authorization_insufficient",
    );

    const ordinaryProcess = await harness.loginProcess({
      username: "ordinary-query",
      password: ordinaryPassword,
    });
    assertEquals(ordinaryProcess.result.code, 0, ordinaryProcess.result.stderr);
    const ordinaryIdentity = (await query<{
      principal_id: string;
      human_user_id: string;
    }>(
      harness.server.sql,
      `select p.id principal_id,h.id human_user_id
      from principals p join human_users h on h.principal_id=p.id
      where h.username='ordinary-query'`,
    )).rows[0];
    const ordinaryRoleAssignment = uuidV7();
    await query(
      harness.server.sql,
      `insert into role_assignments(
      id,principal_id,role_id,boundary_type,project_id,active)
      values($1,$2,'operant/crm:sales_rep','project',$3,true)`,
      [
        ordinaryRoleAssignment,
        ordinaryIdentity.principal_id,
        project,
      ],
    );
    await query(
      harness.server.sql,
      `update policy_assignments pa set active=false,
      disabled_at=now() from policy_definition_versions pd
      where pa.policy_definition_version_id=pd.id and pd.policy_id like 'operant/crm:%'`,
    );
    const policyModes = [
      { name: "unconditional", predicate: null, relation: null },
      { name: "abac", predicate: "score >= 40", relation: null },
      {
        name: "combined",
        predicate: "score >= 40",
        relation: "actor.id",
      },
      { name: "actor", predicate: null, relation: "actor.id" },
      { name: "human", predicate: null, relation: "actor.human_user_id" },
    ] as const;
    const modeAssignments = new Map<string, string>();
    const modeRules = new Map<string, string>();
    for (const mode of policyModes) {
      const version = uuidV7(), assignment = uuidV7(), ruleId = uuidV7();
      await query(
        harness.server.sql,
        `insert into policy_definition_versions(
        id,policy_id,version,active) values($1,$2,1,true)`,
        [
          version,
          `test:query_${mode.name}`,
        ],
      );
      await query(
        harness.server.sql,
        `insert into policy_rules(
        id,policy_definition_version_id,role_id,capability,resource,
        condition_kind,predicate,rule_name,relation_relationship,
        relation_object_side,relation_subject_side,relation_subject)
        values($1,$2,'operant/crm:sales_rep','read','operant/crm:lead',$3,$4,$5,
          $6,'from','to',$7)`,
        [
          ruleId,
          version,
          mode.relation ? "rebac" : mode.predicate ? "abac" : "unconditional",
          mode.predicate,
          mode.name,
          mode.relation ? "operant/crm:lead_viewer" : null,
          mode.relation,
        ],
      );
      await query(
        harness.server.sql,
        `insert into policy_assignments(
        id,policy_definition_version_id,boundary_type,project_id,active,source)
        values($1,$2,'project',$3,false,'operator')`,
        [assignment, version, project],
      );
      modeAssignments.set(mode.name, assignment);
      modeRules.set(mode.name, ruleId);
    }
    const relationProject = uuidV7();
    await query(
      harness.server.sql,
      `insert into projects(
      id,slug,display_name,created_by_auth_context_id,updated_by_auth_context_id)
      values($1,'relation-other','Relation Other',$2,$2)`,
      [relationProject, auth],
    );
    const viewerTable = (await query<{ table_name: string }>(
      harness.server.sql,
      "select table_name from pack_runtime_tables where publisher='operant' and pack_name='crm' and definition_kind='relationship' and definition_name='lead_viewer'",
    )).rows[0].table_name;
    const actorEdge = uuidV7(), humanEdge = uuidV7();
    for (
      const [edge, subject] of [
        [actorEdge, ordinaryIdentity.principal_id],
        [humanEdge, ordinaryIdentity.human_user_id],
      ]
    ) {
      await query(
        harness.server.sql,
        `insert into ${quoteIdentifier(viewerTable)}
        (id,project_id,from_object_id,to_object_id,created_by,updated_by)
        values($1,$2,$3,$4,$5,$5)`,
        [edge, project, ids.object, subject, auth],
      );
    }
    await query(
      harness.server.sql,
      `update ${quoteIdentifier(table)}
      set score=case when id=$1 then 42 else 5 end`,
      [ids.object],
    );

    const ordinaryArgs = [
      "--project",
      project,
      "query",
      "operant/crm:lead",
      "--fields",
      "name,score",
      "--include-total",
    ];
    await expectCliDenied(ordinaryProcess.launcher, ordinaryArgs);
    for (const mode of policyModes) {
      const assignment = modeAssignments.get(mode.name)!;
      await query(
        harness.server.sql,
        "update policy_assignments set active=true where id=$1",
        [assignment],
      );
      const allowed = await runJson(
        harness,
        ordinaryArgs,
        ordinaryProcess.launcher,
      );
      const expected = mode.name === "unconditional" ? 3 : 1;
      assertEquals(
        (allowed.data.items as unknown[]).length,
        expected,
        mode.name,
      );
      assertEquals(allowed.meta.total, expected, mode.name);
      if (mode.name === "actor") {
        await query(
          harness.server.sql,
          `update ${quoteIdentifier(viewerTable)}
          set archived_at=now() where id=$1`,
          [actorEdge],
        );
        await expectCliEmpty(harness, ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          `update ${quoteIdentifier(viewerTable)}
          set archived_at=null,project_id=$2 where id=$1`,
          [actorEdge, relationProject],
        );
        await expectCliEmpty(harness, ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          `update ${quoteIdentifier(viewerTable)}
          set project_id=$2,from_object_id=$3,to_object_id=$4 where id=$1`,
          [
            actorEdge,
            project,
            ordinaryIdentity.principal_id,
            ids.object,
          ],
        );
        await expectCliEmpty(harness, ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          `update ${quoteIdentifier(viewerTable)}
          set from_object_id=$2,to_object_id=$3 where id=$1`,
          [
            actorEdge,
            ids.object,
            ordinaryIdentity.principal_id,
          ],
        );
        const actorRule = modeRules.get("actor")!;
        await query(
          harness.server.sql,
          `update policy_rules
          set relation_relationship='operant/crm:lead_viewer->deep' where id=$1`,
          [actorRule],
        );
        await expectCliDenied(ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          `update policy_rules
          set relation_relationship='operant/crm:lead_viewer',
            relation_object_side='to',relation_subject_side='from' where id=$1`,
          [actorRule],
        );
        await expectCliDenied(ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          `update policy_rules
          set relation_object_side='from',relation_subject_side='to',
            predicate='id in actor.ids' where id=$1`,
          [actorRule],
        );
        await expectCliDenied(ordinaryProcess.launcher, ordinaryArgs);
        await query(
          harness.server.sql,
          "update policy_rules set predicate=null where id=$1",
          [actorRule],
        );
      }
      await query(
        harness.server.sql,
        "update policy_assignments set active=false where id=$1",
        [assignment],
      );
    }
    const unconditionalAssignment = modeAssignments.get("unconditional")!;
    await query(
      harness.server.sql,
      `update policy_assignments set active=true,
      boundary_type='system',project_id=null where id=$1`,
      [unconditionalAssignment],
    );
    await expectCliDenied(ordinaryProcess.launcher, ordinaryArgs);
    await query(
      harness.server.sql,
      `update policy_assignments set
      boundary_type='all_projects' where id=$1`,
      [unconditionalAssignment],
    );
    const allProjectsAllowed = await runJson(
      harness,
      ordinaryArgs,
      ordinaryProcess.launcher,
    );
    assertEquals(allProjectsAllowed.meta.total, 3);
    const ordinaryFirst = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    const ordinaryCursor = String(ordinaryFirst.meta.next_cursor);
    await query(
      harness.server.sql,
      "update policy_assignments set active=false where id=$1",
      [unconditionalAssignment],
    );
    const revokedCursor = await ordinaryProcess.launcher.runOptctl([
      "--json",
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
      "--cursor",
      ordinaryCursor,
    ]);
    assert(revokedCursor.code !== 0);
    assertStringIncludes(revokedCursor.stderr, "invalid_cursor");
    await query(
      harness.server.sql,
      `update policy_assignments set active=true,
      boundary_type='project',project_id=$2 where id=$1`,
      [
        unconditionalAssignment,
        project,
      ],
    );

    await query(
      harness.server.sql,
      `update ${quoteIdentifier(table)}
      set archived_at=now() where id=$1`,
      [ids.object],
    );
    const activeOnly = await runJson(
      harness,
      ordinaryArgs,
      ordinaryProcess.launcher,
    );
    assertEquals(activeOnly.meta.total, 2);
    const archivedDenied = await ordinaryProcess.launcher.runOptctl([
      "--json",
      ...ordinaryArgs,
      "--include-archived",
    ]);
    assert(archivedDenied.code !== 0);
    const archivedVersion = uuidV7(), archivedAssignment = uuidV7();
    await query(
      harness.server.sql,
      `insert into policy_definition_versions(
      id,policy_id,version,active) values($1,'test:query_archived',1,true)`,
      [archivedVersion],
    );
    await query(
      harness.server.sql,
      `insert into policy_rules(
      id,policy_definition_version_id,role_id,capability,resource,condition_kind,rule_name)
      values($1,$2,'operant/crm:sales_rep','read_archived','operant/crm:lead','unconditional','archived')`,
      [uuidV7(), archivedVersion],
    );
    await query(
      harness.server.sql,
      `insert into policy_assignments(
      id,policy_definition_version_id,boundary_type,project_id,active,source)
      values($1,$2,'project',$3,true,'operator')`,
      [archivedAssignment, archivedVersion, project],
    );
    const archivedAllowed = await runJson(harness, [
      ...ordinaryArgs,
      "--include-archived",
    ], ordinaryProcess.launcher);
    assertEquals(archivedAllowed.meta.total, 3);
    await query(
      harness.server.sql,
      `update ${quoteIdentifier(table)}
      set archived_at=null where id=$1`,
      [ids.object],
    );
    await ordinaryProcess.launcher.close();

    await harness.restart();
    const restartPage = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      "score:asc",
      "--sort",
      "updated_at:desc",
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      cursor,
    ]);
    assert((restartPage.data.items as Array<{ id: string }>)[0].id !== firstId);
    const afterRestart = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      "score >= 42",
    ]);
    assert((afterRestart.data.items as unknown[]).length > 0);
  } finally {
    await harness.close();
  }
});

async function copyDirectory(
  source: string,
  destination: string,
): Promise<void> {
  for await (const entry of walk(source, { includeDirs: true })) {
    const target = join(destination, relative(source, entry.path));
    if (entry.isDirectory) await Deno.mkdir(target, { recursive: true });
    else if (entry.isFile) await Deno.copyFile(entry.path, target);
  }
}

async function runJson(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  args: string[],
  launcher?: CliLauncher,
): Promise<Envelope> {
  const result = launcher
    ? await launcher.runOptctl(["--json", ...args])
    : await harness.runOptctl(["--json", ...args]);
  assertEquals(result.code, 0, result.stderr);
  const body = JSON.parse(result.stdout) as Envelope;
  assertEquals(body.ok, true);
  return body;
}

async function expectCliEmpty(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  launcher: CliLauncher,
  args: string[],
): Promise<void> {
  const result = await runJson(harness, args, launcher);
  assertEquals(result.data.items, []);
  assertEquals(result.meta.total, 0);
}

async function expectCliDenied(
  launcher: CliLauncher,
  args: string[],
): Promise<void> {
  const result = await launcher.runOptctl(["--json", ...args]);
  assert(result.code !== 0, result.stdout);
  assertStringIncludes(result.stderr, "not_found");
  assert(!result.stderr.toLowerCase().includes("select "));
  assert(!result.stderr.includes("policy_rules"));
}
