import { Hono } from "npm:hono";
import { type Result, toHttpStatus } from "../../../domain/errors/result.ts";
import type { HomeDto } from "../../../application/services/inspect_metadata.ts";
import type {
  ChangesetCommitDto,
  ChangesetPreviewDto,
  ChangesetRequest,
} from "../../../application/services/changeset_services.ts";
import type {
  PackApplyDto,
  PackPreviewDto,
} from "../../../application/services/pack_services.ts";
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
  changesets: {
    preview(input: ChangesetRequest): Promise<Result<ChangesetPreviewDto>>;
    commit(input: ChangesetRequest): Promise<Result<ChangesetCommitDto>>;
    view(
      resource: string,
      id: string,
      includeArchived?: boolean,
    ): Promise<Result<unknown>>;
    history(resource: string, id: string): Promise<Result<unknown>>;
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

  return app;
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
