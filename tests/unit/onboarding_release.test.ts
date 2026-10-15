import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { validateWorkspaceSelector } from "../../src/domain/workspaces/model.ts";

const workspace = "019b7a2e-7c10-7000-8000-000000000001";
const from = "019b7a2e-7c10-7000-8000-000000000002";
const to = "019b7a2e-7c10-7000-8000-000000000003";
const edge = "019b7a2e-7c10-7000-8000-000000000004";
const stage = "019b7a2e-7c10-7000-8000-000000000005";

type RequestLog = { path: string; body: Record<string, unknown> };
async function withCli(
  test: (
    run: (args: string[]) => ReturnType<typeof runOptctl>,
    requests: RequestLog[],
  ) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "optd-onboarding-unit-" });
  const saved = new Map<string, string | undefined>();
  for (
    const key of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"]
  ) {
    saved.set(key, Deno.env.get(key));
    Deno.env.set(key, `${root}/${key}`);
  }
  const requests: RequestLog[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (request) => {
      const path = new URL(request.url).pathname;
      const body = request.method === "POST" ? await request.json() : {};
      requests.push({ path, body });
      const data = path.endsWith("/workspace/resolve")
        ? { workspace_id: workspace }
        : path.endsWith("/auth/roles")
        ? {
          roles: ["system:admin"],
          boundary: { type: "workspace", workspace_id: workspace },
        }
        : path.endsWith("/changesets/stage")
        ? { id: stage }
        : path.endsWith("/commit")
        ? { id: stage, created: { edge } }
        : path.endsWith("/queries")
        ? {
          items: [{ id: from }],
          has_more: true,
          next_cursor: "next",
          total: null,
        }
        : {};
      return Response.json({ ok: true, data });
    },
  );
  try {
    await test(
      (args) =>
        runOptctl([
          "--server",
          `http://127.0.0.1:${server.addr.port}`,
          ...args,
        ]),
      requests,
    );
  } finally {
    await server.shutdown();
    for (const [key, value] of saved) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("transition input is optional but explicit malformed input and missing write fields fail locally", async () => {
  await withCli(async (run, requests) => {
    const args = [
      "--json",
      "--workspace",
      workspace,
      "transition",
      "optd/projects:task",
      from,
      "--version",
      "2",
      "--to",
      "done",
      "--stage",
    ];
    for (
      const input of [[], ["--input", "{}"], [
        "--input",
        '{"blocked_reason":null}',
      ]]
    ) {
      requests.length = 0;
      const result = await run([...args, ...input]);
      assertEquals(result.code, 0, result.stderr);
      assertEquals(requests.length, 1);
      const operation =
        (requests[0].body.operations as Record<string, unknown>[])[0];
      assertEquals(operation.to, "done");
      assertEquals(operation.expected_version, 2);
      assertEquals(operation.set, input.length ? JSON.parse(input[1]) : {});
    }
    for (
      const input of [["--input"], ["--input", "[]"], ["--input", "null"], [
        "--unknown",
        "x",
      ]]
    ) {
      requests.length = 0;
      const result = await run([...args, ...input]);
      assert(result.code !== 0, JSON.stringify(input));
      assertEquals(requests.length, 0);
    }
    for (const command of ["create", "update"]) {
      requests.length = 0;
      const result = await run([
        "--json",
        "--workspace",
        workspace,
        command,
        "optd/projects:task",
        from,
        "--version",
        "2",
      ]);
      assertEquals(result.code, 2);
      assertEquals(requests.length, 0);
    }
  });
});

Deno.test("onboarding selectors accept exact slugs and UUIDv7 but reject malformed UUIDs", () => {
  for (const value of [workspace, "sales", "sales-2026", "a".repeat(63)]) {
    assert(validateWorkspaceSelector(value).ok, value);
  }
  for (
    const value of [
      "",
      "*",
      "Sales",
      "sales/team",
      "a".repeat(64),
      "019b7a2e-7c10-4000-8000-000000000001",
      null,
    ]
  ) {
    const result = validateWorkspaceSelector(value);
    assert(!result.ok, String(value));
    assertEquals(result.error.details, { field: "workspace" });
  }
});

Deno.test("relationship commands use ordinary staging/commit operations and retain returned identities", async () => {
  await withCli(async (run, requests) => {
    const linked = await run([
      "--json",
      "--workspace",
      workspace,
      "link",
      "optd/projects:task_dependency",
      "--from",
      from,
      "--to",
      to,
      "--input",
      '{"note":"test"}',
    ]);
    assertEquals(linked.code, 0, linked.stderr);
    assertEquals(JSON.parse(linked.stdout).data.created.edge, edge);
    assertEquals(requests[0], {
      path: "/api/v1/changesets/stage",
      body: {
        operations: [{
          op: "link",
          relationship: "optd/projects:task_dependency",
          from,
          to,
          fields: { note: "test" },
          workspace_id: workspace,
        }],
      },
    });
    assertEquals(requests[1].path, `/api/v1/changesets/${stage}/commit`);
    requests.length = 0;
    const unlinked = await run([
      "--json",
      "--workspace",
      workspace,
      "unlink",
      "optd/projects:task_dependency",
      edge,
      "--expected-version",
      "2",
      "--stage",
    ]);
    assertEquals(unlinked.code, 0, unlinked.stderr);
    assertEquals(requests, [{
      path: "/api/v1/changesets/stage",
      body: {
        operations: [{
          op: "unlink",
          relationship: "optd/projects:task_dependency",
          relationship_id: edge,
          expected_version: 2,
          workspace_id: workspace,
        }],
      },
    }]);
  });
});

Deno.test("relationship argument failures never stage and auth slugs never list workspaces", async () => {
  await withCli(async (run, requests) => {
    for (
      const args of [
        ["link", "optd/projects:task_dependency", "--from", "bad", "--to", to],
        [
          "link",
          "optd/projects:task_dependency",
          "--from",
          from,
          "--to",
          to,
          "--input",
          "{}",
          "--file",
          "input.json",
        ],
        [
          "unlink",
          "optd/projects:task_dependency",
          edge,
          "--expected-version",
          "9007199254740992",
        ],
        ["unlink", "optd/projects:task_dependency", edge, "--stage", "--stage"],
        [
          "auth",
          "roles",
          "--workspace",
          "019b7a2e-7c10-4000-8000-000000000001",
        ],
        ["auth", "roles", "--workspace", "sales", "--boundary", "system"],
        ["auth", "roles", "--workspace"],
        ["auth", "roles", "--workspace="],
        ["auth", "roles", "--boundary", "workspace"],
        ["auth", "roles", "--workspace", "sales", "--workspace", "other"],
      ]
    ) {
      const result = await run(["--json", "--workspace", workspace, ...args]);
      assertEquals(result.code, 2, result.stderr);
    }
    assertEquals(requests.length, 0);
    const roles = await run([
      "--json",
      "auth",
      "roles",
      "--workspace",
      "sales",
    ]);
    assertEquals(roles.code, 0, roles.stderr);
    assertEquals(requests.map((r) => r.path), [
      "/api/v1/auth/workspace/resolve",
      "/api/v1/auth/roles",
    ]);
    assertEquals(requests[0].body, { workspace: "sales" });
    const redundantBoundary = await run([
      "--json",
      "auth",
      "roles",
      "--workspace",
      workspace,
      "--boundary",
      "workspace",
    ]);
    assertEquals(redundantBoundary.code, 0, redundantBoundary.stderr);
    assertEquals(requests[2].body, { workspace });
  });
});

Deno.test("critical pagination precedes rows without contaminating JSON and help exposes new flags", async () => {
  await withCli(async (run) => {
    const args = ["--workspace", workspace, "query", "optd/projects:task"];
    const human = await run(args);
    assertEquals(human.code, 0, human.stderr);
    assert(
      human.stdout.startsWith("Showing 1; more results available."),
      human.stdout,
    );
    const machine = await run(["--json", ...args]);
    assertEquals(machine.code, 0, machine.stderr);
    assertEquals(JSON.parse(machine.stdout).data.items.length, 1);
    for (
      const [command, flag] of [["link", "--from"], [
        "unlink",
        "--expected-version",
      ]]
    ) {
      const help = await run([command, "--help"]);
      assertEquals(help.code, 0, help.stderr);
      assertStringIncludes(help.stdout, flag);
    }
    for (const args of [["pack"], ["pack", "apply"], ["seed"]]) {
      const help = await run([...args, "--help"]);
      assertEquals(help.code, 0, help.stderr);
      assertStringIncludes(help.stdout, "seed commit <publisher/pack> --all");
      assertStringIncludes(help.stdout, "may update existing data");
    }
    const bootstrapHelp = await run(["bootstrap", "init", "--help"]);
    assertStringIncludes(bootstrapHelp.stdout, "OPTD_AUTH_ANCHOR_PID");
    const seed = await run([
      "--workspace",
      workspace,
      "seed",
      "commit",
      "optd/projects",
    ]);
    assertEquals(seed.code, 2);
    assertStringIncludes(seed.stderr, "either --all or one or more --seed");
  });
});
