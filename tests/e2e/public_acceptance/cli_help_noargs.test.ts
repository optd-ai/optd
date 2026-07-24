// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { runOptctl } from "../../../src/adapters/inbound/cli-cliffy/optctl.ts";

Deno.test("public CLI exposes root, group, and subcommand help", async () => {
  const root = await runOptctl(["--help"]);
  assertEquals(root.code, 0);
  for (
    const command of [
      "context",
      "metadata",
      "pack",
      "changeset",
      "action",
      "seed",
    ]
  ) {
    assertStringIncludes(root.stdout, command);
    const group = await runOptctl([command, "--help"]);
    assertEquals(group.code, 0);
    assertStringIncludes(group.stdout, `Usage: optctl ${command} <command>`);
  }
  const subcommand = await runOptctl(["context", "list", "--help"]);
  assertEquals(subcommand.code, 0);
  assertStringIncludes(
    subcommand.stdout,
    "Usage: optctl context list [options]",
  );
});

Deno.test("content-first noargs loads metadata home and preserves JSON envelope", async () => {
  const controller = new AbortController();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
  }, (request) => {
    assertEquals(new URL(request.url).pathname, "/api/v1/metadata/home");
    return Response.json({
      ok: true,
      data: { status: "ready", resources: [] },
      meta: { request_id: "test" },
    });
  });
  try {
    const result = await runOptctl([
      "--server",
      `http://127.0.0.1:${server.addr.port}`,
      "--json",
    ]);
    assertEquals(result.code, 0);
    const envelope = JSON.parse(result.stdout);
    assert(envelope.ok);
    assertEquals(envelope.data.status, "ready");
  } finally {
    controller.abort();
    await server.finished.catch(() => undefined);
  }
});
