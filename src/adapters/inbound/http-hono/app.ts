import { Hono } from "npm:hono";
import { type Result, toHttpStatus } from "../../../domain/errors/result.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import type { HomeDto } from "../../../application/services/inspect_metadata.ts";
import type {
  ChangesetCommitDto,
  ChangesetPreviewDto,
  ChangesetRequest,
} from "../../../application/services/changeset_services.ts";
import type {
  ActionDto,
  ActionRequest,
} from "../../../application/services/run_action.ts";
import type {
  PackApplyDto,
  PackPreviewDto,
} from "../../../application/services/pack_services.ts";
import type {
  QueryObjectsDto,
  QueryObjectsRequest,
} from "../../../application/services/query_objects.ts";
import type { UploadedPackFile } from "../../outbound/yaml/pack_loader.ts";
import type { RequestAuthenticator } from "../../../application/ports/authentication.ts";
import type { AuthVariables } from "./auth_middleware.ts";
import {
  isAuthorityKey,
  requireBearer,
  serverActor,
} from "./auth_middleware.ts";
import {
  type BootstrapHttpService,
  registerAuthRoutes,
} from "./auth_routes.ts";
import {
  type ProjectHttpService,
  registerProjectRoutes,
} from "./project_routes.ts";

export type HttpDependencies = {
  authentication: RequestAuthenticator;
  bootstrap: BootstrapHttpService;
  projects: ProjectHttpService;
  metadata: {
    home(): Promise<Result<HomeDto>>;
    packs(): Promise<Result<unknown>>;
    pack(namespace: string, name: string): Promise<Result<unknown>>;
    resource(namespace: string, name: string): Promise<Result<unknown>>;
    action(namespace: string, name: string): Promise<Result<unknown>>;
    hook(namespace: string, name: string): Promise<Result<unknown>>;
    policy(namespace: string, name: string): Promise<Result<unknown>>;
  };
  packs: {
    preview(files: UploadedPackFile[]): Promise<Result<PackPreviewDto>>;
    apply(files: UploadedPackFile[]): Promise<Result<PackApplyDto>>;
  };
  migrations: {
    preview(files: UploadedPackFile[]): Promise<Result<unknown>>;
    inspect(id: string): Promise<Result<unknown>>;
    apply(id: string, mode?: "safe" | "stage"): Promise<Result<unknown>>;
    confirm(id: string, token: string): Promise<Result<unknown>>;
  };
  queries: {
    query(input: QueryObjectsRequest): Promise<Result<QueryObjectsDto>>;
  };
  actions: {
    preview(
      namespace: string,
      action: string,
      input: ActionRequest,
    ): Promise<Result<ActionDto>>;
    commit(
      namespace: string,
      action: string,
      input: ActionRequest,
    ): Promise<Result<ActionDto>>;
  };
  changesets: {
    preview(input: ChangesetRequest): Promise<Result<ChangesetPreviewDto>>;
    commit(input: ChangesetRequest): Promise<Result<ChangesetCommitDto>>;
    view(
      resource: string,
      id: string,
      includeArchived?: boolean,
      actor?: unknown,
    ): Promise<Result<unknown>>;
    history(resource: string, id: string): Promise<Result<unknown>>;
  };
  outbox: {
    list(): Promise<Result<unknown>>;
    drain(
      input?: { limit?: number; worker_id?: string },
    ): Promise<Result<unknown>>;
    retry(id: string): Promise<Result<unknown>>;
  };
  secrets: {
    list(input?: { actor?: unknown }): Promise<Result<unknown>>;
    set(input: unknown): Promise<Result<unknown>>;
    delete(name: string, input?: unknown): Promise<Result<unknown>>;
  };
  health: {
    inspect(): Promise<Record<string, unknown>>;
  };
  version: string;
};

function resultJson<T>(
  c: { json: (data: unknown, status?: number) => Response },
  result: Result<T>,
) {
  if (result.ok) return c.json(successEnvelope(result.value));
  return c.json(errorEnvelope(result.error), toHttpStatus(result.error));
}

