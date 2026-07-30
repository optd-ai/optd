// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import type {
  PublicFlowCommandResult,
  PublicFlowLauncher,
} from "../public_flow_contract.ts";
import type { CompletePublicFlowBackend } from "./backend.ts";
import { isUuidV7, runJson } from "./helpers.ts";

const PROJECTS = "operant/projects";

export async function runCompleteProjectsPublicFlow(
  harness: CompletePublicFlowBackend,
): Promise<void> {
  const launchers: PublicFlowLauncher[] = [];
  const output: string[] = [];
  const failures: unknown[] = [];
  try {
    await harness.compileCurrentCli();
    await harness.configureProvider([
      {
        kind: "retry_then_success",
        retryAfterSeconds: 1,
        successHoldToken: "projects-retry-success",
        body: { retry: true },
      },
      { kind: "retry", retryAfterSeconds: 600, body: { retry: true } },
    ]);
    const PACK = await harness.assetPath("projects");
    const AUXILIARY_PACK = await harness.assetPath("projects_auxiliary");
    const human = await launcher(harness, launchers, "human");
    const requester = await launcher(harness, launchers, "request_only");
    const agent = await launcher(harness, launchers, "agent");
    const bootstrap = json(
      await ok(
        human.runCli([
          "--json",
          "bootstrap",
          "init",
          "--username",
          "projects-admin",
          "--display-name",
          "Projects Administrator",
          "--password-stdin",
        ], { stdin: "projects acceptance password\n" }),
        output,
      ),
    );
    const humanId = String(
      bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
        bootstrap.data.id,
    );
    assert(isUuidV7(humanId));
    await ok(
      requester.runCli([
        "--json",
        "auth",
        "login",
        "--username",
        "projects-admin",
        "--password-stdin",
      ], { stdin: "projects acceptance password\n" }),
      output,
    );

    assertParity(
      toon(await ok(human.runCli([]), output)).data,
      json(await ok(human.runCli(["--json"]), output)).data,
    );
    const hostProject = json(
      await ok(
        human.runCli([
          "--json",
          "project",
          "create",
          "delivery",
          "--display-name",
          "Delivery",
        ]),
        output,
      ),
    );
    const projectId = String(hostProject.data.id);
    assert(isUuidV7(projectId));
    await ok(human.runCli(["project", "select", "delivery"]), output);

    const preview = json(
      await ok(
        human.runCli(["--json", "pack", "preview", PACK]),
        output,
      ),
    );
    assertEquals(preview.data.plan.class, "safe");
    await ok(
      human.runCli(["--json", "pack", "apply", PACK, "--safe"]),
      output,
    );
    const auxiliaryPreview = json(
      await ok(
        human.runCli(["--json", "pack", "preview", AUXILIARY_PACK]),
        output,
      ),
    );
    assertEquals(auxiliaryPreview.data.plan.class, "safe");
    await ok(
      human.runCli(["--json", "pack", "apply", AUXILIARY_PACK, "--safe"]),
      output,
    );
    for (
      const command of [
        ["metadata", "pack", PROJECTS],
        ["metadata", "resource", `${PROJECTS}:project_member`],
        ["metadata", "resource", `${PROJECTS}:timesheet`],
        ["metadata", "action", `${PROJECTS}:complete_task`],
        ["metadata", "hook", `${PROJECTS}:notify_project_change`],
        ["metadata", "policy", `${PROJECTS}:project_access`],
        ["metadata", "lifecycle", `${PROJECTS}:task_flow`],
      ]
    ) {
      const structured = json(
        await ok(
          human.runCli(["--json", "--project", projectId, ...command]),
          output,
        ),
      );
      const plain = toon(
        await ok(
          human.runCli(["--project", projectId, ...command]),
          output,
        ),
      );
      assertParity(plain.data, structured.data);
      assertEquals(structured.data.axi_readiness?.ready ?? true, true);
    }

    const secretV1 = `projects-secret-v1-${crypto.randomUUID()}`;
    const secretV2 = `projects-secret-v2-${crypto.randomUUID()}`;
    const replacementSecret =
      `projects-secret-replacement-${crypto.randomUUID()}`;
    const createdSecret = json(
      await ok(
        human.runCli([
          "--json",
          "secret",
          "create",
          "projects_provider",
          "--stdin",
        ], { stdin: `${secretV1}\n` }),
        output,
      ),
    );
    assertEquals(JSON.stringify(createdSecret).includes(secretV1), false);
    await ok(
      human.runCli([
        "--json",
        "secret",
        "rotate",
        "projects_provider",
        "--stdin",
      ], { stdin: `${secretV2}\n` }),
      output,
    );
    await ok(
      human.runCli([
        "--json",
        "secret",
        "create",
        "projects_provider_replacement",
        "--stdin",
      ], { stdin: `${replacementSecret}\n` }),
      output,
    );
    const grant = json(
      await ok(
        human.runCli([
          "--json",
          "secret",
          "grant",
          "projects_provider",
          "--hook",
          "operant/projects:deliver",
          "--slot",
          "projects_provider_token",
        ]),
        output,
      ),
    );
    const grantId = String(grant.data.grant_id ?? grant.data.id);
    assert(isUuidV7(grantId));
    const replacementGrant = json(
      await ok(
        human.runCli([
          "--json",
          "secret",
          "replace-grant",
          grantId,
          "--secret",
          "projects_provider_replacement",
        ]),
        output,
      ),
    );
    const replacementGrantId = String(
      replacementGrant.data.grant_id ?? replacementGrant.data.id,
    );
    assert(isUuidV7(replacementGrantId));
    const listedGrants = json(
      await ok(
        human.runCli([
          "--json",
          "secret",
          "grants",
        ]),
        output,
      ),
    );
    assert(JSON.stringify(listedGrants.data).includes(replacementGrantId));

    const seed1 = json(
      await ok(
        human.runCli([
          "--json",
          "--project",
          projectId,
          "seed",
          "commit",
          PROJECTS,
          "--all",
        ]),
        output,
      ),
    );
    assert(isUuidV7(String(seed1.data.id)));
    const beforeRepeatedSeed = await harness.observePersistenceCounts();
    const seed2 = json(
      await ok(
        human.runCli([
          "--json",
          "--project",
          projectId,
          "seed",
          "commit",
          PROJECTS,
          "--all",
        ]),
        output,
      ),
    );
    assertEquals(seed2.data.stage, null);
    assertEquals(await harness.observePersistenceCounts(), beforeRepeatedSeed);

    await ok(
      human.runCli([
        "--json",
        "assignment",
        "role",
        "create",
        humanId,
        "--role",
        `${PROJECTS}:project_manager`,
        "--project",
        projectId,
      ]),
      output,
    );
    const roles = json(
      await ok(
        requester.runCli([
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
    assertEquals(
      roles.data.roles.includes(`${PROJECTS}:project_manager`),
      true,
    );
    const request = json(
      await ok(
        requester.runCli([
          "--json",
          "auth",
          "request",
          "--role",
          `${PROJECTS}:project_manager`,
          "--boundary",
          "project",
          "--project",
          projectId,
          "--reason",
          "Run independent Projects acceptance",
        ]),
        output,
      ),
    );
    const waiting = agent.runCli([
      "--json",
      "auth",
      "wait",
      String(request.data.id),
    ]);
    await ok(
      human.runCli([
        "--json",
        "auth",
        "approve",
        String(request.data.id),
        "--yes",
        "--agent-name",
        "projects-agent",
      ]),
      output,
    );
    const redeemed = json(await ok(waiting, output));
    const redeemedAgentUserId = String(
      redeemed.data.authorization.agent_user_id ?? redeemed.data.agent?.id,
    );
    const whoami = json(
      await ok(agent.runCli(["--json", "auth", "whoami"]), output),
    );
    const directWhoamiResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/me`,
      { headers: { authorization: `Bearer ${redeemed.data.token}` } },
    );
    const directWhoami = await directWhoamiResponse.json();
    assertEquals(directWhoamiResponse.status, 200);
    const { auth_context_id: directContext, ...directIdentity } =
      directWhoami.data;
    const { auth_context_id: cliContext, ...cliIdentity } = whoami.data;
    assert(isUuidV7(String(directContext)));
    assert(isUuidV7(String(cliContext)));
    assertEquals(cliIdentity, directIdentity);
    assertEquals(
      /token|password|binding|anchor_pid/i.test(JSON.stringify(whoami.data)),
      false,
    );
    const toonWhoami = await ok(agent.runCli(["auth", "whoami"]), output);
    assertEquals(
      /token|password|binding|anchor_pid/i.test(toonWhoami.stdout),
      false,
    );

    const anchoringHumanPrincipalId = String(
      whoami.data.human_user?.principal_id,
    );
    const nestedAgentId = String(whoami.data.agent?.id);
    const principalId = String(whoami.data.principal?.id);
    assert(isUuidV7(principalId));
    assertEquals(whoami.data.principal?.type, "agent_user");
    assertEquals(String(whoami.data.human_user?.id), humanId);
    assertEquals(whoami.data.agent?.principal_id, principalId);
    assertEquals("id" in whoami.data, false);
    assertEquals("principal_id" in whoami.data, false);
    assertEquals("principal_type" in whoami.data, false);
    assertEquals(redeemedAgentUserId, nestedAgentId);
    assert(principalId !== humanId);
    assert(principalId !== anchoringHumanPrincipalId);
    assert(principalId !== nestedAgentId);
    assert(humanId !== nestedAgentId);
    assertEquals(whoami.data.role_assignments, [{
      role: `${PROJECTS}:project_manager`,
      boundary: { type: "project", project_id: projectId },
    }]);

    const todoId = await harness.observeProjectsTodoStageId(projectId);
    assert(isUuidV7(todoId));
    const setup = json(
      await ok(
        runJson(harness, ["--json", "changeset", "stage"], {
          project_id: projectId,
          operations: [{
            op: "create",
            key: "project",
            project_id: projectId,
            resource: `${PROJECTS}:project`,
            fields: {
              name: "Independent Build",
              status: "active",
              owner_id: principalId,
              visibility: "members",
              start_date: "2026-07-24",
            },
          }, {
            op: "create",
            key: "member",
            project_id: projectId,
            resource: `${PROJECTS}:project_member`,
            fields: {
              work_project_id: { $ref: "project.object_id" },
              principal_id: principalId,
            },
          }, {
            op: "create",
            key: "task",
            project_id: projectId,
            resource: `${PROJECTS}:task`,
            fields: {
              title: "Ship Projects",
              work_project_id: { $ref: "project.object_id" },
              stage_id: todoId,
              state: "todo",
              assignee_id: principalId,
              priority: "high",
              estimated_hours: "4.5",
            },
          }],
        }, agent),
        output,
      ),
    ).data;
    await ok(
      agent.runCli(["--json", "changeset", "commit", setup.id]),
      output,
    );
    const taskId = String(
      setup.operations.find((v: any) => v.key === "task").object_id,
    );
    assert(isUuidV7(taskId));
    const workProjectId = String(
      setup.operations.find((v: any) => v.key === "project").object_id,
    );
    const operationSetup = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              key: "transition_task",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              fields: {
                title: "Transition proof",
                work_project_id: workProjectId,
                stage_id: todoId,
                state: "todo",
                assignee_id: principalId,
              },
            }, {
              op: "create",
              key: "archive_task",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              fields: {
                title: "Archive proof",
                work_project_id: workProjectId,
                stage_id: todoId,
                state: "todo",
                assignee_id: principalId,
              },
            }, {
              op: "create",
              key: "old_tag",
              project_id: projectId,
              resource: `${PROJECTS}:task_tag`,
              fields: { name: `old-${crypto.randomUUID()}`, color: "gray" },
            }, {
              op: "create",
              key: "new_tag",
              project_id: projectId,
              resource: `${PROJECTS}:task_tag`,
              fields: { name: `new-${crypto.randomUUID()}`, color: "green" },
            }, {
              op: "link",
              key: "old_link",
              project_id: projectId,
              relationship: `${PROJECTS}:task_tag_assignment`,
              from: taskId,
              to: { $ref: "old_tag.object_id" },
              fields: { source: "setup" },
            }],
          },
          agent,
        ),
        output,
      ),
    ).data;
    await ok(
      agent.runCli([
        "--json",
        "changeset",
        "commit",
        operationSetup.id,
      ]),
      output,
    );
    const operation = (key: string) =>
      operationSetup.operations.find((value: any) => value.key === key);
    const allSeven = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "create",
              key: "milestone",
              project_id: projectId,
              resource: `${PROJECTS}:project_milestone`,
              fields: {
                name: "Complete public flow",
                work_project_id: workProjectId,
                status: "planned",
              },
            }, {
              op: "update",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              object_id: taskId,
              expected_version: 1,
              set: { description: "Updated through all seven operations" },
            }, {
              op: "transition",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              object_id: operation("transition_task").object_id,
              expected_version: 1,
              to: "in_progress",
            }, {
              op: "archive",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              object_id: operation("archive_task").object_id,
              expected_version: 1,
            }, {
              op: "link",
              key: "new_link",
              project_id: projectId,
              relationship: `${PROJECTS}:task_tag_assignment`,
              from: taskId,
              to: operation("new_tag").object_id,
              fields: { source: "matrix" },
            }, {
              op: "unlink",
              project_id: projectId,
              relationship: `${PROJECTS}:task_tag_assignment`,
              relationship_id: operation("old_link").relationship_id,
              expected_version: 1,
            }, {
              op: "comment",
              project_id: projectId,
              resource: `${PROJECTS}:task`,
              object_id: taskId,
              body: "Projects complete public-flow comment",
            }],
          },
          agent,
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
    assertEquals(
      data(
        await ok(
          agent.runCli([
            "--json",
            "changeset",
            "inspect",
            allSeven.id,
          ]),
          output,
        ),
      ),
      allSeven,
    );
    await ok(
      agent.runCli([
        "--json",
        "changeset",
        "commit",
        allSeven.id,
      ]),
      output,
    );

    const readers: Array<
      { principalId: string; launcher: PublicFlowLauncher }
    > = [];
    for (const username of ["projects-reader", "projects-unrelated"]) {
      const password = `${username}-${crypto.randomUUID()}`;
      const createdReader = data(
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
      await ok(
        human.runCli([
          "--json",
          "assignment",
          "role",
          "create",
          String(createdReader.id),
          "--role",
          "operant/projects:linked_reader",
          "--project",
          projectId,
        ]),
        output,
      );
      const login = await harness.loginProcess(username, password);
      launchers.push(login.launcher);
      await ok(Promise.resolve(login.result), output);
      readers.push({
        principalId: String(createdReader.principal_id),
        launcher: login.launcher,
      });
    }
    const readerLink = data(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            project_id: projectId,
            operations: [{
              op: "link",
              project_id: projectId,
              relationship: "operant/projects:task_viewer",
              from: taskId,
              to: readers[0].principalId,
            }],
          },
          human,
        ),
        output,
      ),
    );
    await ok(
      human.runCli([
        "--json",
        "changeset",
        "commit",
        readerLink.id,
      ]),
      output,
    );
    assertEquals(
      (await harness.observeRelationshipTuple({
        pack: "projects_auxiliary",
        relationship: "task_viewer",
        projectId,
        fromObjectId: taskId,
      }))?.toObjectId,
      readers[0].principalId,
    );
    const intendedRead = await readers[0].launcher.runCli([
      "--json",
      "--project",
      projectId,
      "view",
      `${PROJECTS}:task`,
      taskId,
    ]);
    output.push(intendedRead.stdout, intendedRead.stderr);
    assertEquals(intendedRead.code, 0, intendedRead.stderr);
    const unrelatedRead = await readers[1].launcher.runCli([
      "--json",
      "--project",
      projectId,
      "view",
      `${PROJECTS}:task`,
      taskId,
    ]);
    output.push(unrelatedRead.stdout, unrelatedRead.stderr);
    assertEquals(unrelatedRead.code, 1);

    assertEquals(await harness.observeProjectsTaskCount(projectId, "todo"), 1);
    const viewed = json(
      await ok(
        agent.runCli([
          "--json",
          "--project",
          projectId,
          "view",
          `${PROJECTS}:task`,
          taskId,
        ]),
        output,
      ),
    );
    assertEquals(viewed.data.data.title, "Ship Projects");
    const history = json(
      await ok(
        agent.runCli([
          "--json",
          "--project",
          projectId,
          "history",
          `${PROJECTS}:task`,
          taskId,
        ]),
        output,
      ),
    );
    assertExists(history.data);

    const started = json(
      await ok(
        agent.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${PROJECTS}:start_task`,
          "--input",
          JSON.stringify({ task_id: taskId, stage_id: todoId }),
        ]),
        output,
      ),
    ).data;
    assertEquals(started.source.kind, "action");
    await ok(
      agent.runCli(["--json", "changeset", "commit", started.id]),
      output,
    );

    const invalid = await agent.runCli([
      "--json",
      "--project",
      projectId,
      "action",
      "stage",
      `${PROJECTS}:complete_task`,
      "--input",
      JSON.stringify({
        task_id: taskId,
        stage_id: todoId,
        spent_hours: "25",
        entry_date: "2026-07-24",
      }),
    ]);
    output.push(invalid.stdout, invalid.stderr);
    assertEquals(invalid.code, 1);

    const completed = json(
      await ok(
        agent.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${PROJECTS}:complete_task`,
          "--input",
          JSON.stringify({
            task_id: taskId,
            stage_id: todoId,
            spent_hours: "4.5",
            entry_date: "2026-07-24",
          }),
        ]),
        output,
      ),
    ).data;
    assertEquals(completed.status, "awaiting_approval");
    const requirement = completed.approval_requirements[0];
    const selfApproval = await agent.runCli([
      "--json",
      "changeset",
      "approve",
      completed.id,
      requirement.id,
      "--reason",
      "initiator approval must be denied",
    ]);
    output.push(selfApproval.stdout, selfApproval.stderr);
    assertEquals(selfApproval.code, 1);
    await ok(
      human.runCli([
        "--json",
        "changeset",
        "approve",
        completed.id,
        requirement.id,
        "--reason",
        "Independent manager approval",
      ]),
      output,
    );
    await ok(
      agent.runCli(["--json", "changeset", "commit", completed.id]),
      output,
    );
    const rejectedCompletion = data(
      await ok(
        agent.runCli([
          "--json",
          "--project",
          projectId,
          "action",
          "stage",
          `${PROJECTS}:complete_task`,
          "--input",
          JSON.stringify({
            task_id: operation("transition_task").object_id,
            stage_id: todoId,
            spent_hours: "2",
            entry_date: "2026-07-25",
          }),
        ]),
        output,
      ),
    );
    assertEquals(rejectedCompletion.status, "awaiting_approval");
    const rejectionRequirement = rejectedCompletion.approval_requirements[0];
    const rejected = data(
      await ok(
        human.runCli([
          "--json",
          "changeset",
          "reject",
          rejectedCompletion.id,
          rejectionRequirement.id,
          "--reason",
          "independent rejection proof",
        ]),
        output,
      ),
    );
    assertEquals(rejected.status, "rejected");
    const rejectedCommit = await agent.runCli([
      "--json",
      "changeset",
      "commit",
      rejectedCompletion.id,
    ]);
    output.push(rejectedCommit.stdout, rejectedCommit.stderr);
    assertEquals(rejectedCommit.code, 1);

    const timesheets = await harness.observeProjectsTimesheets(
      projectId,
      principalId,
    );
    assertEquals(timesheets.length, 1);
    assertEquals(timesheets[0].principalId, principalId);
    assertEquals(timesheets[0].hours, "4.5");
    assertEquals(
      timesheets.some((item) =>
        item.principalId === humanId || item.principalId === nestedAgentId
      ),
      false,
    );

    const badProject = await agent.runCli([
      "--json",
      "--project",
      crypto.randomUUID(),
      "query",
      `${PROJECTS}:task`,
    ]);
    output.push(badProject.stdout, badProject.stderr);
    assertEquals(badProject.code, 1);
    const injection = await agent.runCli([
      "--json",
      "--project",
      projectId,
      "query",
      `${PROJECTS}:task`,
      "--where",
      'title == "x"; drop table objects',
    ]);
    output.push(injection.stdout, injection.stderr);
    assertEquals(injection.code, 1);

    await harness.waitForProviderBarrier("projects-retry-success");
    const attemptsAtRetrySuccess = await harness.providerAttempts();
    const attemptsByKey = Map.groupBy(
      attemptsAtRetrySuccess.filter((attempt) => attempt.idempotencyKey),
      (attempt) => String(attempt.idempotencyKey),
    );
    const scriptedRetry = [...attemptsByKey.entries()].find(([, attempts]) =>
      attempts.length >= 2
    );
    assert(scriptedRetry, JSON.stringify(attemptsAtRetrySuccess));
    const [scriptedRetryKey, scriptedRetryAttempts] = scriptedRetry;
    assert(scriptedRetryKey.length > 0);
    assert(scriptedRetryAttempts.length >= 2);
    assert(
      scriptedRetryAttempts.every((attempt) =>
        attempt.idempotencyKey === scriptedRetryKey
      ),
    );
    assertEquals(
      (await harness.providerEffects()).filter((attempt) =>
        attempt.idempotencyKey === scriptedRetryKey
      ).length,
      1,
    );
    await harness.releaseProviderBarrier("projects-retry-success");

    let scriptedDelivery: any;
    let deliveries: any[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = data(
        await ok(
          human.runCli([
            "--json",
            "outbox",
            "list",
            "--hook",
            "operant/projects:deliver",
            "--limit",
            "100",
          ]),
          output,
        ),
      );
      deliveries = listed.items ?? listed.deliveries;
      scriptedDelivery = deliveries.find((item: any) =>
        item.id === scriptedRetryKey && item.status === "succeeded"
      );
      if (
        scriptedDelivery &&
        deliveries.some((item: any) => item.status === "retry_wait")
      ) break;
      await delay(25);
    }
    assert(scriptedDelivery, JSON.stringify(deliveries));
    const scriptedPublicAttempts = data(
      await ok(
        human.runCli([
          "--json",
          "outbox",
          "attempts",
          scriptedRetryKey,
        ]),
        output,
      ),
    );
    assert(
      (scriptedPublicAttempts.items ?? scriptedPublicAttempts.attempts)
        .length >=
        2,
    );
    const cancellable = deliveries.find((item: any) =>
      item.status === "retry_wait"
    );
    assert(cancellable, JSON.stringify(deliveries));
    const inspectedDelivery = data(
      await ok(
        human.runCli([
          "--json",
          "outbox",
          "inspect",
          cancellable.id,
        ]),
        output,
      ),
    );
    assertEquals(inspectedDelivery.status, "retry_wait");
    await ok(
      human.runCli([
        "--json",
        "outbox",
        "cancel",
        cancellable.id,
        "--reason",
        "Projects public-flow cancellation",
      ]),
      output,
    );
    const invalidRetry = await human.runCli([
      "--json",
      "outbox",
      "retry",
      cancellable.id,
      "--reason",
      "cancelled deliveries cannot retry",
    ]);
    output.push(invalidRetry.stdout, invalidRetry.stderr);
    assertEquals(invalidRetry.code, 1);
    await ok(
      human.runCli(["--json", "outbox", "drain", "--limit", "25"]),
      output,
    );
    const deliveryAttempts = data(
      await ok(
        human.runCli([
          "--json",
          "outbox",
          "attempts",
          cancellable.id,
        ]),
        output,
      ),
    );
    assert((deliveryAttempts.items ?? deliveryAttempts.attempts).length >= 1);
    const providerAttempts = await harness.providerAttempts();
    const providerEffects = await harness.providerEffects();
    assert(providerAttempts.length >= 2);
    assert(providerAttempts.every((attempt) => attempt.idempotencyKey));
    assertEquals(
      providerEffects.filter((attempt) =>
        attempt.idempotencyKey === scriptedRetryKey
      ).length,
      1,
    );
    assertEquals(
      new Set(providerEffects.map((attempt) => attempt.idempotencyKey)).size,
      providerEffects.length,
    );

    await ok(
      human.runCli([
        "--json",
        "secret",
        "revoke-grant",
        replacementGrantId,
      ]),
      output,
    );
    await ok(
      human.runCli([
        "--json",
        "secret",
        "disable",
        "projects_provider",
      ]),
      output,
    );
    await ok(
      human.runCli([
        "--json",
        "secret",
        "disable",
        "projects_provider_replacement",
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
    const secretDiagnostics = await harness.diagnostics();
    const secretTranscript = [...output, secretDiagnostics.serverLogs].join(
      "\n",
    );
    for (const plaintext of [secretV1, secretV2, replacementSecret]) {
      assertEquals(secretTranscript.includes(plaintext), false);
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
    const revokedDirect = await fetch(
      `${harness.serverOrigin}/api/v1/auth/me`,
      {
        headers: { authorization: `Bearer ${redeemed.data.token}` },
      },
    );
    assertEquals(revokedDirect.status, 401);
    assertEquals(
      (await revokedDirect.text()).includes(String(redeemed.data.token)),
      false,
    );
    for (
      const args of [["--json", "auth", "whoami"], [
        "--json",
        "--project",
        projectId,
        "query",
        `${PROJECTS}:task`,
      ], [
        "--json",
        "--project",
        projectId,
        "action",
        "stage",
        `${PROJECTS}:block_task`,
        "--input",
        JSON.stringify({
          task_id: taskId,
          stage_id: todoId,
          reason: "revoked",
        }),
      ]]
    ) {
      const revoked = await agent.runCli(args);
      output.push(revoked.stdout, revoked.stderr);
      assertEquals(revoked.code, 1);
      assertEquals(revoked.stdout.includes(String(redeemed.data.token)), false);
      assertEquals(revoked.stderr.includes(String(redeemed.data.token)), false);
    }
    const diagnostics = await harness.diagnostics();
    assert(diagnostics.serverLogs.length > 0);
    assert(diagnostics.runtimeResources.length > 0);
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
      "Projects flow, diagnostics, or launcher cleanup failed",
    );
  }
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
function data(result: PublicFlowCommandResult): any {
  return json(result).data;
}
function toon(result: PublicFlowCommandResult): any {
  const value = decodeToon(result.stdout) as any;
  assertEquals(value.ok, true);
  return value;
}
function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function assertParity(actual: any, expected: any) {
  const normalize = (value: any): any =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === "object"
      ? Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "generated_at").map((
          [key, child],
        ) => [key, normalize(child)]),
      )
      : value;
  assertEquals(normalize(actual), normalize(expected));
}
async function assertNoLeaks(
  harness: CompletePublicFlowBackend,
  output: string[],
) {
  const diagnostics = await harness.diagnostics();
  const text = [...output, diagnostics.serverLogs].join("\n");
  for (
    const forbidden of [
      "projects acceptance password",
      "authorization: Bearer",
      "postgres://",
      "OPERANT_SECRET_MASTER_KEY",
      "at file://",
    ]
  ) {
    assertEquals(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}
