import { assert, assertEquals } from "@std/assert";
import { startLiveHarness } from "../support/live_harness.ts";

Deno.test("Projects reviewed upgrade preserves data and fixes scoped reads, filters and transitions", async () => {
  const fixture = await Deno.makeTempDir({ prefix: "optd-projects-v020-" });
  const unpack = await new Deno.Command("tar", {
    args: [
      "-xzf",
      "tests/fixtures/projects-v0.2.0.tar.gz",
      "--strip-components=2",
      "-C",
      fixture,
    ],
  }).output();
  assertEquals(unpack.code, 0);
  const harness = await startLiveHarness({ isolateEnvironment: true });
  const password = "synthetic-papercuts-review-password";
  const invoke = async (args: string[], stdin?: string) => {
    const result = await harness.runOptctl(["--json", ...args], stdin);
    return {
      code: result.code,
      body: JSON.parse(result.code === 0 ? result.stdout : result.stderr),
    };
  };
  const ok = async (args: string[], stdin?: string) => {
    const result = await invoke(args, stdin);
    assertEquals(result.code, 0, JSON.stringify({ args, result }));
    return result.body.data;
  };
  const denied = async (args: string[], code: string) => {
    const result = await invoke(args);
    assert(result.code !== 0, JSON.stringify(args));
    assertEquals(result.body.error.code, code, JSON.stringify(result));
    return result.body.error;
  };
  const login = (username: string) =>
    ok(
      ["auth", "login", "--username", username, "--password-stdin"],
      password + "\n",
    );
  try {
    await ok(
      ["bootstrap", "init", "--username", "root", "--password-stdin"],
      password + "\n",
    );
    const identity = await ok(["auth", "whoami"]);
    const workspace = await ok([
      "workspace",
      "create",
      "papercuts",
      "--display-name",
      "Papercuts",
    ]);
    const other = await ok([
      "workspace",
      "create",
      "outside",
      "--display-name",
      "Outside",
    ]);
    const scope = ["--workspace", workspace.id];
    await ok(["pack", "apply", fixture, "--safe"]);
    const seed = await ok([
      ...scope,
      "seed",
      "commit",
      "optd/projects",
      "--all",
    ]);
    const create = async (name: string, fields: unknown) => {
      const result = await ok([
        ...scope,
        "create",
        "optd/projects:" + name,
        "--input",
        JSON.stringify(fields),
      ]);
      return result.created.op_000001 as string;
    };
    const project = await create("project", {
      name: "Preserved project",
      owner_id: identity.principal.id,
      status: "active",
      visibility: "internal",
    });
    const fields = {
      project_id: project,
      state: "todo",
      stage_id: seed.created.task_stages_0,
      blocked_reason: "",
    };
    const archivedTask = await create("task", {
      ...fields,
      title: "Archived task",
    });
    const task = await create("task", { ...fields, title: "Flight task" });
    const milestone = await create("project_milestone", {
      name: "Release",
      project_id: project,
      status: "planned",
    });
    const milestoneLink = await ok([
      ...scope,
      "link",
      "optd/projects:task_milestone",
      "--from",
      task,
      "--to",
      milestone,
    ]);
    const milestoneEdge = String(Object.values(milestoneLink.created)[0]);
    const tags = Object.entries(seed.created).filter(([key]) =>
      key.startsWith("task_tags_")
    ).map(([, id]) => String(id));
    const edges: string[] = [];
    for (const tag of tags.slice(0, 2)) {
      const linked = await ok([
        ...scope,
        "link",
        "optd/projects:task_tag_assignment",
        "--from",
        task,
        "--to",
        tag,
      ]);
      edges.push(String(Object.values(linked.created)[0]));
    }
    await ok([
      ...scope,
      "unlink",
      "optd/projects:task_tag_assignment",
      edges[1],
      "--expected-version",
      "1",
    ]);
    const stage = await ok([
      "changeset",
      "stage",
      "--input",
      JSON.stringify({
        operations: [{
          op: "archive",
          workspace_id: workspace.id,
          resource: "optd/projects:task",
          object_id: archivedTask,
          expected_version: 1,
        }],
      }),
    ]);
    await ok(["changeset", "commit", stage.id]);
    const before = await ok([
      ...scope,
      "view",
      "optd/projects:task",
      archivedTask,
    ]);
    const historyBefore = await ok([
      ...scope,
      "history",
      "optd/projects:task",
      archivedTask,
    ]);
    const assignments: Record<string, { id: string; version: number }> = {};
    const users: Record<string, string> = {};
    const roles = [
      "projects_admin",
      "project_manager",
      "project_member",
      "viewer",
    ];
    for (const role of roles) {
      const user = await ok([
        "auth",
        "user",
        "create",
        "--username",
        role,
        "--display-name",
        role,
        "--password-stdin",
      ], password + "\n");
      users[role] = user.id;
      assignments[role] = await ok([
        "assignment",
        "role",
        "create",
        user.id,
        ...scope,
        "--role",
        "optd/projects:" + role,
      ]);
    }
    await login("projects_admin");
    await denied([
      ...scope,
      "query",
      "relationship",
      "optd/projects:task_tag_assignment",
    ], "not_found");
    await denied(
      [...scope, "view", "optd/projects:task", archivedTask],
      "not_found",
    );
    await login("root");
    const candidate = "prototypes/project-management-pack";
    const preview = await ok(["pack", "preview", candidate]);
    assert(
      preview.plan.changes.some((change: { class: string }) =>
        change.class === "risky"
      ),
    );
    const unsafe = await invoke(["pack", "apply", candidate, "--safe"]);
    assert(unsafe.code !== 0, "policy/lifecycle upgrade must require review");
    await ok(["pack", "apply", candidate, "--reviewed"]);
    const after = await ok([
      ...scope,
      "view",
      "optd/projects:task",
      archivedTask,
    ]);
    for (
      const key of ["id", "version", "object_version_id", "archived_at", "data"]
    ) assertEquals(after[key], before[key]);
    assertEquals(
      await ok([...scope, "history", "optd/projects:task", archivedTask]),
      historyBefore,
    );
    assertEquals(
      (await ok([...scope, "query", "optd/projects:task_stage"])).items.length,
      4,
    );
    for (const role of roles) {
      await login(role);
      const authority = await ok(["auth", "authority", ...scope]);
      assertEquals(authority.super_admin, false);
      assertEquals(authority.effective_roles, ["optd/projects:" + role]);
      const relationships = await ok([
        ...scope,
        "query",
        "relationship",
        "optd/projects:task_tag_assignment",
        "--where",
        `from == "${task}"`,
      ]);
      assertEquals(relationships.items.map((row: { id: string }) => row.id), [
        edges[0],
      ]);
      await ok([
        ...scope,
        "view",
        "relationship",
        "optd/projects:task_tag_assignment",
        edges[0],
      ]);
      await ok([
        ...scope,
        "history",
        "relationship",
        "optd/projects:task_tag_assignment",
        edges[0],
      ]);
      await ok([
        ...scope,
        "view",
        "relationship",
        "optd/projects:task_milestone",
        milestoneEdge,
      ]);
      await ok([
        ...scope,
        "history",
        "relationship",
        "optd/projects:task_milestone",
        milestoneEdge,
      ]);
      assertEquals(
        (await ok([
          ...scope,
          "query",
          "relationship",
          "optd/projects:task_milestone",
        ])).items[0].id,
        milestoneEdge,
      );
      const canArchiveRead = ["projects_admin", "project_manager"].includes(
        role,
      );
      for (
        const args of [
          [...scope, "view", "optd/projects:task", archivedTask],
          [...scope, "history", "optd/projects:task", archivedTask],
          [...scope, "query", "optd/projects:task", "--include-archived"],
          [
            ...scope,
            "view",
            "relationship",
            "optd/projects:task_tag_assignment",
            edges[1],
          ],
          [
            ...scope,
            "history",
            "relationship",
            "optd/projects:task_tag_assignment",
            edges[1],
          ],
          [
            ...scope,
            "query",
            "relationship",
            "optd/projects:task_tag_assignment",
            "--include-archived",
          ],
        ]
      ) {
        if (canArchiveRead) await ok(args);
        else await denied(args, "not_found");
      }
      await denied([
        "--workspace",
        other.id,
        "query",
        "relationship",
        "optd/projects:task_tag_assignment",
      ], "not_found");
      await denied([
        "--workspace",
        other.id,
        "view",
        "optd/projects:task",
        task,
      ], "not_found");
      await denied([
        "--workspace",
        other.id,
        "query",
        "optd/projects:task",
        "--where",
        'title zzz "flight"',
      ], "not_found");
      if (role !== "projects_admin") {
        await denied([
          ...scope,
          "unlink",
          "optd/projects:task_tag_assignment",
          edges[0],
          "--expected-version",
          "1",
        ], "policy_denied");
      }
    }
    await login("projects_admin");
    for (
      const expression of [
        'title ~ "flight"',
        'title zzz "flight"',
        'title.contains("flight")',
        'unknown_field == "flight"',
      ]
    ) {
      const error = await denied([
        ...scope,
        "query",
        "optd/projects:task",
        "--where",
        expression,
      ], "bad_request");
      assertEquals(error.details.issues[0].path, "/where");
      assert(error.details.issues[0].message);
    }
    const page = await invoke([
      ...scope,
      "query",
      "relationship",
      "optd/projects:task_tag_assignment",
      "--include-archived",
      "--limit",
      "1",
    ]);
    assertEquals(page.code, 0, JSON.stringify(page));
    assertEquals(page.body.meta.has_more, true);
    const nextPage = await invoke([
      ...scope,
      "query",
      "relationship",
      "optd/projects:task_tag_assignment",
      "--include-archived",
      "--limit",
      "1",
      "--cursor",
      page.body.meta.next_cursor,
    ]);
    assertEquals(nextPage.code, 0, JSON.stringify(nextPage));
    assertEquals(nextPage.body.meta.has_more, false);
    assertEquals(
      new Set([page.body.data.items[0].id, nextPage.body.data.items[0].id])
        .size,
      2,
    );
    const valid = await ok([
      ...scope,
      "query",
      "optd/projects:task",
      "--where",
      'title == "Flight task"',
    ]);
    assertEquals(valid.items[0].id, task);
    const transition = (
      to: string,
      version: number,
      input?: unknown,
    ) => [
      ...scope,
      "transition",
      "optd/projects:task",
      task,
      "--version",
      String(version),
      "--to",
      to,
      ...(input === undefined ? [] : ["--input", JSON.stringify(input)]),
    ];
    await ok(
      transition("blocked", 1, {
        blocked_reason: "waiting",
        stage_id: seed.created.task_stages_2,
      }),
    );
    await denied(transition("todo", 2), "hook_rejected");
    await denied(
      transition("todo", 2, { blocked_reason: null }),
      "validation_failed",
    );
    await ok(
      transition("todo", 2, {
        blocked_reason: "",
        stage_id: seed.created.task_stages_0,
      }),
    );
    await denied(transition("in_progress", 2), "object_version_conflict");
    await ok(transition("in_progress", 3));
    await ok(
      transition("blocked", 4, {
        blocked_reason: "waiting",
        stage_id: seed.created.task_stages_2,
      }),
    );
    await ok(
      transition("done", 5, {
        blocked_reason: "",
        stage_id: seed.created.task_stages_3,
      }),
    );
    const completed = await ok([...scope, "view", "optd/projects:task", task]);
    assertEquals(completed.version, 6);
    assertEquals(completed.data.state, "done");
    assertEquals(completed.data.blocked_reason, "");
    await login("root");
    const assignment = assignments.projects_admin;
    await ok([
      "assignment",
      "role",
      "disable",
      users.projects_admin,
      "--assignment",
      assignment.id,
      "--expected-version",
      String(assignment.version),
    ]);
    await login("projects_admin");
    await denied([
      ...scope,
      "query",
      "relationship",
      "optd/projects:task_tag_assignment",
    ], "not_found");
  } finally {
    await harness.close();
    await Deno.remove(fixture, { recursive: true });
  }
});
