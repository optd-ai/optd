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
  type LiveHarness,
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
    const adminState = await storedAuthState(harness);
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
        axi: { list: { defaultFields: string[] } };
      };
    };
    Object.assign(lead.spec.fields, {
      enabled: { type: "boolean" },
      due_date: { type: "date" },
      amount: { type: "decimal", precision: 12, scale: 2 },
    });
    lead.spec.axi.list.defaultFields = ["id", "name", "score", "amount"];
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
    const packMetadata = await harness.runOptctl([
      "--json",
      "metadata",
      "pack",
      "operant/crm",
    ]);
    assertEquals(packMetadata.code, 0, packMetadata.stderr);
    assertEquals(JSON.parse(packMetadata.stdout).data.axi_readiness, {
      ready: false,
      missing_guidance: ["relationship:operant/crm:lead_viewer"],
    });
    const relationshipMetadata = await harness.runOptctl([
      "--json",
      "metadata",
      "relationship",
      "operant/crm:lead_viewer",
    ]);
    assertEquals(relationshipMetadata.code, 0, relationshipMetadata.stderr);
    assertEquals(JSON.parse(relationshipMetadata.stdout).data.axi_readiness, {
      ready: false,
      missing_guidance: [
        "axi.purpose",
        "axi.whenToUse",
        "axi.help",
      ],
    });
    const expressionContexts = [
      "query",
      "policy",
      "partial-index",
      "constraint",
      "lifecycle",
      "action",
      "hook",
      "axi",
    ];
    for (const context of expressionContexts) {
      const expressionHelp = await harness.runOptctl([
        "--json",
        "expression",
        "help",
        context,
      ]);
      assertEquals(expressionHelp.code, 0, expressionHelp.stderr);
      assertStringIncludes(expressionHelp.stdout, context);
      const expressionValid = await harness.runOptctl([
        "--json",
        "expression",
        "validate",
        "operant/crm:lead",
        "--context",
        context,
        context === "policy"
          ? 'actor.id != "" && score >= 1'
          : 'status == "new" && active()',
      ]);
      assertEquals(expressionValid.code, 0, expressionValid.stderr);
    }
    const cliSource = await Deno.readTextFile(
      "src/adapters/inbound/cli-cliffy/optctl.ts",
    );
    assert(!/expressions\/(cel|parser)|expression_lowerer/.test(cliSource));
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
      const [command, code, detail] of [
        [
          ["expression", "help", "unknown-context"],
          "bad_request",
          "unknown expression context",
        ],
        [
          [
            "expression",
            "validate",
            "operant/crm:missing",
            "--context",
            "query",
            "true",
          ],
          "not_found",
          "definition was not found",
        ],
        [
          [
            "expression",
            "validate",
            "operant/crm:lead",
            "--context",
            "query",
            'score == "wrong"',
          ],
          "bad_request",
          "expression_type",
        ],
      ] as const
    ) {
      const rejected = await harness.runOptctl(["--json", ...command]);
      assert(rejected.code !== 0, rejected.stdout);
      const body = JSON.parse(rejected.stderr) as Envelope;
      assertEquals(body.error?.code, code);
      assertStringIncludes(rejected.stderr, detail);
      if (detail === "expression_type") {
        const details = body.error?.details as {
          issues: Array<{ path: string; code: string }>;
        };
        assertEquals(details.issues[0].path, "/expression");
        assertEquals(details.issues[0].code, "expression_type");
      }
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

    let canonicalAlias: string | null = null;
    let canonicalCursor = "";
    let canonicalSort = "";
    for (
      const sort of ["name:asc", "amount:asc", "due_date:asc", "enabled:asc"]
    ) {
      const candidatePage = await runJson(harness, [
        "--project",
        "query-sales",
        "query",
        "operant/crm:lead",
        "--where",
        'name == "Typed Lead"',
        "--sort",
        sort,
        "--limit",
        "1",
        "--include-total",
      ]);
      canonicalCursor = String(candidatePage.meta.next_cursor);
      canonicalAlias = trailingBitAlias(canonicalCursor);
      canonicalSort = sort;
      if (canonicalAlias !== null) break;
    }
    assert(canonicalAlias !== null, "expected an aliasable query cursor");
    assertEquals(
      decodeBase64Url(canonicalAlias),
      decodeBase64Url(canonicalCursor),
    );
    const aliasResult = await harness.runOptctl([
      "--json",
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--sort",
      canonicalSort,
      "--limit",
      "1",
      "--include-total",
      "--cursor",
      canonicalAlias,
    ]);
    assert(aliasResult.code !== 0);
    assertStringIncludes(aliasResult.stderr, "invalid_cursor");

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
    const injectionLiteral = "needle' OR 1=1 -- /* ; DROP TABLE projects; */";
    const literalResult = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      `name == ${JSON.stringify(injectionLiteral)}`,
      "--include-total",
    ]);
    assertEquals(literalResult.data.items, []);
    assertEquals(literalResult.meta.total, 0);
    const afterLiteral = await runJson(harness, [
      "--project",
      "query-sales",
      "query",
      "operant/crm:lead",
      "--where",
      'name == "Typed Lead"',
      "--include-total",
    ]);
    assertEquals(afterLiteral.meta.total, 3);

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
    const requestExpressionValidateDenied = await fetch(
      `${harness.baseUrl}/api/v1/expressions/validate`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${requestToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          definition: {
            kind: "resource",
            publisher: "operant",
            pack: "crm",
            name: "lead",
          },
          context: "query",
          expression: "true",
        }),
      },
    );
    assertEquals(requestExpressionValidateDenied.status, 403);
    assertStringIncludes(
      await requestExpressionValidateDenied.text(),
      "authorization_insufficient",
    );

    const ordinaryProcess = await harness.loginProcess({
      username: "ordinary-query",
      password: ordinaryPassword,
    });
    assertEquals(ordinaryProcess.result.code, 0, ordinaryProcess.result.stderr);
    const ordinaryState = await storedAuthState(harness);
    const ordinaryIdentity = (await query<{
      principal_id: string;
      human_user_id: string;
    }>(
      harness.server.sql,
      `select p.id principal_id,h.id human_user_id
      from principals p join human_users h on h.principal_id=p.id
      where h.username='ordinary-query'`,
    )).rows[0];
    const matrixRows = Array.from({ length: 8 }, (_, index) => ({
      id: uuidV7(),
      name: `Matrix ${index}`,
      score: index % 2 === 0 ? 50 : 5,
      nextActivity: index < 3
        ? null
        : index < 6
        ? "2026-09-01T12:00:00Z"
        : "2026-09-02T12:00:00Z",
    }));
    for (const row of matrixRows) {
      await query(
        harness.server.sql,
        `insert into ${quoteIdentifier(table)}
        (id,project_id,name,status,score,enabled,due_date,amount,next_activity_at,created_by,updated_by)
        values($1,$2,$3,'new',$4,true,'2026-08-01',10.50,$5,$6,$6)`,
        [row.id, project, row.name, row.score, row.nextActivity, auth],
      );
    }
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
    const actorEdge = uuidV7(),
      humanEdge = uuidV7(),
      actorAlternateEdge = uuidV7();
    const policyEdges = [
      [actorEdge, ids.object, ordinaryIdentity.principal_id],
      [humanEdge, ids.object, ordinaryIdentity.human_user_id],
      [actorAlternateEdge, ids.projectTwoObject, ordinaryIdentity.principal_id],
      [uuidV7(), matrixRows[1].id, ordinaryIdentity.human_user_id],
    ];
    for (const [edge, object, subject] of policyEdges) {
      await query(
        harness.server.sql,
        `insert into ${quoteIdentifier(viewerTable)}
        (id,project_id,from_object_id,to_object_id,created_by,updated_by)
        values($1,$2,$3,$4,$5,$5)`,
        [edge, project, object, subject, auth],
      );
    }
    await query(
      harness.server.sql,
      `update ${
        quoteIdentifier(table)
      } set score=case when id=$1 then 42 else 5 end
      where id=any($2::uuid[])`,
      [ids.object, [ids.object, ids.otherObject, ids.projectTwoObject]],
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
      const expectedIds = mode.name === "unconditional"
        ? [
          ids.object,
          ids.otherObject,
          ids.projectTwoObject,
          ...matrixRows.map((row) => row.id),
        ]
        : mode.name === "abac"
        ? [
          ids.object,
          ...matrixRows.filter((row) => row.score >= 40).map((row) => row.id),
        ]
        : mode.name === "actor"
        ? [ids.object, ids.projectTwoObject]
        : mode.name === "human"
        ? [ids.object, matrixRows[1].id]
        : [ids.object];
      const collected = await collectCliPages(
        harness,
        ordinaryProcess.launcher,
        ordinaryArgs,
        ["score:asc", "created_at:desc"],
        2,
      );
      assertEquals(
        [...collected].sort(),
        [...expectedIds].sort(),
        mode.name,
      );
      if (mode.name === "actor") {
        await query(
          harness.server.sql,
          `update ${quoteIdentifier(viewerTable)}
          set archived_at=now() where id=any($1::uuid[])`,
          [[actorEdge, actorAlternateEdge]],
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
    await seedQueryAgentDecidePolicy(harness, project);
    await query(
      harness.server.sql,
      `insert into role_assignments(
      id,principal_id,role_id,boundary_type,project_id,active)
      values($1,$2,'operant/crm:sales_manager','project',$3,true)`,
      [uuidV7(), ordinaryIdentity.principal_id, project],
    );
    const requestOnlyAgent = await harness.createProcessTreeLauncher(
      "request_only",
    );
    const rootAgent = await harness.createProcessTreeLauncher("agent");
    const delegatedAgent = await harness.createProcessTreeLauncher("agent");
    await selectStoredCredential(harness, {
      token: undefined,
      requestToken: ordinaryState.requestToken,
    });
    const rootRequest = await requestOnlyAgent.runOptctl([
      "--json",
      "auth",
      "request",
      "--role",
      "operant/crm:sales_rep",
      "--role",
      "operant/crm:sales_manager",
      "--project",
      project,
      "--reason",
      "bounded query root",
    ]);
    assertEquals(rootRequest.code, 0, rootRequest.stderr);
    const rootRequestId = String(JSON.parse(rootRequest.stdout).data.id);
    await selectStoredCredential(harness, {
      token: ordinaryState.token,
      requestToken: undefined,
    });
    const rootApproval = await ordinaryProcess.launcher.runOptctl([
      "--json",
      "auth",
      "approve",
      rootRequestId,
      "--yes",
      "--agent-name",
      "query-root-agent",
    ]);
    assertEquals(rootApproval.code, 0, rootApproval.stderr);
    await selectStoredCredential(harness, {
      token: undefined,
      requestToken: ordinaryState.requestToken,
    });
    const rootWait = await rootAgent.runOptctl([
      "--json",
      "auth",
      "wait",
      rootRequestId,
    ]);
    assertEquals(rootWait.code, 0, rootWait.stderr);
    const rootState = await storedAuthState(harness);
    const rootAuthorizationId = await authorizationForRequest(
      harness,
      rootRequestId,
    );
    const rootIdentity = (await query<{
      principal_id: string;
      human_user_id: string | null;
      parent_authorization_id: string | null;
      root_authorization_id: string;
    }>(
      harness.server.sql,
      `select au.principal_id,aa.human_user_id,aa.parent_authorization_id,
      aa.root_authorization_id from agent_authorizations aa
      join agent_users au on au.id=aa.agent_user_id where aa.id=$1`,
      [rootAuthorizationId],
    )).rows[0];
    assertEquals(
      rootIdentity.human_user_id,
      ordinaryIdentity.human_user_id,
    );
    assertEquals(rootIdentity.parent_authorization_id, null);
    assertEquals(rootIdentity.root_authorization_id, rootAuthorizationId);
    await query(
      harness.server.sql,
      `insert into ${quoteIdentifier(viewerTable)}
      (id,project_id,from_object_id,to_object_id,created_by,updated_by)
      values($1,$2,$3,$4,$5,$5)`,
      [uuidV7(), project, ids.object, rootIdentity.principal_id, auth],
    );

    await query(
      harness.server.sql,
      "update policy_assignments set active=true where id=any($1::uuid[])",
      [[modeAssignments.get("actor")!, modeAssignments.get("human")!]],
    );
    await selectStoredCredential(harness, {
      token: rootState.token,
      requestToken: undefined,
    });
    const agentVisible = await runJson(
      harness,
      ordinaryArgs,
      rootAgent,
    );
    assertEquals(
      (agentVisible.data.items as Array<{ id: string }>).map((item) => item.id)
        .sort(),
      [ids.object, matrixRows[1].id].sort(),
    );
    assertEquals(agentVisible.meta.total, 2);
    await query(
      harness.server.sql,
      "update policy_assignments set active=false where id=any($1::uuid[])",
      [[modeAssignments.get("actor")!, modeAssignments.get("human")!]],
    );

    const delegated = await createDelegatedQueryAgent({
      harness,
      requester: requestOnlyAgent,
      approver: rootAgent,
      redeemer: delegatedAgent,
      requestToken: ordinaryState.requestToken,
      approverToken: rootState.token,
      project,
      name: "query-delegated-agent",
    });
    assertEquals(delegated.parent, rootAuthorizationId);
    assertEquals(delegated.root, rootAuthorizationId);
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
    assertEquals(allProjectsAllowed.meta.total, 11);

    const agentRequest = {
      project_id: project,
      definition: {
        kind: "resource",
        publisher: "operant",
        pack: "crm",
        name: "lead",
      },
      fields: ["name", "score"],
      sort: [{ field: "created_at", direction: "asc" }],
      limit: 1,
      include_total: true,
    };
    const delegatedBaseline = await fetchAgentQuery(
      harness,
      delegated.token,
      agentRequest,
    );
    assertEquals(delegatedBaseline.status, 200);
    const delegatedPage = await delegatedBaseline.json();
    assertEquals(delegatedPage.meta.total, 11);
    const delegatedCursor = String(delegatedPage.meta.next_cursor);
    const alternateRoot = uuidV7();
    await harness.server.sql.begin(async (sql) => {
      await query(
        sql,
        `insert into agent_authorizations(
        id,agent_user_id,human_user_id,parent_authorization_id,
        root_authorization_id,approved_by_auth_context_id)
        select $1,agent_user_id,human_user_id,null,$1,approved_by_auth_context_id
        from agent_authorizations where id=$2`,
        [alternateRoot, rootAuthorizationId],
      );
      await query(
        sql,
        `update agent_authorizations set parent_authorization_id=$1,
        root_authorization_id=$1 where id=$2`,
        [alternateRoot, delegated.authorization],
      );
    });
    const changedRootCursor = await fetchAgentQuery(
      harness,
      delegated.token,
      { ...agentRequest, cursor: delegatedCursor },
    );
    assertEquals(changedRootCursor.status, 400);
    assertEquals((await changedRootCursor.json()).error.code, "invalid_cursor");
    await harness.server.sql.begin(async (sql) => {
      await query(
        sql,
        `update agent_authorizations set parent_authorization_id=$1,
        root_authorization_id=$1 where id=$2`,
        [rootAuthorizationId, delegated.authorization],
      );
      await query(sql, "delete from agent_authorizations where id=$1", [
        alternateRoot,
      ]);
    });
    await query(
      harness.server.sql,
      "update agent_authorizations set superseded_at=now() where id=$1",
      [rootAuthorizationId],
    );
    const replacedCursor = await fetchAgentQuery(
      harness,
      delegated.token,
      { ...agentRequest, cursor: delegatedCursor },
    );
    assertEquals(replacedCursor.status, 401);
    assertEquals(
      (await replacedCursor.json()).error.code,
      "credential_invalid",
    );
    await query(
      harness.server.sql,
      "update agent_authorizations set superseded_at=null where id=$1",
      [rootAuthorizationId],
    );

    for (const mutation of ["revoked_at", "superseded_at"] as const) {
      await proveAgentMutationBeforeQueryAuthority(
        harness,
        delegated.token,
        rootAuthorizationId,
        agentRequest,
        mutation,
      );
      await proveAgentMutationAfterQueryLocks(
        harness,
        delegated.token,
        rootAuthorizationId,
        table,
        agentRequest,
        mutation,
      );
    }
    await query(
      harness.server.sql,
      `update ${
        quoteIdentifier(table)
      } set created_at='2026-01-01T00:00:00.000Z'
      where project_id=$1`,
      [project],
    );
    for (const direction of ["asc", "desc"] as const) {
      const nullableOrder = await collectCliPages(
        harness,
        ordinaryProcess.launcher,
        ordinaryArgs,
        [
          `next_activity_at:${direction}`,
          `score:${direction === "asc" ? "desc" : "asc"}`,
        ],
        2,
      );
      const expectedOrder = (await query<{ id: string }>(
        harness.server.sql,
        `select id from ${
          quoteIdentifier(table)
        } where project_id=$1 and archived_at is null
        order by next_activity_at ${direction} nulls ${
          direction === "asc" ? "last" : "first"
        },
        score ${direction === "asc" ? "desc" : "asc"} nulls ${
          direction === "asc" ? "first" : "last"
        },
        id ${direction === "asc" ? "desc" : "asc"}`,
        [project],
      )).rows.map((row) => row.id);
      assertEquals(nullableOrder, expectedOrder);
      const nullIds = new Set(
        matrixRows.filter((row) => row.nextActivity === null).map((row) =>
          row.id
        ),
      );
      const nullPositions = nullableOrder
        .map((id, index) => nullIds.has(id) ? index : -1)
        .filter((index) => index >= 0);
      assert(nullPositions.length > 1);
      assert(
        direction === "asc"
          ? nullPositions.every((position) =>
            position >= nullableOrder.length - nullIds.size
          )
          : nullPositions.every((position) => position < nullIds.size),
      );
    }
    const sparseFirst = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "2",
    ], ordinaryProcess.launcher);
    const sparseCursor = String(sparseFirst.meta.next_cursor);
    const preservedIds = (sparseFirst.data.items as Array<{ id: string }>).map((
      item,
    ) => item.id);
    await query(
      harness.server.sql,
      `update ${quoteIdentifier(table)} set archived_at=now()
      where project_id=$1 and not(id=any($2::uuid[]))`,
      [project, preservedIds],
    );
    const sparseContinuation = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "2",
      "--cursor",
      sparseCursor,
    ], ordinaryProcess.launcher);
    assertEquals(sparseContinuation.data.items, []);
    assertEquals(sparseContinuation.meta.has_more, false);
    assertEquals(sparseContinuation.meta.total, 2);
    await query(
      harness.server.sql,
      `update ${
        quoteIdentifier(table)
      } set archived_at=null where project_id=$1`,
      [project],
    );

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
    assertEquals(activeOnly.meta.total, 10);
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
    assertEquals(archivedAllowed.meta.total, 11);
    await query(
      harness.server.sql,
      `update ${quoteIdentifier(table)}
      set archived_at=null where id=$1`,
      [ids.object],
    );
    await selectStoredCredential(harness, {
      token: ordinaryState.token,
      requestToken: undefined,
    });
    const policyCursorPage = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    const policyCursor = String(policyCursorPage.meta.next_cursor);
    const oldUnconditionalVersion = (await query<{
      id: string;
      policy_id: string;
      version: number;
    }>(
      harness.server.sql,
      `select pd.id,pd.policy_id,pd.version from policy_definition_versions pd
      join policy_rules pr on pr.policy_definition_version_id=pd.id where pr.id=$1`,
      [modeRules.get("unconditional")!],
    )).rows[0];
    const nextPolicyVersion = uuidV7(), nextPolicyAssignment = uuidV7();
    await harness.server.sql.begin(async (sql) => {
      await query(
        sql,
        "update policy_definition_versions set active=false where id=$1",
        [oldUnconditionalVersion.id],
      );
      await query(
        sql,
        `insert into policy_definition_versions(id,policy_id,version,active)
        values($1,$2,$3,true)`,
        [
          nextPolicyVersion,
          oldUnconditionalVersion.policy_id,
          oldUnconditionalVersion.version + 1,
        ],
      );
      await query(
        sql,
        `insert into policy_rules(
        id,policy_definition_version_id,role_id,capability,resource,condition_kind,rule_name)
        values($1,$2,'operant/crm:sales_rep','read','operant/crm:lead','unconditional','unconditional-v2')`,
        [uuidV7(), nextPolicyVersion],
      );
      await query(
        sql,
        "update policy_assignments set active=false where id=$1",
        [unconditionalAssignment],
      );
      await query(
        sql,
        `insert into policy_assignments(
        id,policy_definition_version_id,boundary_type,project_id,active,source)
        values($1,$2,'project',$3,true,'operator')`,
        [nextPolicyAssignment, nextPolicyVersion, project],
      );
    });
    await expectInvalidOrdinaryCursor(
      ordinaryProcess.launcher,
      ordinaryArgs,
      policyCursor,
    );

    const beforeSuperAdmin = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    const superAdminAssignment = uuidV7();
    await query(
      harness.server.sql,
      `insert into role_assignments(
      id,principal_id,role_id,boundary_type,active)
      values($1,$2,'system:super_admin','system',true)`,
      [superAdminAssignment, ordinaryIdentity.principal_id],
    );
    await expectInvalidOrdinaryCursor(
      ordinaryProcess.launcher,
      ordinaryArgs,
      String(beforeSuperAdmin.meta.next_cursor),
    );
    const withSuperAdmin = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    const activeSuperAdminVersion =
      (await query<{ id: string; version: number }>(
        harness.server.sql,
        `select id,version from role_definition_versions
      where role_id='system:super_admin' and active`,
      )).rows[0];
    await harness.server.sql.begin(async (sql) => {
      await query(
        sql,
        "update role_definition_versions set active=false where id=$1",
        [activeSuperAdminVersion.id],
      );
      await query(
        sql,
        `insert into role_definition_versions(id,role_id,version,active)
        values($1,'system:super_admin',$2,true)`,
        [uuidV7(), activeSuperAdminVersion.version + 1],
      );
    });
    await expectInvalidOrdinaryCursor(
      ordinaryProcess.launcher,
      ordinaryArgs,
      String(withSuperAdmin.meta.next_cursor),
    );
    const withNextSuperAdminVersion = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    await query(
      harness.server.sql,
      "update role_assignments set active=false where id=$1",
      [superAdminAssignment],
    );
    await expectInvalidOrdinaryCursor(
      ordinaryProcess.launcher,
      ordinaryArgs,
      String(withNextSuperAdminVersion.meta.next_cursor),
    );

    const packCursorPage = await runJson(harness, [
      ...ordinaryArgs,
      "--sort",
      "created_at:asc",
      "--limit",
      "1",
    ], ordinaryProcess.launcher);
    const upgradedManifest = parseYamlJsonObject(
      await Deno.readTextFile(manifestPath),
      manifestPath,
    ) as Record<string, unknown>;
    (upgradedManifest.metadata as Record<string, unknown>).version = "9.0.1";
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(upgradedManifest, null, 2),
    );
    await selectStoredCredential(harness, {
      token: adminState.token,
      requestToken: adminState.requestToken,
    });
    const strictPreview = await harness.runOptctl([
      "--json",
      "pack",
      "preview",
      pack,
    ]);
    assertEquals(strictPreview.code, 0, strictPreview.stderr);
    const strictApply = await harness.runOptctl([
      "--json",
      "pack",
      "apply",
      pack,
      "--safe",
    ]);
    assertEquals(strictApply.code, 0, strictApply.stderr);
    await selectStoredCredential(harness, {
      token: ordinaryState.token,
      requestToken: undefined,
    });
    await expectInvalidOrdinaryCursor(
      ordinaryProcess.launcher,
      ordinaryArgs,
      String(packCursorPage.meta.next_cursor),
    );

    const projectVersion = (await query<{ version: number }>(
      harness.server.sql,
      "select version from projects where id=$1",
      [project],
    )).rows[0].version;
    await selectStoredCredential(harness, {
      token: adminState.token,
      requestToken: adminState.requestToken,
    });
    const archivedProject = await harness.runOptctl([
      "--json",
      "project",
      "archive",
      project,
      "--expected-version",
      String(projectVersion),
    ]);
    assertEquals(archivedProject.code, 0, archivedProject.stderr);
    await selectStoredCredential(harness, {
      token: ordinaryState.token,
      requestToken: undefined,
    });
    const archivedProjectResponse = await fetch(
      `${harness.baseUrl}/api/v1/queries`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ordinaryState.token}`,
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
          fields: ["name", "score"],
          include_total: true,
        }),
      },
    );
    assertEquals(archivedProjectResponse.status, 200);
    const archivedProjectQuery = await archivedProjectResponse.json();
    assertEquals(archivedProjectQuery.meta.total, 11);
    await selectStoredCredential(harness, {
      token: adminState.token,
      requestToken: adminState.requestToken,
    });
    const restartBaseline = await runJson(harness, [
      "--project",
      project,
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
    const restartCursor = String(restartBaseline.meta.next_cursor);
    const restartFirstId =
      (restartBaseline.data.items as Array<{ id: string }>)[0].id;
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
      restartCursor,
    ]);
    assert(
      (restartPage.data.items as Array<{ id: string }>)[0].id !==
        restartFirstId,
    );
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

type StoredAuthState = {
  token: string;
  requestToken: string;
  authorizationNonces: Record<string, string>;
};

async function storedAuthState(harness: LiveHarness): Promise<StoredAuthState> {
  const store = JSON.parse(
    await Deno.readTextFile(
      join(harness.rootDir, "xdg-config", "optd", "auth.json"),
    ),
  );
  return store.origins[new URL(harness.baseUrl).origin];
}

async function selectStoredCredential(
  harness: LiveHarness,
  update: { token?: string; requestToken?: string },
): Promise<void> {
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

async function authorizationForRequest(
  harness: LiveHarness,
  requestId: string,
): Promise<string> {
  return (await query<{ authorization_id: string }>(
    harness.server.sql,
    "select authorization_id from agent_authorization_requests where id=$1",
    [requestId],
  )).rows[0].authorization_id;
}

async function authorizationLineage(
  harness: LiveHarness,
  authorizationId: string,
): Promise<{ parent: string | null; root: string }> {
  const row = (await query<{
    parent_authorization_id: string | null;
    root_authorization_id: string;
  }>(
    harness.server.sql,
    `select parent_authorization_id,root_authorization_id
    from agent_authorizations where id=$1`,
    [authorizationId],
  )).rows[0];
  return {
    parent: row.parent_authorization_id,
    root: row.root_authorization_id,
  };
}

async function seedQueryAgentDecidePolicy(
  harness: LiveHarness,
  project: string,
): Promise<void> {
  const version = uuidV7();
  await query(
    harness.server.sql,
    `insert into policy_definition_versions(id,policy_id,version,active)
    values($1,'system:query_agent_decider',1,true)`,
    [version],
  );
  await query(
    harness.server.sql,
    `insert into policy_rules(id,policy_definition_version_id,role_id,capability)
    values($1,$2,'operant/crm:sales_rep','auth.request.decide')`,
    [uuidV7(), version],
  );
  await query(
    harness.server.sql,
    `insert into policy_assignments(
    id,policy_definition_version_id,boundary_type,project_id,active)
    values($1,$2,'project',$3,true)`,
    [uuidV7(), version, project],
  );
}

async function createDelegatedQueryAgent(input: {
  harness: LiveHarness;
  requester: CliLauncher;
  approver: CliLauncher;
  redeemer: CliLauncher;
  requestToken: string;
  approverToken: string;
  project: string;
  name: string;
}): Promise<
  { token: string; authorization: string; parent: string | null; root: string }
> {
  await selectStoredCredential(input.harness, {
    token: undefined,
    requestToken: input.requestToken,
  });
  const requested = await input.requester.runOptctl([
    "--json",
    "auth",
    "request",
    "--role",
    "operant/crm:sales_rep",
    "--project",
    input.project,
    "--reason",
    "delegated bounded query",
  ]);
  assertEquals(requested.code, 0, requested.stderr);
  const requestId = String(JSON.parse(requested.stdout).data.id);
  await selectStoredCredential(input.harness, {
    token: input.approverToken,
    requestToken: undefined,
  });
  const approved = await input.approver.runOptctl([
    "--json",
    "auth",
    "approve",
    requestId,
    "--yes",
    "--agent-name",
    input.name,
  ]);
  assertEquals(approved.code, 0, approved.stderr);
  await selectStoredCredential(input.harness, {
    token: undefined,
    requestToken: input.requestToken,
  });
  const redeemed = await input.redeemer.runOptctl([
    "--json",
    "auth",
    "wait",
    requestId,
  ]);
  assertEquals(redeemed.code, 0, redeemed.stderr);
  const token = (await storedAuthState(input.harness)).token;
  const authorization = await authorizationForRequest(input.harness, requestId);
  return {
    token,
    authorization,
    ...await authorizationLineage(input.harness, authorization),
  };
}

async function fetchAgentQuery(
  harness: LiveHarness,
  token: string,
  request: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${harness.baseUrl}/api/v1/queries`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
}

