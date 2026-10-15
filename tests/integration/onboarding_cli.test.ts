import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, resolve } from "@std/path";
import { startLiveHarness } from "../support/live_harness.ts";
import { opaqueToken } from "../../src/domain/auth/token.ts";

Deno.test("compiled onboarding CLI initializes seeds explicitly and links/unlinks through changesets", async () => {
  const bootstrapToken = opaqueToken();
  const harness = await startLiveHarness({
    bootstrapToken,
    isolateEnvironment: true,
  });
  const client = join(harness.rootDir, "onboarding-client");
  const environment = {
    PATH: Deno.env.get("PATH") ?? "",
    HOME: client,
    XDG_CONFIG_HOME: join(client, "config"),
    XDG_STATE_HOME: join(client, "state"),
    XDG_DATA_HOME: join(client, "data"),
    OPTD_AUTH_ANCHOR_PID: String(Deno.pid),
    OPTD_AUTH_TREE_STOP_PID: String(Deno.pid),
    OPTD_BOOTSTRAP_TOKEN: bootstrapToken,
    NO_COLOR: "1",
  };
  async function cli(args: string[], stdin?: string) {
    const child = new Deno.Command(harness.binaryPath, {
      args: ["--server", harness.baseUrl, ...args],
      env: environment,
      clearEnv: true,
      stdin: stdin === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (stdin !== undefined) {
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    }
    const result = await child.output();
    return {
      code: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: new TextDecoder().decode(result.stderr),
    };
  }
  async function json(args: string[], stdin?: string) {
    const result = await cli(["--json", ...args], stdin);
    assertEquals(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  }
  try {
    assert(new URL(harness.baseUrl).port !== "8789");
    environment.OPTD_AUTH_ANCHOR_PID = "invalid";
    const invalidAnchor = await cli([
      "--json",
      "bootstrap",
      "init",
      "--username",
      "onboarding-cli",
      "--password-stdin",
    ], "synthetic onboarding CLI password\n");
    assert(invalidAnchor.code !== 0);
    environment.OPTD_AUTH_ANCHOR_PID = String(Deno.pid);
    assertEquals(
      (await json(["status", "bootstrap"])).state,
      "bootstrap_required",
    );
    await json([
      "bootstrap",
      "init",
      "--username",
      "onboarding-cli",
      "--password-stdin",
    ], "synthetic onboarding CLI password\n");
    const identity = await json(["auth", "whoami"]);
    const workspace = await json([
      "workspace",
      "create",
      "onboarding-cli",
      "--display-name",
      "Onboarding",
    ]);
    const scope = ["--workspace", workspace.id];
    await json(["workspace", "select", workspace.slug]);
    await json([
      "pack",
      "apply",
      resolve("prototypes/project-management-pack"),
      "--safe",
    ]);
    const pack = await json(["metadata", "pack", "optd/projects"]);
    assertEquals(pack.seed_initialization.automatic, false);
    assertStringIncludes(
      pack.seed_initialization.commit_all,
      "seed commit optd/projects --all",
    );
    const before = await json(["query", "optd/projects:task_stage"]);
    assertEquals(before.items.length, 0);
    const seed = await json([
      "metadata",
      "seed",
      `optd/projects:${pack.seeds[0]}`,
    ]);
    assert(seed.rows.length > 0);
    await json([...scope, "seed", "commit", "optd/projects", "--all"]);
    await json([...scope, "seed", "commit", "optd/projects", "--all"]);
    const stages = await json([...scope, "query", "optd/projects:task_stage"]);
    const pageArgs = [
      "--json",
      "query",
      "optd/projects:task_tag",
      "--limit",
      "2",
      "--include-total",
    ];
    const first = await cli(pageArgs);
    assertEquals(first.code, 0, first.stderr);
    const firstPage = JSON.parse(first.stdout);
    assertEquals(firstPage.meta.has_more, true);
    assertEquals(firstPage.meta.total, 4);
    const second = await cli([
      ...pageArgs,
      "--cursor",
      firstPage.meta.next_cursor,
    ]);
    assertEquals(second.code, 0, second.stderr);
    const secondPage = JSON.parse(second.stdout);
    assertEquals(secondPage.meta.has_more, false);
    assertEquals(
      new Set(
        [...firstPage.data.items, ...secondPage.data.items].map((
          item: { id: string },
        ) => item.id),
      ).size,
      4,
    );
    const todo = stages.items.find((item: { name: string }) =>
      item.name === "To Do"
    ) ?? stages.items[0];
    assert(todo);
    const taskMeta = await json(["metadata", "resource", "optd/projects:task"]);
    assert(taskMeta.required_fields.includes("project_id"));
    assert(
      Object.keys(taskMeta).indexOf("required_fields") <
        Object.keys(taskMeta).indexOf("schema"),
    );
    const action = await json([
      "metadata",
      "action",
      "optd/projects:complete_task",
    ]);
    assert(action.required_fields.includes("task_id"));
    assert(
      action.lifecycles.some((item: { inspect: string }) =>
        item.inspect === "optctl metadata lifecycle optd/projects:task_flow"
      ),
    );
    const edgeMeta = await json([
      "metadata",
      "relationship",
      "optd/projects:task_tag_assignment",
    ]);
    assertStringIncludes(
      edgeMeta.commands.unlink,
      "<relationship-instance-id>",
    );
    const created = async (
      resource: string,
      fields: Record<string, unknown>,
    ) => {
      const result = await json([
        ...scope,
        "create",
        resource,
        "--input",
        JSON.stringify(fields),
      ]);
      const id = Object.values(result.created)[0];
      assert(typeof id === "string");
      return id;
    };
    const project = await created("optd/projects:project", {
      name: "Onboarding project",
      status: "active",
      owner_id: identity.human_user.principal_id,
      visibility: "internal",
    });
    const task = await created("optd/projects:task", {
      title: "Onboarding task",
      project_id: project,
      stage_id: todo.id,
      state: "todo",
    });
    const tag = await created("optd/projects:task_tag", {
      name: "Onboarding tag",
    });
    const linked = await json([
      ...scope,
      "link",
      "optd/projects:task_tag_assignment",
      "--from",
      task,
      "--to",
      tag,
    ]);
    const edge = Object.values(linked.created)[0];
    assert(typeof edge === "string");
    const viewed = await json([
      ...scope,
      "view",
      "relationship",
      "optd/projects:task_tag_assignment",
      edge,
    ]);
    assert(viewed);
    const stale = await cli([
      "--json",
      ...scope,
      "unlink",
      "optd/projects:task_tag_assignment",
      edge,
      "--expected-version",
      "999",
    ]);
    assert(stale.code !== 0);
    await json([
      ...scope,
      "view",
      "relationship",
      "optd/projects:task_tag_assignment",
      edge,
    ]);
    await json([
      ...scope,
      "unlink",
      "optd/projects:task_tag_assignment",
      edge,
      "--expected-version",
      "1",
    ]);
    const edges = await json([
      ...scope,
      "query",
      "relationship",
      "optd/projects:task_tag_assignment",
    ]);
    assertEquals(edges.items.length, 0);
  } finally {
    await harness.close();
  }
});
