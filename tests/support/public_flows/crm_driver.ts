// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertExists,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
} from "../public_flow_contract.ts";
import {
  type CompletePublicFlowBackend,
  QUIESCENT_HOOK_EVIDENCE,
} from "./backend.ts";
import { isUuidV7, loginProcess, runJson } from "./helpers.ts";
import { runCompleteCrmMigration } from "./crm_migration.ts";

const CRM = "operant/crm";

export async function runCompleteCrmPublicFlow(
  harness: CompletePublicFlowBackend,
): Promise<void> {
  const launchers: PublicFlowLauncher[] = [];
  const output: string[] = [];
  const failures: unknown[] = [];
  try {
    await harness.compileCurrentCli();
    await harness.configureProvider([]);
    const PACK = await harness.assetPath("crm");
    const human = await launcher(harness, launchers, "human");
    const requestOnly = await launcher(harness, launchers, "request_only");
    const agent = await launcher(harness, launchers, "agent");

    const bootstrap = json(
      await ok(
        human.runCli([
          "--json",
          "bootstrap",
          "init",
          "--username",
          "crm-admin",
          "--display-name",
          "CRM Administrator",
          "--password-stdin",
        ], { stdin: "crm acceptance password\n" }),
        output,
      ),
    );
    const humanUserId = String(
      bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
        bootstrap.data.id,
    );
    assert(isUuidV7(humanUserId), JSON.stringify(bootstrap.data));
    await ok(
      requestOnly.runCli([
        "--json",
        "auth",
        "login",
        "--username",
        "crm-admin",
        "--password-stdin",
      ], { stdin: "crm acceptance password\n" }),
      output,
    );

    const homeJson = json(await ok(human.runCli(["--json"]), output));
    const homeToon = toon(await ok(human.runCli([]), output));
    assertSubstantiveParity(homeToon.data, homeJson.data);

    const project = json(
      await ok(
        human.runCli([
          "--json",
          "project",
          "create",
          "sales",
          "--display-name",
          "Sales",
        ]),
        output,
      ),
    );
    const projectId = String(project.data.id);
    assert(isUuidV7(projectId));
    await ok(human.runCli(["project", "select", "sales"]), output);

    const preview = json(
      await ok(
        human.runCli([
          "--json",
          "pack",
          "preview",
          PACK,
        ]),
        output,
      ),
    );
    assertEquals(preview.data.plan.class, "safe");
    await ok(
      human.runCli(["--json", "pack", "apply", PACK, "--safe"]),
      output,
    );
    const persistedApprovalPolicy = await harness.observeCrmApprovalPolicy();
    assertEquals(persistedApprovalPolicy, [{
      role_id: `${CRM}:sales_manager`,
      capability: "changeset.approval.decide",
      resource: "system:changeset-approval",
    }]);
    const persistedRelationshipPolicy = await harness
      .observeCrmRelationshipPolicy();
    assertEquals(
      persistedRelationshipPolicy,
      [
        "activity_contact",
        "activity_lead",
        "activity_opportunity",
        "contact_company",
        "note_lead",
        "opportunity_company",
        "opportunity_contact",
        "opportunity_viewer",
        "task_opportunity",
      ].flatMap((name) =>
        ["link", "unlink"].map((capability) => ({
          capability,
          resource: `${CRM}:${name}`,
        }))
      ),
    );

    const metadataCases = [
      ["home"],
      ["metadata", "pack", CRM],
      ["metadata", "resource", `${CRM}:lead`],
      ["metadata", "action", `${CRM}:convert_lead`],
      ["metadata", "hook", `${CRM}:notify_crm_change`],
      ["metadata", "policy", `${CRM}:sales_access`],
    ];
    for (const command of metadataCases) {
      const plain = toon(
        await ok(
          human.runCli(["--project", projectId, ...command]),
          output,
        ),
      );
      const structured = json(
        await ok(
          human.runCli(["--json", "--project", projectId, ...command]),
          output,
        ),
      );
      assertSubstantiveParity(plain.data, structured.data);
      assertEquals(structured.data.axi_readiness?.ready ?? true, true);
    }
    const security = json(
      await ok(
        human.runCli([
          "--json",
          "--project",
          projectId,
          "metadata",
          "hook",
          `${CRM}:notify_crm_change`,
          "--include-security",
        ]),
        output,
      ),
    );
    assertExists(security.data.security_digest);

    const humanWhoami = json(
      await ok(human.runCli(["--json", "auth", "whoami"]), output),
    );
    assertEquals(humanWhoami.data.credential_kind, "human_full");
    assertEquals(humanWhoami.data.principal.type, "human_user");
    assertEquals(humanWhoami.data.human_user.id, humanUserId);
    assertEquals(humanWhoami.data.human_user.status, "active");
    assertEquals(
      humanWhoami.data.principal.id,
      humanWhoami.data.human_user.principal_id,
    );
    assertEquals("id" in humanWhoami.data, false);
    assertEquals("principal_id" in humanWhoami.data, false);
    assertEquals("principal_type" in humanWhoami.data, false);
    assertEquals("agent" in humanWhoami.data, false);
    assertEquals(
      /token|password|binding|anchor_pid|server_origin/i.test(
        JSON.stringify(humanWhoami.data),
      ),
      false,
    );

    const firstSeed = json(
      await ok(
        human.runCli([
          "--json",
          "--project",
          projectId,
          "seed",
          "commit",
          CRM,
          "--all",
        ]),
        output,
      ),
    );
    assert(
      isUuidV7(String(firstSeed.data.id)),
      JSON.stringify(firstSeed.data),
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:first-seed",
    );

    for (const role of [`${CRM}:sales_manager`, `${CRM}:crm_admin`]) {
      await ok(
        human.runCli([
          "--json",
          "assignment",
          "role",
          "create",
          humanUserId,
          "--role",
          role,
          "--project",
          projectId,
        ]),
        output,
      );
    }
    const roles = json(
      await ok(
        requestOnly.runCli([
          "--json",
          "auth",
          "roles",
          "--boundary",
          "project",
          "--project",
          projectId,
        ]),
        output,
      ),
    );
    assertEquals(roles.data.roles.includes(`${CRM}:sales_manager`), true);
    const request = json(
      await ok(
        requestOnly.runCli([
          "--json",
          "auth",
          "request",
          "--role",
          `${CRM}:sales_manager`,
          "--boundary",
          "project",
          "--project",
          projectId,
          "--reason",
          "Run the reviewed CRM acceptance flow",
        ]),
        output,
      ),
    );
    const requestId = String(request.data.id);
    const waiting = agent.runCli(["--json", "auth", "wait", requestId]);
    await delay(50);
    const approved = await ok(
      human.runCli([
        "--json",
        "auth",
        "approve",
        requestId,
        "--yes",
        "--agent-name",
        "crm-agent",
      ]),
      output,
    );
    assertEquals(/bearer|token/i.test(approved.stdout), false);
    const redeemed = json(await ok(waiting, output));
    assert(isUuidV7(String(redeemed.data.authorization.id)));
    assertEquals(redeemed.data.authorization.role_assignments, [{
      role: `${CRM}:sales_manager`,
      boundary: { type: "project", project_id: projectId },
    }]);
    const directWhoamiResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/me`,
      {
        headers: { authorization: `Bearer ${redeemed.data.token}` },
      },
    );
    const directWhoami = await directWhoamiResponse.json();
    assertEquals(
      directWhoamiResponse.status,
      200,
      JSON.stringify(directWhoami),
    );
    assertEquals(directWhoami.data.principal.type, "agent_user");
    assertEquals(directWhoami.data.credential_kind, "agent_authorization");
    assertEquals(
      directWhoami.data.principal.id,
      directWhoami.data.agent.principal_id,
    );
    assert(
      directWhoami.data.principal.id !==
        directWhoami.data.human_user.principal_id,
    );
    assertEquals(
      directWhoami.data.agent.authorization_id,
      redeemed.data.authorization.id,
    );
    assertEquals(
      directWhoami.data.agent.root_authorization_id,
      redeemed.data.authorization.root_authorization_id,
    );
    assertEquals(directWhoami.data.agent.authorization_ancestry_ids, [
      redeemed.data.authorization.id,
    ]);
    assertEquals(directWhoami.data.role_assignments, [{
      role: `${CRM}:sales_manager`,
      boundary: { type: "project", project_id: projectId },
    }]);
    assertEquals(
      /token|password|anchor_pid/i.test(JSON.stringify(directWhoami.data)),
      false,
    );
    const whoami = json(
      await ok(agent.runCli(["--json", "auth", "whoami"]), output),
    );
    assertEquals(whoami.data.principal.type, "agent_user");
    const { auth_context_id: directContext, ...directIdentity } =
      directWhoami.data;
    const { auth_context_id: cliContext, ...cliIdentity } = whoami.data;
    assert(isUuidV7(String(directContext)));
    assert(isUuidV7(String(cliContext)));
    assertEquals(cliIdentity, directIdentity);
    assertEquals(
      /token|password|binding|anchor_pid|server_origin|request_credential/i
        .test(JSON.stringify(whoami.data)),
      false,
    );
    const toonWhoami = await ok(
      agent.runCli(["auth", "whoami"]),
      output,
    );
    assertEquals(
      /token|password|binding|anchor_pid|server_origin|request_credential/i
        .test(toonWhoami.stdout),
      false,
    );
    for (const field of Object.keys(whoami.data)) {
      assert(toonWhoami.stdout.includes(field));
    }

    await ok(
      human.runCli([
        "--json",
        "auth",
        "revoke",
        String(redeemed.data.authorization.id),
      ]),
      output,
    );
    const revoked = await fetch(`${harness.serverOrigin}/api/v1/auth/me`, {
      headers: { authorization: `Bearer ${redeemed.data.token}` },
    });
    assertEquals(revoked.status, 401);
    const revokedBody = await revoked.text();
    assertEquals(revokedBody.includes("Bearer "), false);
    assertEquals(revokedBody.includes(String(redeemed.data.token)), false);
    const revokedSameProcess = await agent.runCli([
      "--json",
      "auth",
      "whoami",
    ]);
    output.push(revokedSameProcess.stdout, revokedSameProcess.stderr);
    assertEquals(revokedSameProcess.code, 1);
    assertEquals(
      revokedSameProcess.stdout.includes(String(redeemed.data.token)),
      false,
    );
    for (
      const args of [[
        "--json",
        "--project",
        projectId,
        "query",
        `${CRM}:company`,
      ], [
        "--json",
        "--project",
        projectId,
        "action",
        "stage",
        `${CRM}:log_activity`,
        "--input",
        JSON.stringify({
          resource: "lead",
          object_id: crypto.randomUUID(),
          type: "call",
          subject: "Revoked agent must not mutate",
        }),
      ]]
    ) {
      if (args.includes("action")) {
        await assertHookQuiescence(
          harness,
          output,
          "crm:pre-action:revoked-log-activity",
        );
      }
      const denied = await agent.runCli(args);
      output.push(denied.stdout, denied.stderr);
      assertEquals(denied.code, 1, denied.stderr);
      assertEquals(
        denied.stdout.includes(String(redeemed.data.token)),
        false,
      );
      assertEquals(
        denied.stderr.includes(String(redeemed.data.token)),
        false,
      );
    }

    const adminLoginResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "crm-admin",
          password: "crm acceptance password",
        }),
      },
    );
    const adminLogin = await adminLoginResponse.json();
    assertEquals(adminLoginResponse.status, 200);
    const adminToken = String(adminLogin.data.credentials.token);
    const createdUserResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/users`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "disabled-crm-user",
          display_name: "Disabled CRM User",
          password: "disabled CRM user password",
        }),
      },
    );
    const createdUser = await createdUserResponse.json();
    assertEquals(
      createdUserResponse.status,
      201,
      JSON.stringify(createdUser),
    );
    const disabledLoginResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/login`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: "disabled-crm-user",
          password: "disabled CRM user password",
        }),
      },
    );
    const disabledLogin = await disabledLoginResponse.json();
    assertEquals(disabledLoginResponse.status, 200);
    const disabledToken = String(disabledLogin.data.credentials.token);
    const disableResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/users/${createdUser.data.id}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "disabled" }),
      },
    );
    assertEquals(disableResponse.status, 200, await disableResponse.text());
    const disabledWhoami = await fetch(
      `${harness.serverOrigin}/api/v1/auth/me`,
      {
        headers: { authorization: `Bearer ${disabledToken}` },
      },
    );
    assertEquals(disabledWhoami.status, 401);
    const disabledBody = await disabledWhoami.text();
    assertEquals(disabledBody.includes(disabledToken), false);

    const replacementHuman = await loginProcess(harness, {
      username: "crm-admin",
      password: "crm acceptance password",
    });
    launchers.push(replacementHuman.launcher);
    await ok(Promise.resolve(replacementHuman.result), output);

    // Frozen idempotency contract: a second complete seed reconciliation is a
    // successful no-op rather than a failed changeset.
    const beforeSecondSeed = await persistenceCounts(harness);
    const secondSeed = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "seed",
          "commit",
          CRM,
          "--all",
        ]),
        output,
      ),
    );
    assertEquals(secondSeed.data.stage, null);
    assertEquals(await persistenceCounts(harness), beforeSecondSeed);

    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-hook-stage:setup",
    );
    const setupStage = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              key: "company",
              project_id: projectId,
              resource: `${CRM}:company`,
              fields: { name: "Acme", industry: "Software" },
            }, {
              op: "create",
              key: "primary_contact",
              project_id: projectId,
              resource: `${CRM}:contact`,
              fields: { name: "Ada", email: "ada@example.test" },
            }, {
              op: "create",
              key: "old_contact",
              project_id: projectId,
              resource: `${CRM}:contact`,
              fields: { name: "Grace", email: "grace@example.test" },
            }, {
              op: "create",
              key: "opportunity",
              project_id: projectId,
              resource: `${CRM}:opportunity`,
              fields: {
                name: "Enterprise",
                stage: "new",
                expected_revenue: "12345678901234567890.12",
                probability: 10,
              },
            }, {
              op: "link",
              key: "old_link",
              project_id: projectId,
              relationship: `${CRM}:contact_company`,
              from: { $ref: "old_contact.object_id" },
              to: { $ref: "company.object_id" },
              fields: { primary: false },
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        setupStage.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:setup",
    );
    const setupOperation = (key: string) =>
      setupStage.operations.find((value: any) => value.key === key);
    const companyId = String(setupOperation("company").object_id);
    const primaryContactId = String(
      setupOperation("primary_contact").object_id,
    );
    const oldContactId = String(setupOperation("old_contact").object_id);
    const opportunityId = String(setupOperation("opportunity").object_id);
    const oldLinkId = String(setupOperation("old_link").relationship_id);
    for (
      const value of [
        companyId,
        primaryContactId,
        oldContactId,
        opportunityId,
        oldLinkId,
      ]
    ) assert(isUuidV7(value));

    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-hook-stage:all-seven",
    );
    const allSeven = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              key: "lead",
              project_id: projectId,
              resource: `${CRM}:lead`,
              fields: {
                name: "Public Lead",
                email: "lead@example.test",
                status: "new",
                score: 7,
                next_activity_at: "2026-07-24T10:11:12Z",
              },
            }, {
              op: "update",
              project_id: projectId,
              resource: `${CRM}:company`,
              object_id: companyId,
              expected_version: 1,
              set: { industry: "Enterprise software" },
            }, {
              op: "transition",
              project_id: projectId,
              resource: `${CRM}:opportunity`,
              object_id: opportunityId,
              expected_version: 1,
              to: "qualified",
            }, {
              op: "archive",
              project_id: projectId,
              resource: `${CRM}:contact`,
              object_id: oldContactId,
              expected_version: 1,
            }, {
              op: "link",
              key: "new_link",
              project_id: projectId,
              relationship: `${CRM}:contact_company`,
              from: primaryContactId,
              to: companyId,
              fields: { primary: true },
            }, {
              op: "unlink",
              project_id: projectId,
              relationship: `${CRM}:contact_company`,
              relationship_id: oldLinkId,
              expected_version: 1,
            }, {
              op: "comment",
              key: "company_comment",
              project_id: projectId,
              resource: `${CRM}:company`,
              object_id: companyId,
              body: "Updated through the public CRM acceptance graph",
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    assertEquals(allSeven.operations.map((value: any) => value.op), [
      "create",
      "update",
      "transition",
      "archive",
      "link",
      "unlink",
      "comment",
    ]);
    const allSevenInspect = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "changeset",
          "inspect",
          allSeven.id,
        ]),
        output,
      ),
    );
    assertEquals(allSevenInspect.data, allSeven);
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        allSeven.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:all-seven",
    );
    const leadId = String(
      allSeven.operations.find((value: any) => value.key === "lead")
        .object_id,
    );
    assert(isUuidV7(leadId));
    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-action:convert-lead",
    );
    const convertLeadResult = await replacementHuman.launcher.runCli([
      "--json",
      "--project",
      projectId,
      "action",
      "stage",
      `${CRM}:convert_lead`,
      "--input",
      JSON.stringify({ lead_id: leadId }),
    ]);
    output.push(convertLeadResult.stdout, convertLeadResult.stderr);
    assertEquals(
      convertLeadResult.code,
      0,
      `${convertLeadResult.stderr}\n${convertLeadResult.stdout}\n${
        JSON.stringify(await harness.diagnostics())
      }`,
    );
    const convertLead = json(convertLeadResult);
    assertEquals(convertLead.data.source.kind, "action");

    for (
      const [field, authority] of [
        ["principal_id", "spoofed"],
        ["actor", ["spoofed"]],
        ["roles", { deep: { relationship: "spoofed" } }],
      ] as const
    ) {
      await assertHookQuiescence(
        harness,
        output,
        `crm:pre-action:log-activity-spoofed-${field}`,
      );
      const spoofed = await replacementHuman.launcher.runCli([
        "--json",
        "--project",
        projectId,
        "action",
        "stage",
        `${CRM}:log_activity`,
        "--input",
        JSON.stringify({
          resource: "lead",
          object_id: leadId,
          type: "call",
          subject: "Public acceptance call",
          note: "Caller authority is ignored in favor of the frozen actor.",
          [field]: authority,
        }),
      ]);
      output.push(spoofed.stdout, spoofed.stderr);
      assertEquals(spoofed.code, 1, `${field}: ${spoofed.stderr}`);
      assertStringIncludes(
        spoofed.stderr,
        "caller-supplied actor or role authority is not accepted",
      );
    }
    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-action:log-activity-valid",
    );
    const logged = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${CRM}:log_activity`,
          "--input",
          JSON.stringify({
            resource: "lead",
            object_id: leadId,
            type: "call",
            subject: "Public acceptance call",
            note: "Logged by the server-authenticated actor.",
          }),
        ]),
        output,
      ),
    ).data;
    const authenticatedPrincipal = await harness
      .observeAuthContextPrincipal(
        logged.hook_executions[0].authority_snapshot.auth_context_id,
      );
    const note = logged.operations.find((value: any) =>
      value.resource === `${CRM}:note`
    );
    assertEquals(note.fields.author_id, authenticatedPrincipal);
    const actionExecution = logged.hook_executions.find((value: any) =>
      value.phase === "action.stage"
    );
    assertEquals(Object.keys(actionExecution.output), ["operations"]);
    assertEquals(
      actionExecution.output.operations.find((value: any) =>
        value.resource === `${CRM}:note`
      ).fields.author_id,
      authenticatedPrincipal,
    );
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        logged.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:log-activity",
    );

    // The canonical won transition is authored by one sales manager and
    // decided by a distinct currently-authorized human sales manager.
    const reviewerPassword = `crm-reviewer-${crypto.randomUUID()}`;
    const reviewerCreated = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "auth",
          "user",
          "create",
          "--username",
          "crm-reviewer",
          "--display-name",
          "CRM Reviewer",
          "--password-stdin",
        ], { stdin: `${reviewerPassword}\n` }),
        output,
      ),
    );
    const reviewerId = String(reviewerCreated.data.id);
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "assignment",
        "role",
        "create",
        reviewerId,
        "--role",
        `${CRM}:sales_manager`,
        "--project",
        projectId,
      ]),
      output,
    );
    const viewerCredentials: Array<{
      username: string;
      password: string;
      id: string;
      principalId: string;
    }> = [];
    for (const username of ["crm-viewer", "crm-unrelated"]) {
      const password = `${username}-${crypto.randomUUID()}`;
      const created = json(
        await ok(
          human.runCli([
            "--json",
            "auth",
            "user",
            "create",
            "--username",
            username,
            "--display-name",
            username,
            "--password-stdin",
          ], { stdin: `${password}\n` }),
          output,
        ),
      );
      const id = String(created.data.id);
      viewerCredentials.push({
        username,
        password,
        id,
        principalId: String(created.data.principal_id),
      });
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "assignment",
          "role",
          "create",
          id,
          "--role",
          `${CRM}:sales_rep`,
          "--project",
          projectId,
        ]),
        output,
      );
    }
    const reviewerLogin = await loginProcess(harness, {
      username: "crm-reviewer",
      password: reviewerPassword,
    });
    launchers.push(reviewerLogin.launcher);
    await ok(Promise.resolve(reviewerLogin.result), output);
    const viewerLaunchers: PublicFlowLauncher[] = [];
    for (const credentials of viewerCredentials) {
      const login = await loginProcess(harness, credentials);
      launchers.push(login.launcher);
      viewerLaunchers.push(login.launcher);
      await ok(Promise.resolve(login.result), output);
    }
    const relationshipAuthor = json(
      await ok(
        replacementHuman.launcher.runCli(["--json", "auth", "whoami"]),
        output,
      ),
    );
    assertEquals(relationshipAuthor.data.human_user.id, humanUserId);
    const relationshipAuthority = await harness
      .observeCrmRelationshipAuthority({
        principalId: relationshipAuthor.data.principal.id,
        projectId,
      });
    assertEquals(relationshipAuthority, 1);
    const viewerLink = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "link",
              project_id: projectId,
              relationship: `${CRM}:opportunity_viewer`,
              from: opportunityId,
              to: viewerCredentials[0].principalId,
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        viewerLink.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:viewer-link",
    );
    const exactViewerIdentity = json(
      await ok(
        viewerLaunchers[0].runCli(["--json", "auth", "whoami"]),
        output,
      ),
    );
    assertEquals(
      exactViewerIdentity.data.principal.id,
      viewerCredentials[0].principalId,
    );
    const viewerTuple = await harness.observeRelationshipTuple({
      pack: "crm",
      relationship: "opportunity_viewer",
      projectId,
      fromObjectId: opportunityId,
    });
    assertEquals(
      viewerTuple?.toObjectId,
      viewerCredentials[0].principalId,
    );
    const exactViewerRead = await viewerLaunchers[0].runCli([
      "--json",
      "--project",
      projectId,
      "view",
      `${CRM}:opportunity`,
      opportunityId,
    ]);
    output.push(exactViewerRead.stdout, exactViewerRead.stderr);
    assertEquals(exactViewerRead.code, 0, exactViewerRead.stderr);
    const unrelatedViewerRead = await viewerLaunchers[1].runCli([
      "--json",
      "--project",
      projectId,
      "view",
      `${CRM}:opportunity`,
      opportunityId,
    ]);
    output.push(unrelatedViewerRead.stdout, unrelatedViewerRead.stderr);
    assertEquals(unrelatedViewerRead.code, 1);

    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-hook-stage:proposal",
    );
    const proposal = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "transition",
              project_id: projectId,
              resource: `${CRM}:opportunity`,
              object_id: opportunityId,
              expected_version: 2,
              to: "proposal",
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        proposal.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:proposal",
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-action:mark-won",
    );
    const won = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${CRM}:mark_won`,
          "--input",
          JSON.stringify({
            opportunity_id: opportunityId,
            expected_version: 3,
          }),
        ]),
        output,
      ),
    ).data;
    assertEquals(won.status, "awaiting_approval");
    const wonRequirement = won.approval_requirements[0];
    assertEquals(wonRequirement.minimum, 1);
    assertEquals(wonRequirement.allow_initiator, false);
    const selfDecision = await replacementHuman.launcher.runCli([
      "--json",
      "changeset",
      "approve",
      won.id,
      wonRequirement.id,
      "--reason",
      "self approval must be denied",
    ]);
    output.push(selfDecision.stdout, selfDecision.stderr);
    assertEquals(selfDecision.code, 1, selfDecision.stderr);
    const approvalList = json(
      await ok(
        reviewerLogin.launcher.runCli([
          "--json",
          "changeset",
          "approvals",
          won.id,
        ]),
        output,
      ),
    );
    assertEquals(approvalList.data.status, "awaiting_approval");
    const wonApproved = json(
      await ok(
        reviewerLogin.launcher.runCli([
          "--json",
          "changeset",
          "approve",
          won.id,
          wonRequirement.id,
          "--reason",
          "independent sales manager review",
        ]),
        output,
      ),
    );
    assertEquals(wonApproved.data.status, "ready");
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        won.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:mark-won",
    );
    const wonView = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "view",
          `${CRM}:opportunity`,
          opportunityId,
        ]),
        output,
      ),
    );
    const wonViewToon = toon(
      await ok(
        replacementHuman.launcher.runCli([
          "--project",
          projectId,
          "view",
          `${CRM}:opportunity`,
          opportunityId,
        ]),
        output,
      ),
    );
    assertEquals(wonViewToon.data, wonView.data);
    assertEquals(wonView.data.data.stage, "won");
    assertEquals(wonView.data.data.probability, "100");
    assertEquals(wonView.data.fields, undefined);
    const wonHistory = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "history",
          `${CRM}:opportunity`,
          opportunityId,
        ]),
        output,
      ),
    );
    assert(wonHistory.data.items.length >= 4);

    // A distinct proposal proves rejection is terminal and cannot commit.
    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-hook-stage:lost-setup",
    );
    const lostSetup = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              key: "lost_opportunity",
              project_id: projectId,
              resource: `${CRM}:opportunity`,
              fields: {
                name: "Rejected loss",
                stage: "new",
                probability: 10,
              },
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        lostSetup.id,
      ]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "crm:post-commit:lost-setup",
    );
    const lostOpportunityId = String(lostSetup.operations[0].object_id);
    for (
      const [version, to] of [[1, "qualified"], [2, "proposal"]] as const
    ) {
      await assertHookQuiescence(
        harness,
        output,
        `crm:pre-hook-stage:lost-transition-${to}`,
      );
      const stage = json(
        await ok(
          runJson(
            harness,
            ["--json", "changeset", "stage"],
            {
              project_id: projectId,
              operations: [{
                op: "transition",
                project_id: projectId,
                resource: `${CRM}:opportunity`,
                object_id: lostOpportunityId,
                expected_version: version,
                to,
              }],
            },
            replacementHuman.launcher,
          ),
          output,
        ),
      ).data;
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "changeset",
          "commit",
          stage.id,
        ]),
        output,
      );
      await assertHookQuiescence(
        harness,
        output,
        `crm:post-commit:lost-transition-${to}`,
      );
    }
    const lostReasonId = await harness.observeCrmLostReasonId(projectId);
    assert(isUuidV7(lostReasonId));
    await assertHookQuiescence(
      harness,
      output,
      "crm:pre-action:mark-lost",
    );
    const lostStage = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${CRM}:mark_lost`,
          "--input",
          JSON.stringify({
            opportunity_id: lostOpportunityId,
            lost_reason_id: lostReasonId,
            expected_version: 3,
            note: "Canonical lost action hook",
          }),
        ]),
        output,
      ),
    ).data;
    const rejectRequirement = lostStage.approval_requirements?.[0];
    if (rejectRequirement) {
      const rejected = json(
        await ok(
          reviewerLogin.launcher.runCli([
            "--json",
            "changeset",
            "reject",
            lostStage.id,
            rejectRequirement.id,
            "--reason",
            "loss rejected",
          ]),
          output,
        ),
      );
      assertEquals(rejected.data.status, "rejected");
      const rejectedCommit = await replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        lostStage.id,
      ]);
      output.push(rejectedCommit.stdout, rejectedCommit.stderr);
      assertEquals(rejectedCommit.code, 1);
    } else {
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "changeset",
          "commit",
          lostStage.id,
        ]),
        output,
      );
      await assertHookQuiescence(
        harness,
        output,
        "crm:post-commit:mark-lost",
      );
      await assertHookQuiescence(
        harness,
        output,
        "crm:pre-action:terminal-mark-won",
      );
      const terminal = await replacementHuman.launcher.runCli([
        "--json",
        "--project",
        projectId,
        "action",
        "stage",
        `${CRM}:mark_won`,
        "--input",
        JSON.stringify({
          opportunity_id: lostOpportunityId,
          expected_version: 4,
        }),
      ]);
      output.push(terminal.stdout, terminal.stderr);
      assertEquals(terminal.code, 1);
    }

    // Exercise the CRM-owned secret slot and exact grant head lifecycle.
    const secretV1 = `crm-secret-v1-${crypto.randomUUID()}`;
    const secretV2 = `crm-secret-v2-${crypto.randomUUID()}`;
    const replacementSecret = `crm-secret-replacement-${crypto.randomUUID()}`;
    const secretCreate = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "secret",
          "create",
          "crm_webhook",
          "--stdin",
          "--description",
          "CRM after-commit credential",
        ], { stdin: `${secretV1}\n` }),
        output,
      ),
    );
    assertEquals(JSON.stringify(secretCreate).includes(secretV1), false);
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "secret",
        "rotate",
        "crm_webhook",
        "--stdin",
      ], { stdin: `${secretV2}\n` }),
      output,
    );
    const secretReplacement = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "secret",
          "create",
          "crm_webhook_replacement",
          "--stdin",
        ], { stdin: `${replacementSecret}\n` }),
        output,
      ),
    );
    assertEquals(
      JSON.stringify(secretReplacement).includes(replacementSecret),
      false,
    );
    const grant = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "secret",
          "grant",
          "crm_webhook",
          "--hook",
          `${CRM}:notify_crm_change`,
          "--slot",
          "crm_webhook_token",
        ]),
        output,
      ),
    );
    const grantId = String(grant.data.grant_id ?? grant.data.id);
    assert(isUuidV7(grantId));
    const replacedGrant = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "secret",
          "replace-grant",
          grantId,
          "--secret",
          "crm_webhook_replacement",
        ]),
        output,
      ),
    );
    const replacementGrantId = String(
      replacedGrant.data.grant_id ?? replacedGrant.data.id,
    );
    assert(isUuidV7(replacementGrantId));
    const grants = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "secret",
          "grants",
        ]),
        output,
      ),
    );
    assertEquals(
      JSON.stringify(grants.data).includes(replacementGrantId),
      true,
    );

    // Create one delivery for a controllable terminalization path. This is the
    // sole commit boundary that intentionally remains non-quiescent.
    await harness.restartServer({
      environment: { OPERANT_OUTBOX_POLL_INTERVAL_MS: "60000" },
    });
    await harness.waitUntilReady();
    await refreshHumanLauncher(
      harness,
      launchers,
      replacementHuman,
      output,
      "crm-admin",
      "crm acceptance password",
    );
    let outboxList = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "outbox",
          "list",
          "--hook",
          `${CRM}:notify_crm_change`,
          "--limit",
          "100",
        ]),
        output,
      ),
    );
    let deliveries = outboxList.data.items ?? outboxList.data.deliveries;
    assert(deliveries.length > 1, JSON.stringify(outboxList.data));
    let cancellable = deliveries.find((item: any) =>
      item.status === "pending" || item.status === "retry_wait"
    );
    if (!cancellable) {
      for (
        let attempt = 0;
        attempt < 100 &&
        deliveries.some((item: any) => item.status === "running");
        attempt++
      ) {
        await delay(100);
        outboxList = json(
          await ok(
            replacementHuman.launcher.runCli([
              "--json",
              "outbox",
              "list",
              "--hook",
              `${CRM}:notify_crm_change`,
              "--limit",
              "100",
            ]),
            output,
          ),
        );
        deliveries = outboxList.data.items ?? outboxList.data.deliveries;
      }
      const cancellationSetup = json(
        await ok(
          runJson(
            harness,
            ["--json", "changeset", "stage"],
            {
              project_id: projectId,
              operations: [{
                op: "create",
                project_id: projectId,
                resource: `${CRM}:company`,
                fields: {
                  name: `Cancellation proof ${crypto.randomUUID()}`,
                  industry: "Testing",
                },
              }],
            },
            replacementHuman.launcher,
          ),
          output,
        ),
      ).data;
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "changeset",
          "commit",
          cancellationSetup.id,
        ]),
        output,
      );
      const directListResponse = await fetch(
        `${harness.serverOrigin}/api/v1/outbox?hook=${CRM}%3Anotify_crm_change&limit=100`,
        { headers: { authorization: `Bearer ${adminToken}` } },
      );
      const directList = await directListResponse.json();
      assertEquals(
        directListResponse.status,
        200,
        JSON.stringify(directList),
      );
      deliveries = directList.data.items;
      output.push(JSON.stringify({
        trace: "post-commit-delivery-control",
        states: deliveries.map((item: any) => item.status),
      }));
      cancellable = deliveries.find((item: any) =>
        item.status === "pending" || item.status === "retry_wait"
      );
    }
    for (let attempt = 0; !cancellable && attempt < 100; attempt++) {
      await delay(20);
      outboxList = json(
        await ok(
          replacementHuman.launcher.runCli([
            "--json",
            "outbox",
            "list",
            "--hook",
            `${CRM}:notify_crm_change`,
            "--limit",
            "100",
          ]),
          output,
        ),
      );
      deliveries = outboxList.data.items ?? outboxList.data.deliveries;
      cancellable = deliveries.find((item: any) =>
        item.status === "pending" || item.status === "retry_wait"
      );
    }
    assert(cancellable);
    const inspectedPending = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "outbox",
          "inspect",
          cancellable.id,
        ]),
        output,
      ),
    );
    assertEquals(inspectedPending.data.status, cancellable.status);
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "outbox",
        "cancel",
        cancellable.id,
        "--reason",
        "acceptance cancellation",
      ]),
      output,
    );
    const cancelledRetry = await replacementHuman.launcher.runCli([
      "--json",
      "outbox",
      "retry",
      cancellable.id,
      "--reason",
      "retry only admits dead letters",
    ]);
    output.push(cancelledRetry.stdout, cancelledRetry.stderr);
    assertEquals(cancelledRetry.code, 1);
    await harness.restartServer({
      environment: { OPERANT_OUTBOX_POLL_INTERVAL_MS: "20" },
    });
    await harness.waitUntilReady();
    await refreshHumanLauncher(
      harness,
      launchers,
      replacementHuman,
      output,
      "crm-admin",
      "crm acceptance password",
    );
    const drainSetup = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              project_id: projectId,
              resource: `${CRM}:company`,
              fields: {
                name: `Drain proof ${crypto.randomUUID()}`,
                industry: "Testing",
              },
            }],
          },
          replacementHuman.launcher,
        ),
        output,
      ),
    ).data;
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "changeset",
        "commit",
        drainSetup.id,
      ]),
      output,
    );
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "outbox",
        "drain",
        "--limit",
        "25",
      ]),
      output,
    );
    const attemptedList = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "outbox",
          "list",
          "--hook",
          `${CRM}:notify_crm_change`,
          "--limit",
          "100",
        ]),
        output,
      ),
    );
    const attempted = (
      attemptedList.data.items ?? attemptedList.data.deliveries
    ).find((item: any) =>
      ["succeeded", "retry_wait", "dead_letter"].includes(item.status)
    );
    assert(attempted);
    const attempts = json(
      await ok(
        replacementHuman.launcher.runCli([
          "--json",
          "outbox",
          "attempts",
          attempted.id,
        ]),
        output,
      ),
    );
    assert((attempts.data.items ?? attempts.data.attempts).length >= 1);

    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "secret",
        "revoke-grant",
        replacementGrantId,
      ]),
      output,
    );
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "secret",
        "disable",
        "crm_webhook",
      ]),
      output,
    );
    await ok(
      replacementHuman.launcher.runCli([
        "--json",
        "secret",
        "disable",
        "crm_webhook_replacement",
      ]),
      output,
    );
    assertEquals(
      await harness.ciphertextContainsAny([
        secretV1,
        secretV2,
        replacementSecret,
      ]),
      false,
    );
    await runCompleteCrmMigration(
      harness,
      replacementHuman.launcher,
      projectId,
      output,
    );

    const secretDiagnostics = await harness.diagnostics();
    const observedText = [
      ...output,
      secretDiagnostics.serverLogs,
    ].join("\n");
    for (const plaintext of [secretV1, secretV2, replacementSecret]) {
      assertEquals(observedText.includes(plaintext), false);
    }
  } catch (error) {
    failures.push(error);
  }
  const cleanup = await Promise.allSettled([
    assertNoLeaks(harness, output),
    ...launchers.reverse().map((value) => value.close()),
  ]);
  failures.push(
    ...cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    ),
  );
  if (failures.length) {
    throw new AggregateError(
      failures,
      "CRM flow, diagnostics, or launcher cleanup failed",
    );
  }
}

