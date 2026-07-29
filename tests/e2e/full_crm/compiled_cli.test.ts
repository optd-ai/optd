// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertExists,
  assertMatch,
  assertNotEquals,
  assertStringIncludes,
} from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import { join } from "jsr:@std/path";
import { isUuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import { query } from "../../../src/adapters/outbound/postgres/client.ts";
import {
  type CliLauncher,
  type CliResult,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

const CRM = "operant/crm";
const PACK = join(Deno.cwd(), "prototypes", "crm-default-pack");
const logLevels = Deno.env.get("OPERANT_LOG_LEVEL") === "trace"
  ? ["trace"] as const
  : ["info"] as const;

for (const logLevel of logLevels) {
  Deno.test({
    name:
      `forced-current compiled CLI completes the public CRM acceptance flow (${logLevel})`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const harness = await startLiveHarness({
        forceFreshCompile: true,
        environment: {
          OPERANT_LOG_LEVEL: logLevel,
          OPERANT_OUTBOX_POLL_INTERVAL_MS: "60000",
          OPERANT_OUTBOX_INITIAL_BACKOFF_MS: "600000",
          OPERANT_OUTBOX_MAX_BACKOFF_MS: "600000",
          OPERANT_SECRET_MASTER_KEY: btoa(
            String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
          ),
        },
      });
      const launchers: CliLauncher[] = [];
      const output: string[] = [];
      try {
        assertStringIncludes(harness.binaryPath, harness.binarySourceDigest);
        assertStringIncludes(harness.binaryPath, harness.rootDir);
        const human = await launcher(harness, launchers, "human");
        const requestOnly = await launcher(harness, launchers, "request_only");
        const agent = await launcher(harness, launchers, "agent");

        const bootstrap = json(
          await ok(
            human.runOptctl([
              "--json",
              "bootstrap",
              "init",
              "--username",
              "crm-admin",
              "--display-name",
              "CRM Administrator",
              "--password-stdin",
            ], "crm acceptance password\n"),
            output,
          ),
        );
        const humanUserId = String(
          bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
            bootstrap.data.id,
        );
        assert(isUuidV7(humanUserId), JSON.stringify(bootstrap.data));

        const homeJson = json(await ok(human.runOptctl(["--json"]), output));
        const homeToon = toon(await ok(human.runOptctl([]), output));
        assertSubstantiveParity(homeToon.data, homeJson.data);

        const project = json(
          await ok(
            human.runOptctl([
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
        await ok(human.runOptctl(["project", "select", "sales"]), output);

        const preview = json(
          await ok(
            human.runOptctl([
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
          human.runOptctl(["--json", "pack", "apply", PACK, "--safe"]),
          output,
        );
        const persistedApprovalPolicy = await query<{
          role_id: string;
          capability: string;
          resource: string;
        }>(
          harness.server.sql,
          `select pr.role_id,pr.capability,pr.resource
           from policy_rules pr
           join policy_definition_versions pdv
             on pdv.id=pr.policy_definition_version_id
          where pdv.policy_id=$1 and pr.rule_name='sales_manager_approval'`,
          [`${CRM}:sales_access`],
        );
        assertEquals(persistedApprovalPolicy.rows, [{
          role_id: `${CRM}:sales_manager`,
          capability: "changeset.approval.decide",
          resource: "system:changeset-approval",
        }]);
        const persistedRelationshipPolicy = await query<{
          capability: string;
          resource: string;
        }>(
          harness.server.sql,
          `select pr.capability,pr.resource
           from policy_rules pr
           join policy_definition_versions pdv
             on pdv.id=pr.policy_definition_version_id
          where pdv.policy_id=$1 and pr.rule_name='crm_admin_relationship_links'
          order by pr.resource,pr.capability`,
          [`${CRM}:sales_access`],
        );
        assertEquals(
          persistedRelationshipPolicy.rows,
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
              human.runOptctl(["--project", projectId, ...command]),
              output,
            ),
          );
          const structured = json(
            await ok(
              human.runOptctl(["--json", "--project", projectId, ...command]),
              output,
            ),
          );
          assertSubstantiveParity(plain.data, structured.data);
          assertEquals(structured.data.axi_readiness?.ready ?? true, true);
        }
        const security = json(
          await ok(
            human.runOptctl([
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
          await ok(human.runOptctl(["--json", "auth", "whoami"]), output),
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
            human.runOptctl([
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

        for (const role of [`${CRM}:sales_manager`, `${CRM}:crm_admin`]) {
          await ok(
            human.runOptctl([
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
            requestOnly.runOptctl([
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
            requestOnly.runOptctl([
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
        const waiting = agent.runOptctl(["--json", "auth", "wait", requestId]);
        await delay(50);
        const approved = await ok(
          human.runOptctl([
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
          `${harness.baseUrl}/api/v1/auth/me`,
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
          await ok(agent.runOptctl(["--json", "auth", "whoami"]), output),
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
          agent.runOptctl(["auth", "whoami"]),
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
          human.runOptctl([
            "--json",
            "auth",
            "revoke",
            String(redeemed.data.authorization.id),
          ]),
          output,
        );
        const revoked = await fetch(`${harness.baseUrl}/api/v1/auth/me`, {
          headers: { authorization: `Bearer ${redeemed.data.token}` },
        });
        assertEquals(revoked.status, 401);
        const revokedBody = await revoked.text();
        assertEquals(revokedBody.includes("Bearer "), false);
        assertEquals(revokedBody.includes(String(redeemed.data.token)), false);
        const revokedSameProcess = await agent.runOptctl([
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
          const denied = await agent.runOptctl(args);
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
          `${harness.baseUrl}/api/v1/auth/login`,
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
          `${harness.baseUrl}/api/v1/auth/users`,
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
          `${harness.baseUrl}/api/v1/auth/login`,
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
          `${harness.baseUrl}/api/v1/auth/users/${createdUser.data.id}`,
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
          `${harness.baseUrl}/api/v1/auth/me`,
          {
            headers: { authorization: `Bearer ${disabledToken}` },
          },
        );
        assertEquals(disabledWhoami.status, 401);
        const disabledBody = await disabledWhoami.text();
        assertEquals(disabledBody.includes(disabledToken), false);

        const replacementHuman = await harness.loginProcess({
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
            replacementHuman.launcher.runOptctl([
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

        const setupStage = json(
          await ok(
            harness.runJson(
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            setupStage.id,
          ]),
          output,
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

        const allSeven = json(
          await ok(
            harness.runJson(
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
            replacementHuman.launcher.runOptctl([
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            allSeven.id,
          ]),
          output,
        );
        const leadId = String(
          allSeven.operations.find((value: any) => value.key === "lead")
            .object_id,
        );
        assert(isUuidV7(leadId));
        const convertLeadResult = await replacementHuman.launcher.runOptctl([
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
          const spoofed = await replacementHuman.launcher.runOptctl([
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
        const logged = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
        const authenticatedPrincipal = (await query<{ principal_id: string }>(
          harness.server.sql,
          "select principal_id from auth_contexts where id=$1",
          [logged.hook_executions[0].authority_snapshot.auth_context_id],
        )).rows[0].principal_id;
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            logged.id,
          ]),
          output,
        );

        // The canonical won transition is authored by one sales manager and
        // decided by a distinct currently-authorized human sales manager.
        const reviewerPassword = `crm-reviewer-${crypto.randomUUID()}`;
        const reviewerCreated = json(
          await ok(
            replacementHuman.launcher.runOptctl([
              "--json",
              "auth",
              "user",
              "create",
              "--username",
              "crm-reviewer",
              "--display-name",
              "CRM Reviewer",
              "--password-stdin",
            ], `${reviewerPassword}\n`),
            output,
          ),
        );
        const reviewerId = String(reviewerCreated.data.id);
        await ok(
          replacementHuman.launcher.runOptctl([
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
              human.runOptctl([
                "--json",
                "auth",
                "user",
                "create",
                "--username",
                username,
                "--display-name",
                username,
                "--password-stdin",
              ], `${password}\n`),
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
            replacementHuman.launcher.runOptctl([
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
        const reviewerLogin = await harness.loginProcess({
          username: "crm-reviewer",
          password: reviewerPassword,
        });
        launchers.push(reviewerLogin.launcher);
        await ok(Promise.resolve(reviewerLogin.result), output);
        const viewerLaunchers: CliLauncher[] = [];
        for (const credentials of viewerCredentials) {
          const login = await harness.loginProcess(credentials);
          launchers.push(login.launcher);
          viewerLaunchers.push(login.launcher);
          await ok(Promise.resolve(login.result), output);
        }
        const relationshipAuthor = json(
          await ok(
            replacementHuman.launcher.runOptctl(["--json", "auth", "whoami"]),
            output,
          ),
        );
        assertEquals(relationshipAuthor.data.human_user.id, humanUserId);
        const relationshipAuthority = await query<{ count: number }>(
          harness.server.sql,
          `select count(*)::int count
             from role_assignments ra
             join policy_rules pr on pr.role_id=ra.role_id
             join policy_definition_versions pdv
               on pdv.id=pr.policy_definition_version_id and pdv.active
             join policy_assignments pa
               on pa.policy_definition_version_id=pdv.id and pa.active
            where ra.principal_id=$1 and ra.active
              and ra.role_id=$2 and ra.project_id=$3
              and pr.capability='link' and pr.resource=$4
              and pa.boundary_type='all_projects'`,
          [
            relationshipAuthor.data.principal.id,
            `${CRM}:crm_admin`,
            projectId,
            `${CRM}:opportunity_viewer`,
          ],
        );
        assertEquals(relationshipAuthority.rows[0].count, 1);
        const viewerLink = json(
          await ok(
            harness.runJson(
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            viewerLink.id,
          ]),
          output,
        );
        const exactViewerIdentity = json(
          await ok(
            viewerLaunchers[0].runOptctl(["--json", "auth", "whoami"]),
            output,
          ),
        );
        assertEquals(
          exactViewerIdentity.data.principal.id,
          viewerCredentials[0].principalId,
        );
        const viewerTable = (await query<{ table_name: string }>(
          harness.server.sql,
          `select table_name from pack_runtime_tables
            where publisher='operant' and pack_name='crm'
              and definition_kind='relationship'
              and definition_name='opportunity_viewer'`,
        )).rows[0].table_name;
        assertMatch(viewerTable, /^[a-z0-9_]+$/);
        const viewerTuple = await query<{
          from_object_id: string;
          to_object_id: string;
        }>(
          harness.server.sql,
          `select from_object_id,to_object_id
             from ${viewerTable}
            where project_id=$1 and from_object_id=$2 and archived_at is null`,
          [projectId, opportunityId],
        );
        assertEquals(
          viewerTuple.rows[0]?.to_object_id,
          viewerCredentials[0].principalId,
        );
        const exactViewerRead = await viewerLaunchers[0].runOptctl([
          "--json",
          "--project",
          projectId,
          "view",
          `${CRM}:opportunity`,
          opportunityId,
        ]);
        output.push(exactViewerRead.stdout, exactViewerRead.stderr);
        assertEquals(exactViewerRead.code, 0, exactViewerRead.stderr);
        const unrelatedViewerRead = await viewerLaunchers[1].runOptctl([
          "--json",
          "--project",
          projectId,
          "view",
          `${CRM}:opportunity`,
          opportunityId,
        ]);
        output.push(unrelatedViewerRead.stdout, unrelatedViewerRead.stderr);
        assertEquals(unrelatedViewerRead.code, 1);

        const proposal = json(
          await ok(
            harness.runJson(
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            proposal.id,
          ]),
          output,
        );
        const won = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
        const selfDecision = await replacementHuman.launcher.runOptctl([
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
            reviewerLogin.launcher.runOptctl([
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
            reviewerLogin.launcher.runOptctl([
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            won.id,
          ]),
          output,
        );
        const wonView = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
        const lostSetup = json(
          await ok(
            harness.runJson(
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            lostSetup.id,
          ]),
          output,
        );
        const lostOpportunityId = String(lostSetup.operations[0].object_id);
        for (
          const [version, to] of [[1, "qualified"], [2, "proposal"]] as const
        ) {
          const stage = json(
            await ok(
              harness.runJson(
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
            replacementHuman.launcher.runOptctl([
              "--json",
              "changeset",
              "commit",
              stage.id,
            ]),
            output,
          );
        }
        const lostReasons = json(
          await ok(
            replacementHuman.launcher.runOptctl([
              "--json",
              "--project",
              projectId,
              "query",
              `${CRM}:lost_reason`,
              "--limit",
              "1",
            ]),
            output,
          ),
        );
        const lostReasonId = String(lostReasons.data.items[0].id);
        const lostStage = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
              reviewerLogin.launcher.runOptctl([
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
          const rejectedCommit = await replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            lostStage.id,
          ]);
          output.push(rejectedCommit.stdout, rejectedCommit.stderr);
          assertEquals(rejectedCommit.code, 1);
        } else {
          await ok(
            replacementHuman.launcher.runOptctl([
              "--json",
              "changeset",
              "commit",
              lostStage.id,
            ]),
            output,
          );
          const terminal = await replacementHuman.launcher.runOptctl([
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
        const replacementSecret =
          `crm-secret-replacement-${crypto.randomUUID()}`;
        const secretCreate = json(
          await ok(
            replacementHuman.launcher.runOptctl([
              "--json",
              "secret",
              "create",
              "crm_webhook",
              "--stdin",
              "--description",
              "CRM after-commit credential",
            ], `${secretV1}\n`),
            output,
          ),
        );
        assertEquals(JSON.stringify(secretCreate).includes(secretV1), false);
        await ok(
          replacementHuman.launcher.runOptctl([
            "--json",
            "secret",
            "rotate",
            "crm_webhook",
            "--stdin",
          ], `${secretV2}\n`),
          output,
        );
        const secretReplacement = json(
          await ok(
            replacementHuman.launcher.runOptctl([
              "--json",
              "secret",
              "create",
              "crm_webhook_replacement",
              "--stdin",
            ], `${replacementSecret}\n`),
            output,
          ),
        );
        assertEquals(
          JSON.stringify(secretReplacement).includes(replacementSecret),
          false,
        );
        const grant = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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

        // Existing commits generated real persisted after-commit deliveries. Use
        // only public controls and observed actual states for administration.
        let outboxList = json(
          await ok(
            replacementHuman.launcher.runOptctl([
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
                replacementHuman.launcher.runOptctl([
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
              harness.runJson(
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
            replacementHuman.launcher.runOptctl([
              "--json",
              "changeset",
              "commit",
              cancellationSetup.id,
            ]),
            output,
          );
          outboxList = json(
            await ok(
              replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "outbox",
            "cancel",
            cancellable.id,
            "--reason",
            "acceptance cancellation",
          ]),
          output,
        );
        const cancelledRetry = await replacementHuman.launcher.runOptctl([
          "--json",
          "outbox",
          "retry",
          cancellable.id,
          "--reason",
          "retry only admits dead letters",
        ]);
        output.push(cancelledRetry.stdout, cancelledRetry.stderr);
        assertEquals(cancelledRetry.code, 1);
        const drainSetup = json(
          await ok(
            harness.runJson(
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "changeset",
            "commit",
            drainSetup.id,
          ]),
          output,
        );
        await ok(
          replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
            replacementHuman.launcher.runOptctl([
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
          replacementHuman.launcher.runOptctl([
            "--json",
            "secret",
            "revoke-grant",
            replacementGrantId,
          ]),
          output,
        );
        await ok(
          replacementHuman.launcher.runOptctl([
            "--json",
            "secret",
            "disable",
            "crm_webhook",
          ]),
          output,
        );
        await ok(
          replacementHuman.launcher.runOptctl([
            "--json",
            "secret",
            "disable",
            "crm_webhook_replacement",
          ]),
          output,
        );
        const encryptedObservation = await query<{ plaintext: boolean }>(
          harness.server.sql,
          `select exists(
           select 1 from platform_secrets
            where ciphertext::text like '%' || $1 || '%'
               or ciphertext::text like '%' || $2 || '%'
               or ciphertext::text like '%' || $3 || '%'
         ) plaintext`,
          [secretV1, secretV2, replacementSecret],
        );
        assertEquals(encryptedObservation.rows[0].plaintext, false);
        const secretDiagnostics = await harness.diagnostics();
        const observedText = [
          ...output,
          secretDiagnostics.server,
          secretDiagnostics.hooks,
        ].join("\n");
        for (const plaintext of [secretV1, secretV2, replacementSecret]) {
          assertEquals(observedText.includes(plaintext), false);
        }
      } finally {
        await assertNoLeaks(harness, output).catch(() => undefined);
        for (const value of launchers.reverse()) {
          await value.close().catch(() => undefined);
        }
        await harness.close();
      }
    },
  });
}

Deno.test({
  name: "CRM public output source and selected trace leak barriers",
  async fn() {
    const sources = await Promise.all([
      Deno.readTextFile(join(PACK, "hooks", "notify_crm_change.ts")),
      Deno.readTextFile(join(PACK, "hooks", "convert_lead.ts")),
    ]);
    for (const source of sources) {
      assertEquals(
        /Bearer |authorization:|OPERANT_DATABASE_URL|postgres:\/\//i.test(
          source,
        ),
        false,
      );
    }
  },
});

async function launcher(
  harness: LiveHarness,
  all: CliLauncher[],
  kind: "human" | "request_only" | "agent",
) {
  const value = await harness.createProcessTreeLauncher(kind);
  all.push(value);
  return value;
}
async function ok(promise: Promise<CliResult>, output: string[]) {
  const result = await promise;
  output.push(result.stdout, result.stderr);
  assertEquals(result.code, 0, result.stderr);
  return result;
}
function json(result: CliResult): any {
  const value = JSON.parse(result.stdout);
  assertEquals(value.ok, true);
  return value;
}
function toon(result: CliResult): any {
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
async function persistenceCounts(harness: LiveHarness) {
  const counts = await query<{ stages: string; versions: string }>(
    harness.server.sql,
    `select
       (select count(*)::text from staged_changesets) stages,
       (select count(*)::text from object_versions) versions`,
  );
  return counts.rows[0];
}
async function assertNoLeaks(harness: LiveHarness, output: string[]) {
  const diagnostics = await harness.diagnostics();
  const text = [...output, diagnostics.server, diagnostics.hooks].join("\n");
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
