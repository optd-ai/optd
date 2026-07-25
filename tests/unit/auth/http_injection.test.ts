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
  app.post(
    "/api/v1/changesets/stage",
    async (c) => c.json({ downstream: await c.req.json() }),
  );
  app.post(
    "/api/v1/actions/:publisher/:pack/:action/stage",
    async (c) => c.json({ downstream: await c.req.json() }),
  );
  app.post(
    "/api/v1/auth/requests",
    async (c) => c.json({ downstream: await c.req.json() }),
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
  assertEquals(
    (await app.request("/queries?principal_id=spoofed", {
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
        "x-operant-principal-id": "spoofed",
      },
      body: "{}",
    })).status,
    422,
  );
});

Deno.test("changeset business fields allow principal references without granting authority", async () => {
  const { app } = testApp();
  const request = (body: unknown, authorization = "Bearer valid") =>
    app.request("/api/v1/changesets/stage", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  const legitimate = {
    project_id: uuidV7(),
    operations: [{
      op: "create",
      resource: "operant/projects:project_member",
      fields: { principal_id: uuidV7(), role: "contributor" },
    }, {
      op: "create",
      resource: "operant/projects:timesheet",
      fields: { principal_id: uuidV7(), comments: "roles are not authority" },
    }, {
      op: "link",
      relationship: "operant/projects:project_member",
      from: uuidV7(),
      to: uuidV7(),
      fields: { principal_id: uuidV7(), nested: { roles: ["domain-value"] } },
    }, {
      op: "update",
      resource: "operant/projects:timesheet",
      object_id: uuidV7(),
      set: { principal_id: uuidV7() },
    }],
  };
  const accepted = await request(legitimate);
  assertEquals(accepted.status, 200);
  assertEquals((await accepted.json()).downstream, legitimate);
  assertEquals((await request(legitimate, "")).status, 401);

  for (
    const spoof of [
      { ...legitimate, actor: { id: "spoofed" } },
      {
        ...legitimate,
        control: { envelope: { principal_id: "spoofed" } },
      },
      {
        operations: [{
          op: "create",
          resource: "operant/projects:timesheet",
          fields: {},
          principal_id: "spoofed",
        }],
      },
      {
        operations: [{
          op: "transition",
          resource: "operant/projects:timesheet",
          object_id: uuidV7(),
          to: "submitted",
          set: { principal_id: "spoofed" },
        }],
      },
      {
        operations: [{
          op: "create",
          resource: "operant/projects:timesheet",
          fields: [{ principal_id: "spoofed" }],
        }],
      },
    ]
  ) {
    assertEquals((await request(spoof)).status, 422);
  }
});

Deno.test("action inputs remain recursively protected and auth roles are exact", async () => {
  const { app } = testApp();
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: {
        authorization: "Bearer valid",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  for (
    const input of [
      { input: { actor: ["spoofed"] } },
      { input: { nested: { roles: ["super_admin"] } } },
      { input: { deep: [{ principal: { id: "spoofed" } }] } },
    ]
  ) {
    assertEquals(
      (await post("/api/v1/actions/operant/projects/start_task/stage", input))
        .status,
      422,
    );
  }
  assertEquals(
    (await post("/api/v1/auth/requests", {
      roles: ["project:contributor"],
      boundary: { type: "project", project_id: uuidV7() },
    })).status,
    200,
  );
  assertEquals(
    (await post("/api/v1/auth/requests", {
      boundary: { roles: ["system:super_admin"] },
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