async function refreshHumanLauncher(
  harness: CompletePublicFlowBackend,
  launchers: PublicFlowLauncher[],
  holder: Readonly<{ launcher: PublicFlowLauncher }>,
  output: string[],
  username: string,
  password: string,
): Promise<void> {
  const refreshed = await loginProcess(harness, { username, password });
  launchers.push(refreshed.launcher);
  await ok(Promise.resolve(refreshed.result), output);
  Object.defineProperty(holder, "launcher", {
    value: refreshed.launcher,
    configurable: true,
  });
}

async function assertHookQuiescence(
  harness: CompletePublicFlowBackend,
  output: string[],
  boundary: string,
): Promise<void> {
  const evidence = await harness.awaitHookQuiescence();
  output.push(JSON.stringify({
    trace: "hook-quiescence",
    boundary,
    ...evidence,
  }));
  assertEquals(evidence, QUIESCENT_HOOK_EVIDENCE, boundary);
}

async function launcher(
  harness: CompletePublicFlowBackend,
  all: PublicFlowLauncher[],
  kind: "human" | "request_only" | "agent",
) {
  const value = await harness.createProcessTreeLauncher(kind);
  all.push(value);
  return value;
}
async function ok(promise: Promise<PublicFlowCommandResult>, output: string[]) {
  const result = await promise;
  output.push(result.stdout, result.stderr);
  assertEquals(result.code, 0, result.stderr);
  return result;
}
function json(result: PublicFlowCommandResult): any {
  const value = JSON.parse(result.stdout);
  assertEquals(value.ok, true);
  return value;
}
function toon(result: PublicFlowCommandResult): any {
  const value = decodeToon(result.stdout) as any;
  assertEquals(value.ok, true);
  return value;
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function assertSubstantiveParity(actual: any, expected: any) {
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "generated_at").map((
          [key, child],
        ) => [key, normalize(child)]),
      );
    }
    return value;
  };
  assertEquals(normalize(actual), normalize(expected));
}
async function persistenceCounts(harness: CompletePublicFlowBackend) {
  return await harness.observePersistenceCounts();
}
async function assertNoLeaks(
  harness: CompletePublicFlowBackend,
  output: string[],
) {
  const diagnostics = await harness.diagnostics();
  const text = [...output, diagnostics.serverLogs].join("\n");
  for (
    const forbidden of [
      "crm acceptance password",
      "authorization: Bearer",
      "postgres://",
      "OPERANT_SECRET_MASTER_KEY",
      "BEGIN PRIVATE KEY",
      "at file://",
    ]
  ) assertEquals(text.includes(forbidden), false, `leaked ${forbidden}`);
  assertNotEquals(text.length, 0);
}
