import { Hono } from "npm:hono";
import { type Result, toHttpStatus } from "../../../domain/errors/result.ts";
import type { HomeDto } from "../../../application/services/inspect_metadata.ts";

export type HttpDependencies = {
  metadata: {
    home(): Promise<Result<HomeDto>>;
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

  app.get("/health", (c) => {
    return c.json({
      ok: true,
      data: {
        status: "ready",
        version: deps.version,
      },
    });
  });

  app.get(
    "/metadata/home",
    async (c) => resultJson(c, await deps.metadata.home()),
  );

  return app;
}
