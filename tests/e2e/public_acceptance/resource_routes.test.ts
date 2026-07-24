// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";
import { runOptctl } from "../../../src/adapters/inbound/cli-cliffy/optctl.ts";

Deno.test("resource convenience commands probe only canonical routes", async () => {
  const seen: string[] = [];
  const controller = new AbortController();
  const stageId = "019b7a2e-7c10-7000-8000-000000000011";
  const objectId = "019b7a2e-7c10-7000-8000-000000000012";
  const projectId = "019b7a2e-7c10-7000-8000-000000000013";
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
  }, (request) => {
    const url = new URL(request.url);
    seen.push(`${request.method} ${url.pathname}`);
    if (url.pathname.endsWith("/resources/lead")) {
      return Response.json({
        ok: true,
        data: {
          axi: {
            list: { defaultFields: ["id", "name", "status"] },
            search: { fields: ["name"] },
          },
        },
        meta: { request_id: "test" },
      });
    }
    if (url.pathname === "/api/v1/changesets/stage") {
      return Response.json({
        ok: true,
        data: { id: stageId },
        meta: { request_id: "test" },
      });
    }
    return Response.json({
      ok: true,
      data: { items: [] },
      meta: { request_id: "test" },
    });
  });
  const base = [
    "--server",
    `http://127.0.0.1:${server.addr.port}`,
    "--project",
    projectId,
    "--json",
  ];
  try {
    for (
      const command of [
        ["resources"],
        ["list", "operant/crm:lead"],
        ["search", "operant/crm:lead", "--text", "Acme"],
        ["create", "operant/crm:lead", "--input", '{"name":"Acme"}', "--stage"],
        [
          "update",
          "operant/crm:lead",
          objectId,
          "--input",
          '{"name":"Beta"}',
          "--version",
          "1",
          "--stage",
        ],
        [
          "transition",
          "operant/crm:lead",
          objectId,
          "--input",
          "{}",
          "--version",
          "1",
          "--to",
          "qualified",
          "--stage",
        ],
      ]
    ) {
      const result = await runOptctl([...base, ...command]);
      assertEquals(result.code, 0, result.stderr);
    }
    assertEquals(seen, [
      "GET /api/v1/metadata/home",
      "GET /api/v1/metadata/packs/operant/crm/resources/lead",
      "POST /api/v1/queries",
      "GET /api/v1/metadata/packs/operant/crm/resources/lead",
      "POST /api/v1/queries",
      "POST /api/v1/changesets/stage",
      "POST /api/v1/changesets/stage",
      "POST /api/v1/changesets/stage",
    ]);
  } finally {
    controller.abort();
    await server.finished.catch(() => undefined);
  }
});
