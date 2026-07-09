import { Hono } from "npm:hono";
import { type Result, toHttpStatus } from "../../../domain/errors/result.ts";
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

export type HttpDependencies = {
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
  health: {
    inspect(): Promise<Record<string, unknown>>;
  };
  version: string;
};

function resultJson<T>(
  c: { json: (data: unknown, status?: number) => Response },
  result: Result<T>,
) {
  if (result.ok) return c.json({ ok: true, data: result.value });
  return c.json({ ok: false, error: result.error }, toHttpStatus(result.error));
}

export function makeHttpApp(deps: HttpDependencies): Hono {
  const app = new Hono();

  app.get("/health", async (c) => {
    const health = await deps.health.inspect();
    return c.json({ ok: true, data: { version: deps.version, ...health } });
  });

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
    async (c) => resultJson(c, await deps.queries.query(await c.req.json())),
  );

  app.post(
    "/actions/:namespace/:action/preview",
    async (c) =>
      resultJson(
        c,
        await deps.actions.preview(
          c.req.param("namespace"),
          c.req.param("action"),
          await c.req.json(),
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
          await c.req.json(),
        ),
      ),
  );

  app.post(
    "/changesets/preview",
    async (c) =>
      resultJson(c, await deps.changesets.preview(await c.req.json())),
  );
  app.post(
    "/changesets/commit",
    async (c) =>
      resultJson(c, await deps.changesets.commit(await c.req.json())),
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
          parseActorQuery(c.req.query("actor")),
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

  return app;
}

function parseActorQuery(value: string | undefined): unknown {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
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
