import type { Hono } from "npm:hono";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { Project } from "../../../domain/projects/model.ts";
import type { Result } from "../../../domain/errors/result.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import type { AuthVariables } from "./auth_middleware.ts";
import { strictObject } from "./auth_routes.ts";

export type ProjectHttpService = {
  create(
    auth: AuthContext,
    input: { slug: unknown; displayName: unknown; description?: unknown },
  ): Promise<Result<Project>>;
  list(
    auth: AuthContext,
    input: {
      status?: unknown;
      slug?: unknown;
      limit?: unknown;
      cursor?: unknown;
    },
  ): Promise<
    Result<{
      items: Project[];
      page: { limit: number; nextCursor: string | null };
    }>
  >;
  get(auth: AuthContext, id: string): Promise<Result<Project>>;
  update(
    auth: AuthContext,
    id: string,
    input: {
      expectedVersion: unknown;
      displayName?: unknown;
      description?: unknown;
    },
  ): Promise<Result<Project>>;
  archive(
    auth: AuthContext,
    id: string,
    expectedVersion: unknown,
  ): Promise<Result<Project>>;
};

export function registerProjectRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  service: ProjectHttpService,
) {
  app.post("/api/v1/projects", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (
      !strictObject(body, ["slug", "display_name", "description"], [
        "slug",
        "display_name",
      ])
    ) return invalid(c);
    return respond(
      c,
      await service.create(c.get("auth"), {
        slug: body.slug,
        displayName: body.display_name,
        ...Object.hasOwn(body, "description")
          ? { description: body.description }
          : {},
      }),
      201,
    );
  });
  app.get("/api/v1/projects", async (c) => {
    const parsed = parseListQuery(c.req.url);
    if (!parsed.ok) return invalidQuery(c, parsed.code, parsed.message);
    return respondPage(c, await service.list(c.get("auth"), parsed.value));
  });
  app.get(
    "/api/v1/projects/:project_id",
    async (c) =>
      respond(c, await service.get(c.get("auth"), c.req.param("project_id"))),
  );
  app.post("/api/v1/projects/:project_id/update", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (
      !strictObject(body, ["expected_version", "display_name", "description"], [
        "expected_version",
      ])
    ) return invalid(c);
    return respond(
      c,
      await service.update(c.get("auth"), c.req.param("project_id"), {
        expectedVersion: body.expected_version,
        ...Object.hasOwn(body, "display_name")
          ? { displayName: body.display_name }
          : {},
        ...Object.hasOwn(body, "description")
          ? { description: body.description }
          : {},
      }),
    );
  });
  app.post("/api/v1/projects/:project_id/archive", async (c) => {
    const body = await c.req.json().catch(() => undefined);
    if (!strictObject(body, ["expected_version"], ["expected_version"])) {
      return invalid(c);
    }
    return respond(
      c,
      await service.archive(
        c.get("auth"),
        c.req.param("project_id"),
        body.expected_version,
      ),
    );
  });
}

function dto(project: Project) {
  return {
    id: project.id,
    slug: project.slug,
    display_name: project.displayName,
    description: project.description,
    status: project.status,
    version: project.version,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
    archived_at: project.archivedAt,
  };
}
function respond(
  c: { json(data: unknown, status?: number): Response },
  result: Result<Project | Project[]>,
  status = 200,
) {
  if (!result.ok) {
    return c.json(errorEnvelope(result.error), toHttpStatus(result.error));
  }
  return c.json(
    successEnvelope(
      Array.isArray(result.value)
        ? { items: result.value.map(dto) }
        : dto(result.value),
    ),
    status,
  );
}
function respondPage(
  c: { json(data: unknown, status?: number): Response },
  result: Result<{
    items: Project[];
    page: { limit: number; nextCursor: string | null };
  }>,
) {
  if (!result.ok) {
    return c.json(errorEnvelope(result.error), toHttpStatus(result.error));
  }
  return c.json(successEnvelope({
    items: result.value.items.map(dto),
    page: {
      limit: result.value.page.limit,
      next_cursor: result.value.page.nextCursor,
    },
  }));
}

type ParsedListQuery =
  | {
    ok: true;
    value: { status?: string; slug?: string; limit?: string; cursor?: string };
  }
  | { ok: false; code: string; message: string };

function parseListQuery(urlValue: string): ParsedListQuery {
  const url = new URL(urlValue);
  const allowed = new Set(["status", "slug", "limit", "cursor"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        code: "validation_failed",
        message: `unknown Project list query field: ${key}`,
      };
    }
    if (url.searchParams.getAll(key).length !== 1) {
      return {
        ok: false,
        code: "validation_failed",
        message: `Project list query field must occur once: ${key}`,
      };
    }
  }
  return {
    ok: true,
    value: Object.fromEntries(url.searchParams.entries()),
  };
}

function invalidQuery(
  c: { json(data: unknown, status?: number): Response },
  code: string,
  message: string,
) {
  return c.json(errorEnvelope({ code, message, details: {} }), 400);
}

function invalid(c: { json(data: unknown, status?: number): Response }) {
  return c.json(
    errorEnvelope({
      code: "validation_failed",
      message: "project request is invalid",
      details: {},
    }),
    422,
  );
}