export function makeHttpApp(
  deps: HttpDependencies,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use("*", async (c, next) => {
    if (
      c.req.path === "/live" || c.req.path === "/ready" ||
      c.req.path === "/api/v1/auth/bootstrap/status" ||
      c.req.path === "/api/v1/auth/bootstrap"
    ) {
      await next();
      return;
    }
    return await requireBearer(deps.authentication, c, next);
  });

  app.get(
    "/live",
    (c) => c.json(successEnvelope({ status: "live", version: deps.version })),
  );

  // Kept temporarily for legacy diagnostics; readiness is the dependency check.
  app.get("/health", async (c) => {
    const health = await deps.health.inspect();
    return c.json(successEnvelope({ version: deps.version, ...health }));
  });

  app.get("/ready", async (c) => {
    const health = await deps.health.inspect();
    const ready = health.status === "ready";
    const data = { version: deps.version, ...health };
    return ready ? c.json(successEnvelope(data), 200) : c.json(
      errorEnvelope({
        code: "unavailable",
        message: "server dependencies are not ready",
        details: data,
      }),
      503,
    );
  });

  registerAuthRoutes(app, deps.bootstrap);
  registerProjectRoutes(app, deps.projects);

  app.get(
    "/metadata/home",
    async (c) => resultJson(c, await deps.metadata.home()),
  );
  app.get(
    "/metadata/packs",
    async (c) => resultJson(c, await deps.metadata.packs()),
  );
  app.get(
    "/metadata/packs/:namespace/:name",
    async (c) =>
      resultJson(
        c,
        await deps.metadata.pack(c.req.param("namespace"), c.req.param("name")),
      ),
  );
  app.get(
    "/metadata/resources/:namespace/:resource",
    async (c) =>
      resultJson(
        c,
        await deps.metadata.resource(
          c.req.param("namespace"),
          c.req.param("resource"),
        ),
      ),
  );
  app.get(
    "/metadata/actions/:namespace/:action",
    async (c) =>
      resultJson(
        c,
        await deps.metadata.action(
          c.req.param("namespace"),
          c.req.param("action"),
        ),
      ),
  );
  app.get(
    "/metadata/hooks/:namespace/:hook",
    async (c) =>
      resultJson(
        c,
        await deps.metadata.hook(c.req.param("namespace"), c.req.param("hook")),
      ),
  );
  app.get(
    "/metadata/policies/:namespace/:policy",
    async (c) =>
      resultJson(
        c,
        await deps.metadata.policy(
          c.req.param("namespace"),
          c.req.param("policy"),
        ),
      ),
  );

  app.post(
    "/packs/preview",
    async (c) =>
      resultJson(c, await deps.packs.preview(await multipartFiles(c.req.raw))),
  );
  app.post(
    "/packs/apply",
    async (c) =>
      resultJson(c, await deps.packs.apply(await multipartFiles(c.req.raw))),
  );

  app.post(
    "/migrations/preview",
    async (c) =>
      resultJson(
        c,
        await deps.migrations.preview(await multipartFiles(c.req.raw)),
      ),
  );
  app.get(
    "/migrations/:id",
    async (c) =>
      resultJson(c, await deps.migrations.inspect(c.req.param("id"))),
  );
  app.post(
    "/migrations/:id/apply",
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return resultJson(
        c,
        await deps.migrations.apply(c.req.param("id"), body?.mode),
      );
    },
  );
  app.post(
    "/migrations/:id/confirm",
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return resultJson(
        c,
        await deps.migrations.confirm(
          c.req.param("id"),
          String(body?.token ?? ""),
        ),
      );
    },
  );

  app.post(
    "/queries",
    async (c) =>
      resultJson(c, await deps.queries.query(await authenticatedJson(c))),
  );

  app.post(
    "/actions/:namespace/:action/preview",
    async (c) =>
      resultJson(
        c,
        await deps.actions.preview(
          c.req.param("namespace"),
          c.req.param("action"),
          await authenticatedJson(c),
        ),
      ),
  );
  app.post(
    "/actions/:namespace/:action/commit",
    async (c) =>
      resultJson(
        c,
        await deps.actions.commit(
          c.req.param("namespace"),
          c.req.param("action"),
          await authenticatedJson(c),
        ),
      ),
  );

  app.post(
    "/changesets/preview",
    async (c) =>
      resultJson(c, await deps.changesets.preview(await authenticatedJson(c))),
  );
  app.post(
    "/changesets/commit",
    async (c) =>
      resultJson(c, await deps.changesets.commit(await authenticatedJson(c))),
  );
  app.get(
    "/objects/:namespace/:resource/:id",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.view(
          `${c.req.param("namespace")}.${c.req.param("resource")}`,
          c.req.param("id"),
          c.req.query("include_archived") === "true",
          serverActor(c.get("auth")),
        ),
      ),
  );
  app.get(
    "/history/:namespace/:resource/:id",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.history(
          `${c.req.param("namespace")}.${c.req.param("resource")}`,
          c.req.param("id"),
        ),
      ),
  );

  app.get("/outbox", async (c) => resultJson(c, await deps.outbox.list()));
  app.post("/outbox/drain", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return resultJson(
      c,
      await deps.outbox.drain({
        limit: typeof body?.limit === "number" ? body.limit : undefined,
        worker_id: typeof body?.worker_id === "string"
          ? body.worker_id
          : undefined,
      }),
    );
  });
  app.post(
    "/outbox/:id/retry",
    async (c) => resultJson(c, await deps.outbox.retry(c.req.param("id"))),
  );

  app.get(
    "/secrets",
    async (c) =>
      resultJson(
        c,
        await deps.secrets.list({
          actor: serverActor(c.get("auth")),
        }),
      ),
  );
  app.post(
    "/secrets",
    async (c) =>
      resultJson(c, await deps.secrets.set(await authenticatedJson(c))),
  );
  app.delete("/secrets/:name", async (c) => {
    const body = await authenticatedJson(c).catch(() => ({
      actor_context: serverActor(c.get("auth")),
    }));
    return resultJson(c, await deps.secrets.delete(c.req.param("name"), body));
  });

  app.notFound((c) =>
    c.json(
      errorEnvelope({
        code: "not_found",
        message: "route not found",
        details: {},
      }),
      404,
    )
  );
  app.onError((error, c) => {
    console.error(error);
    const invalidJson = error instanceof SyntaxError;
    return c.json(
      errorEnvelope({
        code: invalidJson ? "invalid_json" : "internal_error",
        message: invalidJson
          ? "request body is not valid JSON"
          : "unexpected server error",
        details: {},
      }),
      invalidJson ? 400 : 500,
    );
  });

  return app;
}

export async function authenticatedJson<T extends Record<string, unknown>>(c: {
  req: { json(): Promise<unknown> };
  get(key: "auth"): AuthVariables["auth"];
}): Promise<T> {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SyntaxError("request body must be a JSON object");
  }
  const derived = serverActor(c.get("auth"));
  return {
    ...(stripAuthority(body as Record<string, unknown>) as Record<
      string,
      unknown
    >),
    actor: derived,
    actor_context: derived,
  } as unknown as T;
}

function stripAuthority(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAuthority);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isAuthorityKey(key))
      .map(([key, child]) => [key, stripAuthority(child)]),
  );
}

async function multipartFiles(request: Request): Promise<UploadedPackFile[]> {
  const form = await request.formData();
  const files: UploadedPackFile[] = [];
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      const path = key === "file" ? value.name : key;
      files.push({
        path,
        text: await value.text(),
        kind: path.endsWith(".ts") ? "script" : "config",
      });
    }
  }
  return files;
}
