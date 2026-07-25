// deno-lint-ignore-file no-explicit-any no-import-prefix no-unversioned-import
import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "jsr:@std/assert";
import { decode as decodeToon } from "npm:@toon-format/toon";
import { join } from "jsr:@std/path";
import { isUuidV7 } from "../../../src/domain/ids/uuid_v7.ts";
import {
  type CliLauncher,
  type CliResult,
  type LiveHarness,
  startLiveHarness,
} from "../../support/live_harness.ts";

const PROJECTS = "operant/projects";
const PACK = join(Deno.cwd(), "prototypes", "project-management-pack");
const logLevels = Deno.env.get("OPERANT_LOG_LEVEL") === "trace"
  ? ["trace"] as const
  : ["info"] as const;

for (const logLevel of logLevels) {
  Deno.test({
    name:
      `forced-current compiled CLI completes the independent Projects public flow (${logLevel})`,
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
        const human = await launcher(harness, launchers, "human");
        const requester = await launcher(harness, launchers, "request_only");
        const agent = await launcher(harness, launchers, "agent");
        const bootstrap = json(
          await ok(
            human.runOptctl([
              "--json",
              "bootstrap",
              "init",
              "--username",
              "projects-admin",
              "--display-name",
              "Projects Administrator",
              "--password-stdin",
            ], "projects acceptance password\n"),
            output,
          ),
        );
        const humanId = String(
          bootstrap.data.user?.id ?? bootstrap.data.human_user_id ??
            bootstrap.data.id,
        );
        assert(isUuidV7(humanId));

        assertParity(
          toon(await ok(human.runOptctl([]), output)).data,
          json(await ok(human.runOptctl(["--json"]), output)).data,
        );
        const hostProject = json(
          await ok(
            human.runOptctl([
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
        await ok(human.runOptctl(["project", "select", "delivery"]), output);

        const preview = json(
          await ok(
            human.runOptctl(["--json", "pack", "preview", PACK]),
            output,
          ),
        );
        assertEquals(preview.data.plan.class, "safe");
        await ok(
          human.runOptctl(["--json", "pack", "apply", PACK, "--safe"]),
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
              human.runOptctl(["--json", "--project", projectId, ...command]),
              output,
            ),
          );
          const plain = toon(
            await ok(
              human.runOptctl(["--project", projectId, ...command]),
              output,
            ),
          );
          assertParity(plain.data, structured.data);
          assertEquals(structured.data.axi_readiness?.ready ?? true, true);
        }

        const seed1 = json(
          await ok(
            human.runOptctl([
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
        const seed2 = json(
          await ok(
            human.runOptctl([
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

        await ok(
          human.runOptctl([
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
            requester.runOptctl([
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
            requester.runOptctl([
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
        const waiting = agent.runOptctl([
          "--json",
          "auth",
          "wait",
          String(request.data.id),
        ]);
        await delay(50);
        await ok(
          human.runOptctl([
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
          await ok(agent.runOptctl(["--json", "auth", "whoami"]), output),
        );
        const anchoringHumanPrincipalId = String(whoami.data.principal_id);
        const nestedAgentId = String(whoami.data.agent?.id);
        const principalId = String(whoami.data.agent?.principal_id);
        assert(isUuidV7(principalId));
        assertEquals(String(whoami.data.id), humanId);
        assertEquals(redeemedAgentUserId, nestedAgentId);
        assert(principalId !== humanId);
        assert(principalId !== anchoringHumanPrincipalId);
        assert(principalId !== nestedAgentId);
        assert(humanId !== nestedAgentId);
        assertEquals(whoami.data.role_assignments, [{
          role: `${PROJECTS}:project_manager`,
          boundary: { type: "project", project_id: projectId },
        }]);

        const stages = json(
          await ok(
            agent.runOptctl([
              "--json",
              "--project",
              projectId,
              "query",
              `${PROJECTS}:task_stage`,
              "--limit",
              "10",
            ]),
            output,
          ),
        );
        const todoId = String(
          stages.data.items.find((v: any) => v.data.name === "todo")?.id,
        );
        assert(isUuidV7(todoId), JSON.stringify(stages.data));
        const setup = json(
          await ok(
            harness.runJson(["--json", "changeset", "stage"], {
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
          agent.runOptctl(["--json", "changeset", "commit", setup.id]),
          output,
        );
        const taskId = String(
          setup.operations.find((v: any) => v.key === "task").object_id,
        );
        assert(isUuidV7(taskId));

        const queried = json(
          await ok(
            agent.runOptctl([
              "--json",
              "--project",
              projectId,
              "query",
              `${PROJECTS}:task`,
              "--where",
              'state == "todo"',
            ]),
            output,
          ),
        );
        assertEquals(queried.data.items.length, 1);
        const viewed = json(
          await ok(
            agent.runOptctl([
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
            agent.runOptctl([
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
            agent.runOptctl([
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
          agent.runOptctl(["--json", "changeset", "commit", started.id]),
          output,
        );

        const invalid = await agent.runOptctl([
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
            agent.runOptctl([
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
        await ok(
          human.runOptctl([
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
          agent.runOptctl(["--json", "changeset", "commit", completed.id]),
          output,
        );
        const timesheets = json(
          await ok(
            agent.runOptctl([
              "--json",
              "--project",
              projectId,
              "query",
              `${PROJECTS}:timesheet`,
              "--where",
              `principal_id == \"${principalId}\"`,
            ]),
            output,
          ),
        );
        assertEquals(timesheets.data.items.length, 1);
        assertEquals(timesheets.data.items[0].data.principal_id, principalId);
        assertEquals(timesheets.data.items[0].data.hours, "4.5");
        assertEquals(
          timesheets.data.items.some((item: any) =>
            item.data.principal_id === humanId ||
            item.data.principal_id === nestedAgentId
          ),
          false,
        );

        const badProject = await agent.runOptctl([
          "--json",
          "--project",
          crypto.randomUUID(),
          "query",
          `${PROJECTS}:task`,
        ]);
        output.push(badProject.stdout, badProject.stderr);
        assertEquals(badProject.code, 1);
        const injection = await agent.runOptctl([
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

        await ok(
          human.runOptctl([
            "--json",
            "auth",
            "revoke",
            String(redeemed.data.authorization.id),
          ]),
          output,
        );
        const revoked = await agent.runOptctl(["--json", "auth", "whoami"]);
        output.push(revoked.stdout, revoked.stderr);
        assertEquals(revoked.code, 1);
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

Deno.test("Projects pack source has no legacy relationships, dotted aliases, or leak literals", async () => {
  const source = await Array.fromAsync(walkSources(PACK));
  const text = source.join("\n");
  assertEquals(
    /timesheet_entry|operant\.projects|project_task/.test(text),
    false,
  );
  assertEquals(
    /Bearer |authorization:|OPERANT_DATABASE_URL|postgres:\/\//i.test(text),
    false,
  );
});

async function* walkSources(root: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(root)) {
    const path = join(root, entry.name);
    if (entry.isDirectory) yield* walkSources(path);
    else if (/\.(?:yaml|ts)$/.test(entry.name)) {
      yield await Deno.readTextFile(path);
    }
  }
}
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
async function assertNoLeaks(harness: LiveHarness, output: string[]) {
  const diagnostics = await harness.diagnostics();
  const text = [...output, diagnostics.server, diagnostics.hooks].join("\n");
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
