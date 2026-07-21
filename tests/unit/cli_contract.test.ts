// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
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
  return Response.json({
    ok: false,
    error: { code, message, severity, details: {} },
    meta: { request_id: "019b7a2e-7c10-7000-8000-000000000001" },
  }, { status });
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
    if (url.pathname === "/metadata/packs/operant/crm/resources/missing") {
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

Deno.test("optctl maps current strict commands to canonical HTTP URLs", async () => {
  await withMockServer(async (baseUrl, seen) => {
    const stageId = "019b7a2e-7c10-7000-8000-000000000011";
    const commands: string[][] = [
      ["home"],
      ["metadata"],
      ["metadata", "packs"],
      ["metadata", "pack", "operant/crm"],
      ["metadata", "resource", "operant/crm:lead"],
      ["metadata", "relationship", "operant/crm:contact_company"],
      ["metadata", "action", "operant/crm:convert_lead"],
      ["metadata", "hook", "operant/crm:validate_lead"],
      ["metadata", "policy", "operant/crm:crm_sales"],
      ["changeset", "inspect", stageId],
      ["changeset", "commit", stageId],
      ["changeset", "commit", stageId, "--timeout", "250ms"],
      ["changeset", "approvals", stageId],
      ["changeset", "cancel", stageId, "--reason", "obsolete"],
      ["outbox", "status"],
      ["outbox", "drain", "--limit", "1"],
      ["outbox", "retry", stageId],
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
    assertEquals(seen.map((request) => `${request.method} ${request.path}`), [
      "GET /metadata/home",
      "GET /metadata/packs",
      "GET /metadata/packs",
      "GET /metadata/packs/operant/crm",
      "GET /metadata/packs/operant/crm/resources/lead",
      "GET /metadata/packs/operant/crm/relationships/contact_company",
      "GET /metadata/packs/operant/crm/actions/convert_lead",
      "GET /metadata/packs/operant/crm/hooks/validate_lead",
      "GET /metadata/packs/operant/crm/policies/crm_sales",
      `GET /api/v1/changesets/${stageId}`,
      `POST /api/v1/changesets/${stageId}/commit`,
      `POST /api/v1/changesets/${stageId}/commit`,
      `GET /api/v1/changesets/${stageId}/approvals`,
      `POST /api/v1/changesets/${stageId}/cancel`,
      "GET /outbox",
      "POST /outbox/drain",
      `/POST /outbox/${stageId}/retry`.slice(1),
    ]);
    const commitBodies = seen.filter((request) =>
      request.path.endsWith("/commit")
    );
    assertEquals(commitBodies.map((request) => request.body), [
      {},
      { lock_timeout: "250ms" },
    ]);
  });
});

Deno.test("optctl rejects legacy aliases and noncanonical commit forms", async () => {
  await withMockServer(async (baseUrl, seen) => {
    for (
      const command of [
        ["metadata", "pack", "default.crm"],
        ["metadata", "resource", "default.lead"],
        ["changeset", "commit", "--input", '{"operations":[]}'],
        ["changeset", "preview", "--input", '{"operations":[]}'],
      ]
    ) {
      const result = await runOptctl([
        "--server",
        baseUrl,
        "--json",
        ...command,
      ]);
      assertEquals(
        result.code,
        2,
        `${command.join(" ")} unexpectedly accepted`,
      );
    }
    assertEquals(seen.length, 0);
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
      "operant/crm:missing",
    ]);
    assertEquals(missing.code, 1);
    const envelope = JSON.parse(missing.stderr);
    assertEquals(envelope.ok, false);
    assertEquals(envelope.error.code, "resource_not_found");
    assertEquals(envelope.error.severity, "not_found");
    assertEquals(envelope.error.details, {});
    assertEquals(
      envelope.meta.request_id,
      "019b7a2e-7c10-7000-8000-000000000001",
    );
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