async function proveAgentMutationBeforeQueryAuthority(
  harness: LiveHarness,
  token: string,
  authorizationId: string,
  request: Record<string, unknown>,
  mutation: "revoked_at" | "superseded_at",
): Promise<void> {
  let release!: () => void;
  let ready!: () => void;
  const releaseWait = new Promise<void>((resolve) => release = resolve);
  const readyWait = new Promise<void>((resolve) => ready = resolve);
  const blocker = harness.server.sql.begin(async (tx) => {
    await query(tx, "lock table auth_contexts in access exclusive mode");
    ready();
    await releaseWait;
  });
  await readyWait;
  const response = fetchAgentQuery(harness, token, request);
  await waitForQueryLock(harness, "%insert into auth_contexts%", 1);
  await query(
    harness.server.sql,
    `update agent_authorizations set ${mutation}=now() where id=$1`,
    [authorizationId],
  );
  release();
  await blocker;
  const denied = await response;
  assertEquals(denied.status, 401);
  assertEquals((await denied.json()).error.code, "credential_invalid");
  await query(
    harness.server.sql,
    `update agent_authorizations set ${mutation}=null where id=$1`,
    [authorizationId],
  );
}

async function proveAgentMutationAfterQueryLocks(
  harness: LiveHarness,
  token: string,
  authorizationId: string,
  table: string,
  request: Record<string, unknown>,
  mutation: "revoked_at" | "superseded_at",
): Promise<void> {
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
  const response = fetchAgentQuery(harness, token, request);
  await waitForQueryLock(harness, `%${table}%`, 1);
  const changed = query(
    harness.server.sql,
    `update agent_authorizations set ${mutation}=now() where id=$1`,
    [authorizationId],
  );
  await waitForQueryLock(
    harness,
    `%update agent_authorizations set ${mutation}=now()%`,
    1,
  );
  release();
  await blocker;
  const disclosed = await response;
  assertEquals(disclosed.status, 200);
  assertEquals((await disclosed.json()).meta.total, 11);
  await changed;
  await query(
    harness.server.sql,
    `update agent_authorizations set ${mutation}=null where id=$1`,
    [authorizationId],
  );
}

