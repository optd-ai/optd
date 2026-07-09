import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { runOptctl } from "../../src/adapters/inbound/cli-cliffy/optctl.ts";

type SeenRequest = { method: string; path: string; body?: unknown };

function ok(data: unknown) {
  return Response.json({ ok: true, data });
}
function error(
  status: number,
  code: string,
  message: string,
  severity: string,
) {
  return Response.json({ ok: false, error: { code, message, severity } }, {
    status,
  });
}

async function withMockServer(
  fn: (baseUrl: string, seen: SeenRequest[]) => Promise<void>,
) {
  const seen: SeenRequest[] = [];
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, async (req) => {
    const url = new URL(req.url);
    const entry: SeenRequest = { method: req.method, path: url.pathname };
    if (
      req.method !== "GET" &&
      req.headers.get("content-type")?.includes("application/json")
    ) {
      entry.body = await req.json();
    }
    seen.push(entry);
    if (url.pathname === "/metadata/resources/default/missing") {
      return error(
        404,
        "resource_not_found",
        "resource not found",
        "not_found",
      );
    }
    if (
      url.pathname === "/queries" && entry.body &&
      typeof entry.body === "object"
    ) {
      return ok({ surface: "query", request: entry.body });
    }
    return ok({ surface: url.pathname, method: req.method });
  });
  try {
    await fn(`http://127.0.0.1:${server.addr.port}`, seen);
  } finally {
    await server.shutdown();
  }
}

Deno.test("optctl maps every MVP command group to stable HTTP API URLs", async () => {
  await withMockServer(async (baseUrl, seen) => {
    const commands: string[][] = [
      ["home"],
      ["metadata"],
      ["metadata", "packs"],
      ["metadata", "pack", "default.crm"],
      ["metadata", "resource", "default.lead"],
      ["metadata", "action", "default.convert_lead"],
      ["metadata", "hook", "default.validate_lead"],
      ["metadata", "policy", "default.crm_sales"],
      [
        "query",
        "default.lead",
        "--where",
        "active()",
        "--fields",
        "id,email",
        "--limit",
        "2",
      ],
      ["view", "default.lead", "lead_1"],
      ["history", "default.lead", "lead_1"],
      ["changeset", "preview", "--input", '{"operations":[]}'],
      ["changeset", "commit", "--input", '{"operations":[]}'],
      [
        "action",
        "preview",
        "default.convert_lead",
        "--input",
        '{"lead_id":"lead_1"}',
      ],
      [
        "action",
        "commit",
        "default.convert_lead",
        "--input",
        '{"lead_id":"lead_1"}',
      ],
      ["outbox", "status"],
      ["outbox", "drain", "--limit", "1"],
      ["outbox", "retry", "outbox_1"],
      ["migration", "inspect", "mig_1"],
      ["migration", "apply", "mig_1"],
      ["migration", "apply", "mig_1", "--stage"],
      ["migration", "confirm", "mig_1", "--token", "confirm:sha256:abc"],
      ["secret", "list"],
      ["secret", "set", "api_key", "--value", "secret"],
      ["secret", "delete", "api_key"],
    ];

    for (const command of commands) {
      const result = await runOptctl([
        "--server",
        baseUrl,
        "--json",
        ...command,
      ]);
      assertEquals(
        result.code,
        0,
        `${command.join(" ")} failed: ${result.stderr}`,
      );
      assertEquals(JSON.parse(result.stdout).ok, true);
    }

    assertEquals(seen.map((r) => `${r.method} ${r.path}`), [
      "GET /metadata/home",
      "GET /metadata/packs",
      "GET /metadata/packs",
      "GET /metadata/packs/default/crm",
      "GET /metadata/resources/default/lead",
      "GET /metadata/actions/default/convert_lead",
      "GET /metadata/hooks/default/validate_lead",
      "GET /metadata/policies/default/crm_sales",
      "POST /queries",
      "GET /objects/default/lead/lead_1",
      "GET /history/default/lead/lead_1",
      "POST /changesets/preview",
      "POST /changesets/commit",
      "POST /actions/default/convert_lead/preview",
      "POST /actions/default/convert_lead/commit",
      "GET /outbox",
      "POST /outbox/drain",
      "POST /outbox/outbox_1/retry",
      "GET /migrations/mig_1",
      "POST /migrations/mig_1/apply",
      "POST /migrations/mig_1/apply",
      "POST /migrations/mig_1/confirm",
      "GET /secrets",
      "POST /secrets",
      "DELETE /secrets/api_key",
    ]);

    const query = seen.find((r) => r.path === "/queries")?.body as Record<
      string,
      unknown
    >;
    assertEquals(query.resource, "default.lead");
    assertEquals(query.fields, ["id", "email"]);
    assertEquals(query.limit, 2);
  });
});

Deno.test("optctl emits TOON by default and stable JSON error envelopes", async () => {
  await withMockServer(async (baseUrl) => {
    const toon = await runOptctl(["--server", baseUrl, "home"]);
    assertEquals(toon.code, 0, toon.stderr);
    assertStringIncludes(toon.stdout, "ok: true");
    assertStringIncludes(toon.stdout, "/metadata/home");

    const missing = await runOptctl([
      "--server",
      baseUrl,
      "--json",
      "metadata",
      "resource",
      "default.missing",
    ]);
    assertEquals(missing.code, 1);
    const envelope = JSON.parse(missing.stderr);
    assertEquals(envelope.ok, false);
    assertEquals(envelope.error.code, "resource_not_found");
    assertEquals(envelope.error.severity, "not_found");
    assert(envelope.help.includes("optctl home"));
  });
});

Deno.test("compiled optctl binary runs against HTTP server", async () => {
  await withMockServer(async (baseUrl) => {
    const dir = await Deno.makeTempDir({ prefix: "optctl-compile-" });
    const binary = `${dir}/optctl`;
    try {
      const compile = await new Deno.Command(Deno.execPath(), {
        args: [
          "compile",
          "--quiet",
          "--allow-read",
          "--allow-env",
          "--allow-net",
          "--output",
          binary,
          "src/main_optctl.ts",
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(compile.code, 0, new TextDecoder().decode(compile.stderr));

      const run = await new Deno.Command(binary, {
        args: ["--server", baseUrl, "--json", "home"],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(run.code, 0, new TextDecoder().decode(run.stderr));
      const body = JSON.parse(new TextDecoder().decode(run.stdout));
      assertEquals(body.data.surface, "/metadata/home");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  });
});
