import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { authAnchor } from "../../src/adapters/inbound/cli-cliffy/auth_store.ts";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";
import { FilesystemLocalAuthStore } from "../../src/adapters/outbound/local-auth-store/filesystem.ts";
import { platformProcessInspector } from "../../src/adapters/outbound/process-inspection/linux.ts";

for (const flags of [[], ["--json"], ["--verbose"], ["--json", "--verbose"]]) {
  Deno.test(`agent redemption keeps shared discovery and hides credentials (${flags.join(" ") || "text"})`, async () => {
    const root = await Deno.makeTempDir({ prefix: "optd-redemption-cli-" });
    const previous = Deno.env.get("XDG_DATA_HOME");
    Deno.env.set("XDG_DATA_HOME", root);
    const requestToken = "test-request-only-secret";
    const agentToken = "test-agent-bearer-secret";
    const nonce = "test-private-redemption-nonce";
    const ticket = "test-private-watch-ticket";
    const sockets: WebSocket[] = [];
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith("/watch")) {
          const { socket, response } = Deno.upgradeWebSocket(request);
          sockets.push(socket);
          socket.onopen = () =>
            socket.send(
              JSON.stringify({
                type: "auth_request_status",
                status: "approved",
              }),
            );
          return response;
        }
        if (path.endsWith("/watch-ticket")) {
          assertEquals(
            request.headers.get("authorization"),
            `Bearer ${requestToken}`,
          );
          return Response.json({ ok: true, data: { ticket } });
        }
        if (path.endsWith("/redeem")) {
          assertEquals(
            request.headers.get("authorization"),
            `Bearer ${requestToken}`,
          );
          assertEquals(await request.json(), { redemption_nonce: nonce });
          return Response.json({
            ok: true,
            data: {
              token: agentToken,
              authorization: { id: "test-authorization", active: true },
            },
          });
        }
        return new Response("unexpected route", { status: 404 });
      },
    );
    try {
      const origin = `http://127.0.0.1:${server.addr.port}`;
      const store = new FilesystemLocalAuthStore(
        join(root, "optd", "auth"),
        platformProcessInspector(),
      );
      const anchor = await authAnchor(origin);
      await store.updateState(origin, {
        requestToken,
        requestSessionId: "test-request-session",
        authorizationNonces: { "test-request": nonce },
        authorizationAnchors: { "test-request": anchor },
      });
      const result = await runOptctl([
        "--server",
        origin,
        ...flags,
        "auth",
        "wait",
        "test-request",
      ]);
      assertEquals(result.code, 0, result.stderr);
      assertStringIncludes(result.stdout, "test-authorization");
      assertStringIncludes(result.stdout, "authenticated");
      for (const secret of [requestToken, agentToken, nonce, ticket]) {
        assertEquals((result.stdout + result.stderr).includes(secret), false);
      }
      assertEquals(
        (await store.requestCredential(origin))?.token,
        requestToken,
      );
      const selected = await store.select(origin, Deno.ppid);
      assertEquals(selected?.token, agentToken);
      assertEquals(selected?.kind, "agent");
      assertEquals(selected?.anchor?.pid, anchor.pid);
      assertEquals(
        (await store.readState(origin)).requestSessionId,
        "test-request-session",
      );
    } finally {
      for (const socket of sockets) {
        if (socket.readyState < WebSocket.CLOSING) socket.close();
      }
      await server.shutdown();
      if (previous === undefined) Deno.env.delete("XDG_DATA_HOME");
      else Deno.env.set("XDG_DATA_HOME", previous);
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("agent auth help explains persistent and ephemeral shell binding", async () => {
  for (const command of ["request", "wait", "login", "session-pid"]) {
    const result = await runOptctl(["auth", command, "--help"]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "nearest recognized harness");
    assertStringIncludes(
      result.stdout,
      "Pipelines, subshells and command substitutions",
    );
    assertStringIncludes(result.stdout, "OPTD_AUTH_ANCHOR_PID");
    assertStringIncludes(result.stdout, "same live process identity");
  }
});
