// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertExists,
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
import { isUuidV7, runJson } from "./helpers.ts";

const PROJECTS = "optd/projects";
const SYNCHRONOUS_HOOK_BUDGET_MS = 2_000;

export async function runCompleteProjectsPublicFlow(
  harness: CompletePublicFlowBackend,
): Promise<void> {
  const launchers: PublicFlowLauncher[] = [];
  const output: string[] = [];
  const failures: unknown[] = [];
  try {
    await harness.compileCurrentCli();
    await harness.configureProvider([{
      kind: "retry_then_success",
      retryAfterSeconds: 1,
      successHoldToken: "workspaces-retry-success",
      body: { retry: true },
    }]);
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
          "workspaces-admin",
          "--display-name",
          "Projects Administrator",
          "--password-stdin",
        ], { stdin: "workspaces acceptance password\n" }),
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
        "workspaces-admin",
        "--password-stdin",
      ], { stdin: "workspaces acceptance password\n" }),
      output,
    );

    assertParity(
      toon(await ok(human.runCli([]), output)).data,
      json(await ok(human.runCli(["--json"]), output)).data,
    );
    const hostWorkspace = json(
      await ok(
        human.runCli([
          "--json",
          "workspace",
          "create",
          "delivery",
          "--display-name",
          "Delivery",
        ]),
        output,
      ),
    );
    const workspaceId = String(hostWorkspace.data.id);
    assert(isUuidV7(workspaceId));
    await ok(human.runCli(["workspace", "select", "delivery"]), output);

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
          human.runCli(["--json", "--workspace", workspaceId, ...command]),
          output,
        ),
      );
      const plain = toon(
        await ok(
          human.runCli(["--workspace", workspaceId, ...command]),
          output,
        ),
      );
      assertParity(plain.data, structured.data);
      assertEquals(structured.data.axi_readiness?.ready ?? true, true);
    }

    const secretV1 = `workspaces-secret-v1-${crypto.randomUUID()}`;
    const secretV2 = `workspaces-secret-v2-${crypto.randomUUID()}`;
    const replacementSecret =
      `workspaces-secret-replacement-${crypto.randomUUID()}`;
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
          "optd/projects:deliver",
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
          "--workspace",
          workspaceId,
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
          "--workspace",
          workspaceId,
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

    await harness.waitForProviderBarrier("workspaces-retry-success");
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
    await harness.releaseProviderBarrier("workspaces-retry-success");
    const scriptedDelivery = await waitOutboxDeliveryStatus(
      human,
      output,
      "succeeded",
      scriptedRetryKey,
    );
    assertEquals(scriptedDelivery.id, scriptedRetryKey);
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
        .length >= 2,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-delivery:scripted-retry",
    );

    await ok(
      human.runCli([
        "--json",
        "assignment",
        "role",
        "create",
        humanId,
        "--role",
        `${PROJECTS}:project_manager`,
        "--workspace",
        workspaceId,
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
          "workspace",
          "--workspace",
          workspaceId,
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
        agent.runCli([
          "--json",
          "auth",
          "request",
          "--role",
          `${PROJECTS}:project_manager`,
          "--boundary",
          "workspace",
          "--workspace",
          workspaceId,
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
        "workspaces-agent",
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
    assertEquals("token" in redeemed.data, false);
    const agentToken = await harness.authorizationTokenForHttpProbe(
      String(redeemed.data.authorization.id),
    );
    const directWhoamiResponse = await fetch(
      `${harness.serverOrigin}/api/v1/auth/me`,
      { headers: { authorization: `Bearer ${agentToken}` } },
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
      boundary: { type: "workspace", workspace_id: workspaceId },
    }]);

    const todoId = await harness.observeProjectsTodoStageId(workspaceId);
    assert(isUuidV7(todoId));
    const workspaceSetup = json(
      await ok(
        runJson(harness, ["--json", "changeset", "stage"], {
          workspace_id: workspaceId,
          operations: [{
            op: "create",
            key: "workspace",
            workspace_id: workspaceId,
            resource: `${PROJECTS}:project`,
            fields: {
              name: "Independent Build",
              status: "active",
              owner_id: principalId,
              visibility: "members",
              start_date: "2026-07-24",
            },
          }],
        }, agent),
        output,
      ),
    ).data;
    assertEquals(workspaceSetup.operations.length, 1);
    assertEquals(workspaceSetup.hook_executions, []);
    await ok(
      agent.runCli(["--json", "changeset", "commit", workspaceSetup.id]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:workspace-setup",
    );
    const workWorkspaceId = String(workspaceSetup.operations[0].object_id);
    assert(isUuidV7(workWorkspaceId));

    const memberSetup = json(
      await ok(
        runJson(harness, ["--json", "changeset", "stage"], {
          workspace_id: workspaceId,
          operations: [{
            op: "create",
            key: "member",
            workspace_id: workspaceId,
            resource: `${PROJECTS}:project_member`,
            fields: {
              project_id: workWorkspaceId,
              principal_id: principalId,
            },
          }],
        }, agent),
        output,
      ),
    ).data;
    assertEquals(memberSetup.operations.length, 1);
    assertEquals(memberSetup.hook_executions, []);
    await ok(
      agent.runCli(["--json", "changeset", "commit", memberSetup.id]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:member-setup",
    );

    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-hook-stage:task-setup",
    );
    const setup = json(
      await ok(
        runJson(harness, ["--json", "changeset", "stage"], {
          workspace_id: workspaceId,
          operations: [{
            op: "create",
            key: "task",
            workspace_id: workspaceId,
            resource: `${PROJECTS}:task`,
            fields: {
              title: "Ship Projects",
              project_id: workWorkspaceId,
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
    assertEquals(setup.operations.length, 1);
    assertPersistedHookEvidence(setup, [{
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }]);
    await ok(
      agent.runCli(["--json", "changeset", "commit", setup.id]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:task-setup",
    );
    const taskId = String(setup.operations[0].object_id);
    assert(isUuidV7(taskId));
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-hook-stage:operation-setup",
    );
    const operationSetup = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            workspace_id: workspaceId,
            operations: [{
              op: "create",
              key: "transition_task",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task`,
              fields: {
                title: "Transition proof",
                project_id: workWorkspaceId,
                stage_id: todoId,
                state: "todo",
                assignee_id: principalId,
              },
            }, {
              op: "create",
              key: "archive_task",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task`,
              fields: {
                title: "Archive proof",
                project_id: workWorkspaceId,
                stage_id: todoId,
                state: "todo",
                assignee_id: principalId,
              },
            }, {
              op: "create",
              key: "old_tag",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task_tag`,
              fields: { name: `old-${crypto.randomUUID()}`, color: "gray" },
            }, {
              op: "create",
              key: "new_tag",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task_tag`,
              fields: { name: `new-${crypto.randomUUID()}`, color: "green" },
            }, {
              op: "link",
              key: "old_link",
              workspace_id: workspaceId,
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
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:operation-setup",
    );
    const operation = (key: string) =>
      operationSetup.operations.find((value: any) => value.key === key);
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-hook-stage:all-seven",
    );
    const allSeven = json(
      await ok(
        runJson(
          harness,
          ["--json", "changeset", "stage"],
          {
            workspace_id: workspaceId,
            operations: [{
              op: "create",
              key: "milestone",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:project_milestone`,
              fields: {
                name: "Complete public flow",
                project_id: workWorkspaceId,
                status: "planned",
              },
            }, {
              op: "update",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task`,
              object_id: taskId,
              expected_version: 1,
              set: { description: "Updated through all seven operations" },
            }, {
              op: "transition",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task`,
              object_id: operation("transition_task").object_id,
              expected_version: 1,
              to: "in_progress",
            }, {
              op: "archive",
              workspace_id: workspaceId,
              resource: `${PROJECTS}:task`,
              object_id: operation("archive_task").object_id,
              expected_version: 1,
            }, {
              op: "link",
              key: "new_link",
              workspace_id: workspaceId,
              relationship: `${PROJECTS}:task_tag_assignment`,
              from: taskId,
              to: operation("new_tag").object_id,
              fields: { source: "matrix" },
            }, {
              op: "unlink",
              workspace_id: workspaceId,
              relationship: `${PROJECTS}:task_tag_assignment`,
              relationship_id: operation("old_link").relationship_id,
              expected_version: 1,
            }, {
              op: "comment",
              workspace_id: workspaceId,
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
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:all-seven",
    );

    const readers: Array<
      { principalId: string; launcher: PublicFlowLauncher }
    > = [];
    for (const username of ["workspaces-reader", "workspaces-unrelated"]) {
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
          "optd/projects:linked_reader",
          "--workspace",
          workspaceId,
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
            workspace_id: workspaceId,
            operations: [{
              op: "link",
              workspace_id: workspaceId,
              relationship: "optd/projects:task_viewer",
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
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:reader-link",
    );
    assertEquals(
      (await harness.observeRelationshipTuple({
        pack: "projects_auxiliary",
        relationship: "task_viewer",
        workspaceId,
        fromObjectId: taskId,
      }))?.toObjectId,
      readers[0].principalId,
    );
    const intendedRead = await readers[0].launcher.runCli([
      "--json",
      "--workspace",
      workspaceId,
      "view",
      `${PROJECTS}:task`,
      taskId,
    ]);
    output.push(intendedRead.stdout, intendedRead.stderr);
    assertEquals(intendedRead.code, 0, intendedRead.stderr);
    const unrelatedRead = await readers[1].launcher.runCli([
      "--json",
      "--workspace",
      workspaceId,
      "view",
      `${PROJECTS}:task`,
      taskId,
    ]);
    output.push(unrelatedRead.stdout, unrelatedRead.stderr);
    assertEquals(unrelatedRead.code, 1);

    assertEquals(
      await harness.observeProjectsTaskCount(workspaceId, "todo"),
      1,
    );
    const viewed = json(
      await ok(
        agent.runCli([
          "--json",
          "--workspace",
          workspaceId,
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
          "--workspace",
          workspaceId,
          "history",
          `${PROJECTS}:task`,
          taskId,
        ]),
        output,
      ),
    );
    assertExists(history.data);

    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-action:start-task",
    );
    const started = json(
      await ok(
        agent.runCli([
          "--json",
          "--workspace",
          workspaceId,
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
    assertPersistedHookEvidence(started, [{
      phase: "action.stage",
      stderr: "start_task transitioning",
    }, {
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }]);
    await ok(
      agent.runCli(["--json", "changeset", "commit", started.id]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:start-task",
    );

    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-action:complete-task-invalid",
    );
    const invalid = await agent.runCli([
      "--json",
      "--workspace",
      workspaceId,
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

    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-action:complete-task-valid",
    );
    const completed = json(
      await ok(
        agent.runCli([
          "--json",
          "--workspace",
          workspaceId,
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
    assertEquals(completed.status, "ready");
    assertEquals(completed.approval_requirements, []);
    assertPersistedHookEvidence(completed, [{
      phase: "action.stage",
      stderr: "complete_task transitioning",
    }, {
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }, {
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }]);
    await ok(
      agent.runCli(["--json", "changeset", "commit", completed.id]),
      output,
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:post-commit:complete-task",
    );
    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-action:complete-second-task",
    );
    const secondCompletion = data(
      await ok(
        agent.runCli([
          "--json",
          "--workspace",
          workspaceId,
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
    assertEquals(secondCompletion.status, "ready");
    assertEquals(secondCompletion.approval_requirements, []);
    assertPersistedHookEvidence(secondCompletion, [{
      phase: "action.stage",
      stderr: "complete_task transitioning",
    }, {
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }, {
      phase: "changeset.validate",
      stderr: "validate_task errors=0 warnings=0",
    }]);
    await ok(
      agent.runCli(["--json", "changeset", "commit", secondCompletion.id]),
      output,
    );

    const timesheets = await harness.observeProjectsTimesheets(
      workspaceId,
      principalId,
    );
    assertEquals(timesheets.length, 2);
    assertEquals(
      timesheets.every((item) => item.principalId === principalId),
      true,
    );
    assertEquals(timesheets.map((item) => item.hours).sort(), ["2", "4.5"]);
    assertEquals(
      timesheets.some((item) =>
        item.principalId === humanId || item.principalId === nestedAgentId
      ),
      false,
    );

    const badWorkspace = await agent.runCli([
      "--json",
      "--workspace",
      crypto.randomUUID(),
      "query",
      `${PROJECTS}:task`,
    ]);
    output.push(badWorkspace.stdout, badWorkspace.stderr);
    assertEquals(badWorkspace.code, 1);
    const injection = await agent.runCli([
      "--json",
      "--workspace",
      workspaceId,
      "query",
      `${PROJECTS}:task`,
      "--where",
      'title == "x"; drop table objects',
    ]);
    output.push(injection.stdout, injection.stderr);
    assertEquals(injection.code, 1);

    await assertHookQuiescence(
      harness,
      output,
      "workspaces:pre-stage:retry-delivery",
    );
    await harness.enqueueProviderBehaviors([{
      kind: "retry",
      retryAfterSeconds: 600,
      body: { retry: true },
    }]);
    const retryStage = data(
      await ok(
        runJson(harness, ["--json", "changeset", "stage"], {
          workspace_id: workspaceId,
          operations: [{
            op: "create",
            workspace_id: workspaceId,
            resource: `${PROJECTS}:task_tag`,
            fields: {
              name: `quiescence-${crypto.randomUUID()}`,
              color: "blue",
            },
          }],
        }, agent),
        output,
      ),
    );
    await ok(
      agent.runCli(["--json", "changeset", "commit", retryStage.id]),
      output,
    );
    const cancellable = await waitOutboxDeliveryStatus(
      human,
      output,
      "retry_wait",
    );

    let quiescenceSettled = false;
    const blockedQuiescence = harness.awaitHookQuiescence().then((value) => {
      quiescenceSettled = true;
      return value;
    });
    await delay(200);
    assertEquals(
      quiescenceSettled,
      false,
      "retry_wait must prevent the hook barrier from returning",
    );
    assertEquals((await harness.observeHookQuiescence()).retryWait, 1);
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
    assertEquals(await blockedQuiescence, QUIESCENT_HOOK_EVIDENCE);
    assertEquals(
      await harness.observeHookQuiescence(),
      QUIESCENT_HOOK_EVIDENCE,
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
        headers: { authorization: `Bearer ${agentToken}` },
      },
    );
    assertEquals(revokedDirect.status, 401);
    assertEquals(
      (await revokedDirect.text()).includes(String(agentToken)),
      false,
    );
    for (
      const args of [["--json", "auth", "whoami"], [
        "--json",
        "--workspace",
        workspaceId,
        "query",
        `${PROJECTS}:task`,
      ], [
        "--json",
        "--workspace",
        workspaceId,
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
      if (args.includes("action")) {
        await assertHookQuiescence(
          harness,
          output,
          "workspaces:pre-action:revoked-block-task",
        );
      }
      const revoked = await agent.runCli(args);
      output.push(revoked.stdout, revoked.stderr);
      assertEquals(revoked.code, 1);
      assertEquals(revoked.stdout.includes(String(agentToken)), false);
      assertEquals(revoked.stderr.includes(String(agentToken)), false);
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

function assertPersistedHookEvidence(
  stage: any,
  expected: readonly Readonly<{ phase: string; stderr: string }>[],
): void {
  assertEquals(stage.hook_executions.length, expected.length);
  for (let index = 0; index < expected.length; index++) {
    const execution = stage.hook_executions[index];
    assertEquals(execution.phase, expected[index].phase);
    assert(Number.isSafeInteger(execution.duration_ms));
    assert(execution.duration_ms >= 0);
    assert(execution.duration_ms < SYNCHRONOUS_HOOK_BUDGET_MS);
    assertStringIncludes(execution.stderr, expected[index].stderr);
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
async function waitOutboxDeliveryStatus(
  launcher: PublicFlowLauncher,
  output: string[],
  status: string,
  deliveryId?: string,
): Promise<any> {
  let deliveries: any[] = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    const listed = data(
      await ok(
        launcher.runCli([
          "--json",
          "outbox",
          "list",
          "--hook",
          "optd/projects:deliver",
          "--limit",
          "100",
        ]),
        output,
      ),
    );
    deliveries = listed.items ?? listed.deliveries;
    const delivery = deliveries.find((item: any) =>
      item.status === status && (!deliveryId || item.id === deliveryId)
    );
    if (delivery) return delivery;
    await delay(25);
  }
  throw new Error(
    `delivery ${deliveryId ?? "<any>"} did not reach ${status}: ${
      JSON.stringify(deliveries)
    }`,
  );
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
      "workspaces acceptance password",
      "authorization: Bearer",
      "postgres://",
      "OPTD_SECRET_MASTER_KEY",
      "at file://",
    ]
  ) {
    assertEquals(text.includes(forbidden), false, `leaked ${forbidden}`);
  }
}
