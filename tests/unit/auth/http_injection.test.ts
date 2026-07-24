import { assertEquals } from "jsr:@std/assert";
import { Hono } from "npm:hono";
import { authenticatedJson } from "../../../src/adapters/inbound/http-hono/app.ts";
import {
  type AuthVariables,
  requireBearer,
} from "../../../src/adapters/inbound/http-hono/auth_middleware.ts";
import { uuidV7 } from "../../../src/domain/ids/uuid_v7.ts";

function testApp() {
  const app = new Hono<{ Variables: AuthVariables }>();
  const context = Object.freeze({
    id: uuidV7(),
    principalId: uuidV7(),
    principalType: "human_user" as const,
    humanUserId: uuidV7(),
    sessionId: uuidV7(),
    credentialKind: "human_full" as const,
    roles: Object.freeze(["system:super_admin"]),
    createdAt: new Date().toISOString(),
  });
  app.use(
    "*",
    (c, next) =>
      requireBearer(
        { authenticate: () => Promise.resolve({ ok: true, value: context }) },
        c,
        next,
      ),
  );
  app.post(
    "/queries",
    async (c) => c.json({ input: await authenticatedJson(c) }),
  );
  app.post("/api/v1/packs/preview", (c) => c.json({ ok: true }));
  return { app, context };
}

Deno.test("protected JSON routes reject authority injection independent of content type", async () => {
  const { app } = testApp();
  const call = (
    headers: Record<string, string>,
    body = '{"actor":{"roles":["super_admin"]}}',
  ) =>
    app.request("/queries", {
      method: "POST",
      headers: { authorization: "Bearer valid", ...headers },
      body,
    });

  assertEquals((await call({})).status, 415);
  assertEquals((await call({ "content-type": "text/plain" })).status, 415);
  assertEquals(
    (await call({ "content-type": "multipart/form-data; boundary=x" }, "--x--"))
      .status,
    415,
  );
  assertEquals(
    (await call({ "content-type": "application/json" })).status,
    422,
  );
  assertEquals(
    (await app.request("/queries?actor=admin", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: "{}",
    })).status,
    422,
  );
  assertEquals(
    (await app.request("/queries?roles=super_admin", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: "{}",
    })).status,
    422,
  );
  assertEquals(
    (await app.request("/queries", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
        "x-operant-actor": "admin",
      },
      body: "{}",
    })).status,
    422,
  );
  assertEquals(
    (await app.request("/queries", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
        "x-roles": "super_admin",
      },
      body: "{}",
    })).status,
    422,
  );
});

Deno.test("canonical pack preview accepts multipart and rejects wrong media types", async () => {
  const { app } = testApp();
  const form = new FormData();
  form.append("file", new File(["pack"], "pack.yaml"));
  assertEquals(
    (await app.request("/api/v1/packs/preview", {
      method: "POST",
      headers: { authorization: "Bearer valid" },
      body: form,
    })).status,
    200,
  );
  assertEquals(
    (await app.request("/api/v1/packs/preview", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: "{}",
    })).status,
    415,
  );
  assertEquals(
    (await app.request("/queries", {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "multipart/form-data; boundary=x",
      },
      body: "--x--",
    })).status,
    415,
  );
});

Deno.test("authenticated JSON replaces all caller authority with server context", async () => {
  const { app, context } = testApp();
  const response = await app.request("/queries", {
    method: "POST",
    headers: {
      authorization: "Bearer valid",
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      resource: "operant/crm:lead",
      filter: { state: "open" },
    }),
  });
  assertEquals(response.status, 200);
  const input = (await response.json()).input;
  assertEquals(input.resource, "operant/crm:lead");
  assertEquals(input.actor.id, context.principalId);
  assertEquals(input.actor_context.auth_context_id, context.id);
  assertEquals(input.actor.roles, ["super_admin"]);
});
