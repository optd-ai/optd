import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { FilesystemLocalAuthStore } from "../../../src/adapters/outbound/local-auth-store/filesystem.ts";
import { platformProcessInspector } from "../../../src/adapters/outbound/process-inspection/linux.ts";
import { makeProcessTreeLauncher } from "../../support/live_harness.ts";

Deno.test("compiled agent redemption survives temporary tool shells and rejects sibling redemption", async () => {
  const root = await Deno.makeTempDir({ prefix: "optd-agent-tool-shell-" });
  const binary = join(root, "optctl");
  const sockets: WebSocket[] = [];
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/watch")) {
        const { socket, response } = Deno.upgradeWebSocket(request);
        sockets.push(socket);
        socket.onopen = () =>
          socket.send(
            JSON.stringify({ type: "auth_request_status", status: "approved" }),
          );
        return response;
      }
      if (path.endsWith("/watch-ticket")) {
        return Response.json({ ok: true, data: { ticket: "test-ticket" } });
      }
      if (path.endsWith("/requests")) {
        return Response.json({
          ok: true,
          data: { id: "test-request", status: "pending" },
        });
      }
      if (path.endsWith("/redeem")) {
        return Response.json({
          ok: true,
          data: {
            token: "test-agent-token",
            authorization: { id: "test-authorization" },
          },
        });
      }
      return new Response("unexpected route", { status: 404 });
    },
  );
  try {
    const compiled = await new Deno.Command(Deno.execPath(), {
      args: [
        "compile",
        "--frozen",
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-run",
        "--allow-sys=uid",
        "--output",
        binary,
        "src/main_optctl.ts",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(compiled.code, 0, new TextDecoder().decode(compiled.stderr));
    const origin = `http://127.0.0.1:${server.addr.port}`;
    for (
      const [name, command, expectedAuthenticated] of [
        ["exec", 'exec "$@"', true],
        ["temporary-shell", '"$@"; result=$?; exit "$result"', true],
        ["pipeline", '"$@" | /bin/cat', true],
        ["exec-in-pipeline", 'exec "$@" | /bin/cat', true],
        ["subshell", '( "$@" ); :', true],
        [
          "command-substitution",
          'output=$("$@"); printf "%s\\n" "$output"',
          true,
        ],
      ] as const
    ) {
      const dataHome = join(root, name);
      const wrapper = join(root, `${name}.sh`);
      // The persistent launcher models Pi; each wrapper models a fresh tool call.
      await Deno.writeTextFile(
        wrapper,
        `#!/bin/bash\nexec /bin/bash -o pipefail -c '${command}' -- '${binary}' "$@"\n`,
        { mode: 0o700 },
      );
      const env: Record<string, string> = {
        ...Deno.env.toObject(),
        XDG_DATA_HOME: dataHome,
      };
      delete env.OPTD_AUTH_TREE_STOP_PID;
      const store = new FilesystemLocalAuthStore(
        join(dataHome, "optd", "auth"),
        platformProcessInspector(),
      );
      await store.updateState(origin, {
        requestToken: "test-request-token",
        authorizationNonces: { "test-request": "test-nonce" },
      });
      const agent = await makeProcessTreeLauncher(
        "agent",
        wrapper,
        env,
        () => origin,
      );
      const sibling = await makeProcessTreeLauncher(
        "agent",
        binary,
        env,
        () => origin,
      );
      try {
        const requested = await agent.runOptctl([
          "--json",
          "auth",
          "request",
          "--role",
          "system:admin",
          "--reason",
          "test",
        ]);
        assertEquals(requested.code, 0, requested.stderr);
        const wrongTree = await sibling.runOptctl([
          "--json",
          "auth",
          "wait",
          "test-request",
        ]);
        assertEquals(wrongTree.code, 2);
        assertStringIncludes(
          wrongTree.stderr,
          "different or expired process tree",
        );
        const waited = await agent.runOptctl([
          "--json",
          "auth",
          "wait",
          "test-request",
        ]);
        assertEquals(waited.code, 0, waited.stderr);
        assertEquals(waited.stdout.includes("test-agent-token"), false);
        const status = await agent.runOptctl(["--json", "auth", "status"]);
        assertEquals(status.code, 0, status.stderr);
        assertEquals(
          JSON.parse(status.stdout).data.authenticated,
          expectedAuthenticated,
          name,
        );
        const siblingStatus = await sibling.runOptctl([
          "--json",
          "auth",
          "status",
        ]);
        assertEquals(
          JSON.parse(siblingStatus.stdout).data.authenticated,
          false,
          `${name}: sibling gained authority`,
        );
        assertEquals(
          JSON.parse(siblingStatus.stdout).data.request_credential_available,
          true,
        );
        assertEquals(
          (await store.requestCredential(origin))?.token,
          "test-request-token",
        );
        await agent.close();
        const afterExit = await sibling.runOptctl(["--json", "auth", "doctor"]);
        assertStringIncludes(afterExit.stdout, "process_binding_stale");
        const expired = await sibling.runOptctl([
          "--json",
          "auth",
          "wait",
          "test-request",
        ]);
        assertEquals(expired.code, 2);
        assertStringIncludes(
          expired.stderr,
          "different or expired process tree",
        );
      } finally {
        await agent.close();
        await sibling.close();
      }
    }
  } finally {
    for (const socket of sockets) {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
    await server.shutdown();
    await Deno.remove(root, { recursive: true });
  }
});