async function waitForQueryLock(
  harness: LiveHarness,
  pattern: string,
  minimum: number,
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const waiting = (await query<{ count: number }>(
      harness.server.sql,
      `select count(*)::int count from pg_stat_activity
      where pid<>pg_backend_pid() and wait_event_type='Lock' and query ilike $1`,
      [pattern],
    )).rows[0].count;
    if (waiting >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`query did not reach deterministic lock barrier: ${pattern}`);
}

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

async function expectInvalidOrdinaryCursor(
  launcher: CliLauncher,
  args: string[],
  cursor: string,
): Promise<void> {
  const result = await launcher.runOptctl([
    "--json",
    ...args,
    "--sort",
    "created_at:asc",
    "--limit",
    "1",
    "--cursor",
    cursor,
  ]);
  assert(result.code !== 0, result.stdout);
  assertEquals(result.stdout, "");
  const body = JSON.parse(result.stderr) as Envelope;
  assertEquals(body.error?.code, "invalid_cursor");
  assert(!result.stderr.toLowerCase().includes("select "));
}

async function collectCliPages(
  harness: Awaited<ReturnType<typeof startLiveHarness>>,
  launcher: CliLauncher,
  args: string[],
  sorts: string[],
  limit: number,
): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let total: number | undefined;
  do {
    const page = await runJson(harness, [
      ...args,
      ...sorts.flatMap((sort) => ["--sort", sort]),
      "--limit",
      String(limit),
      ...(cursor ? ["--cursor", cursor] : []),
    ], launcher);
    const items = page.data.items as Array<{ id: string }>;
    total ??= Number(page.meta.total);
    assertEquals(page.meta.total, total);
    if (page.meta.has_more) assertEquals(items.length, limit);
    for (const item of items) {
      assert(!ids.includes(item.id), `duplicate paginated id ${item.id}`);
      ids.push(item.id);
    }
    cursor = page.meta.has_more ? String(page.meta.next_cursor) : undefined;
  } while (cursor);
  assertEquals(ids.length, total);
  return ids;
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

const base64UrlAlphabet =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function trailingBitAlias(value: string): string | null {
  const unusedBits = value.length % 4 === 2
    ? 4
    : value.length % 4 === 3
    ? 2
    : 0;
  if (unusedBits === 0) return null;
  const last = base64UrlAlphabet.indexOf(value.at(-1)!);
  return `${value.slice(0, -1)}${base64UrlAlphabet[last | 1]}`;
}

function decodeBase64Url(value: string): Uint8Array {
  const raw = atob(
    value.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((value.length + 3) % 4),
  );
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
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
