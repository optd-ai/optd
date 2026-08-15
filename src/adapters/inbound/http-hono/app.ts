// deno-lint-ignore-file no-import-prefix no-unversioned-import
import { Hono } from "npm:hono";
import {
  err,
  type Result,
  toHttpStatus,
  validationError,
} from "../../../domain/errors/result.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import type {
  HomeDto,
  MetadataOptions,
} from "../../../application/services/inspect_metadata.ts";
import type { ReadAddress } from "../../../application/ports/object_reader.ts";
import type { StageDto } from "../../../application/ports/stage_repository.ts";
import type { CommitChangesetDto } from "../../../domain/changesets/commit.ts";
import type { PackPreviewDto } from "../../../application/services/pack_services.ts";
import type { QueryObjectsDto } from "../../../application/services/query_objects.ts";
import type { UploadedPackFile } from "../../outbound/yaml/pack_loader.ts";
import type { RequestAuthenticator } from "../../../application/ports/authentication.ts";
import type { AuthVariables } from "./auth_middleware.ts";
import {
  isAuthorityKey,
  requireBearer,
  serverActor,
} from "./auth_middleware.ts";
import {
  type AgentAuthHttpService,
  type BootstrapHttpService,
  type HumanAuthHttpService,
  registerAuthRoutes,
} from "./auth_routes.ts";
import {
  type ProjectHttpService,
  registerProjectRoutes,
} from "./project_routes.ts";
import {
  type AuthorizationHttpService,
  registerAuthorizationRoutes,
} from "./authorization_routes.ts";
import { requireAssignmentBearer } from "./authorization_auth.ts";

export type HttpDependencies = {
  authentication: RequestAuthenticator;
  bootstrap: BootstrapHttpService;
  humanAuth: HumanAuthHttpService;
  agentAuth: AgentAuthHttpService;
  projects: ProjectHttpService;
  authorization: AuthorizationHttpService;
  metadata: {
    home(options: MetadataOptions): Promise<Result<HomeDto>>;
    packs(options: MetadataOptions): Promise<Result<unknown>>;
    pack(
      publisher: string,
      pack: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    resource(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    relationship(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    lifecycle(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    action(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    hook(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    role(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    policy(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
    seed(
      publisher: string,
      pack: string,
      name: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>>;
  };
  objectReads: {
    read(
      address: ReadAddress,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    history(
      address: ReadAddress,
      auth: AuthVariables["auth"],
      input: { limit?: string; cursor?: string },
    ): Promise<Result<unknown>>;
  };
  packs: {
    preview(
      files: UploadedPackFile[],
      auth: AuthVariables["auth"],
    ): Promise<Result<PackPreviewDto>>;
  };
  migrations: {
    inspect(id: string, auth: AuthVariables["auth"]): Promise<Result<unknown>>;
    violations(
      id: string,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    validate(id: string, auth: AuthVariables["auth"]): Promise<Result<unknown>>;
    apply(
      id: string,
      input: {
        acknowledgement: "safe" | "reviewed" | "destructive";
        confirmation_token?: string | null;
        lock_timeout?: string;
      },
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    sql(id: string, auth: AuthVariables["auth"]): Promise<Result<unknown>>;
  };
  expressions: {
    help(context?: string): Result<unknown>;
    validate(input: unknown): Promise<Result<unknown>>;
  };
  queries: {
    query(
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<QueryObjectsDto>>;
  };
  actions: {
    stage(
      publisher: string,
      pack: string,
      action: string,
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
  };
  seeds: {
    stage(
      publisher: string,
      pack: string,
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
  };
  changesets: {
    commit(
      id: string,
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<CommitChangesetDto>>;
    stage(
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<StageDto>>;
    inspect(id: string, auth: AuthVariables["auth"]): Promise<Result<StageDto>>;
    cancel(
      id: string,
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<StageDto>>;
    approvals(
      id: string,
      auth: AuthVariables["auth"],
    ): Promise<Result<StageDto>>;
    decideApproval(
      id: string,
      requirementId: string,
      input: unknown,
      auth: AuthVariables["auth"],
    ): Promise<Result<StageDto>>;
  };
  outbox: {
    list(
      input: Record<string, unknown>,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    inspect(id: string, auth: AuthVariables["auth"]): Promise<Result<unknown>>;
    attempts(
      id: string,
      input: Record<string, unknown>,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    drain(
      limit: number | undefined,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    retry(
      id: string,
      reason: string | undefined,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
    cancel(
      id: string,
      reason: string | undefined,
      auth: AuthVariables["auth"],
    ): Promise<Result<unknown>>;
  };
  secrets: {
    list(input: { auth: AuthVariables["auth"] }): Promise<Result<unknown>>;
    create(input: unknown): Promise<Result<unknown>>;
    rotate(id: string, input: unknown): Promise<Result<unknown>>;
    disable(id: string, input: unknown): Promise<Result<unknown>>;
  };
  hookSecretGrants: {
    list(input: { auth: AuthVariables["auth"] }): Promise<Result<unknown>>;
    create(input: unknown): Promise<Result<unknown>>;
    replace(id: string, input: unknown): Promise<Result<unknown>>;
    revoke(id: string, input: unknown): Promise<Result<unknown>>;
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
      /^\/(?:secrets|hook-secret-grants)(?:\/|$)/.test(c.req.path)
    ) {
      await next();
      return;
    }
    if (
      c.req.path === "/live" || c.req.path === "/ready" ||
      c.req.path === "/api/v1/auth/bootstrap/status" ||
      c.req.path === "/api/v1/auth/bootstrap" ||
      c.req.path === "/api/v1/auth/login" ||
      c.req.path === "/api/v1/auth/password-policy" ||
      (c.req.method === "POST" &&
        c.req.path === "/api/v1/auth/password-reset/requests") ||
      (c.req.method === "POST" &&
        /^\/api\/v1\/auth\/password-reset\/requests\/[^/]+\/(cancel|redeem|complete|watch-ticket)$/
          .test(c.req.path)) ||
      (c.req.method === "GET" &&
        /^\/api\/v1\/auth\/(?:password-reset\/)?requests\/[^/]+\/watch$/.test(
          c.req.path,
        )) ||
      c.req.path === "/api/v1/auth/recovery/complete"
    ) {
      await next();
      return;
    }
    if (
      c.req.method === "POST" &&
      /^\/api\/v1\/auth\/users\/[^/]+\/role-assignments(?:\/[^/]+\/disable)?$/
        .test(c.req.path)
    ) {
      return await requireAssignmentBearer(deps.authentication, c, next);
    }
    return await requireBearer(deps.authentication, c, next);
  });

  app.get(
    "/live",
    (c) => c.json(successEnvelope({ status: "live", version: deps.version })),
  );

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

  registerAuthRoutes(app, deps.bootstrap, deps.humanAuth, deps.agentAuth);
  registerProjectRoutes(app, deps.projects);
  registerAuthorizationRoutes(app, deps.authorization);

  app.get("/api/v1/metadata/home", async (c) => {
    const options = metadataOptions(c);
    return options.ok
      ? resultJson(c, await deps.metadata.home(options.value))
      : resultJson(c, options);
  });
  app.get("/api/v1/metadata/packs", async (c) => {
    const options = metadataOptions(c);
    return options.ok
      ? resultJson(c, await deps.metadata.packs(options.value))
      : resultJson(c, options);
  });
  app.get("/api/v1/metadata/packs/:publisher/:pack", async (c) => {
    const options = metadataOptions(c);
    return options.ok
      ? resultJson(
        c,
        await deps.metadata.pack(
          c.req.param("publisher"),
          c.req.param("pack"),
          options.value,
        ),
      )
      : resultJson(c, options);
  });
  const metadataChildren = {
    resources: deps.metadata.resource,
    relationships: deps.metadata.relationship,
    lifecycles: deps.metadata.lifecycle,
    actions: deps.metadata.action,
    hooks: deps.metadata.hook,
    roles: deps.metadata.role,
    policies: deps.metadata.policy,
    seeds: deps.metadata.seed,
  } as const;
  for (const [plural, inspect] of Object.entries(metadataChildren)) {
    app.get(
      `/api/v1/metadata/packs/:publisher/:pack/${plural}/:name`,
      async (c) => {
        const options = metadataOptions(c);
        return options.ok
          ? resultJson(
            c,
            await inspect(
              c.req.param("publisher"),
              c.req.param("pack"),
              c.req.param("name"),
              options.value,
            ),
          )
          : resultJson(c, options);
      },
    );
  }

  app.post("/api/v1/packs/preview", async (c) => {
    try {
      return resultJson(
        c,
        await deps.packs.preview(
          await multipartFiles(c.req.raw),
          c.get("auth"),
        ),
      );
    } catch (error) {
      return resultJson(
        c,
        err(
          validationError(
            "bad_pack",
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    }
  });
  app.get(
    "/api/v1/migrations/:id",
    async (c) =>
      resultJson(
        c,
        await deps.migrations.inspect(c.req.param("id"), c.get("auth")),
      ),
  );
  app.get(
    "/api/v1/migrations/:id/violations",
    async (c) =>
      resultJson(
        c,
        await deps.migrations.violations(c.req.param("id"), c.get("auth")),
      ),
  );
  app.get(
    "/api/v1/migrations/:id/sql",
    async (c) =>
      resultJson(
        c,
        await deps.migrations.sql(c.req.param("id"), c.get("auth")),
      ),
  );
  app.post(
    "/api/v1/migrations/:id/validate",
    async (c) =>
      resultJson(
        c,
        await deps.migrations.validate(c.req.param("id"), c.get("auth")),
      ),
  );
  app.post("/api/v1/migrations/:id/apply", async (c) => {
    try {
      const value = await c.req.json();
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("apply body must be an object");
      }
      const body = value as Record<string, unknown>;
      const allowed = new Set([
        "acknowledgement",
        "confirmation_token",
        "lock_timeout",
      ]);
      const unknown = Object.keys(body).filter((key) => !allowed.has(key));
      if (unknown.length) throw new Error(`unknown apply field: ${unknown[0]}`);
      if (
        !(["safe", "reviewed", "destructive"] as unknown[]).includes(
          body.acknowledgement,
        )
      ) {
        throw new Error(
          "acknowledgement must be safe, reviewed, or destructive",
        );
      }
      if (
        body.confirmation_token !== undefined &&
        body.confirmation_token !== null &&
        typeof body.confirmation_token !== "string"
      ) {
        throw new Error("confirmation_token must be a string or null");
      }
      if (
        body.lock_timeout !== undefined && typeof body.lock_timeout !== "string"
      ) {
        throw new Error("lock_timeout must be a string");
      }
      return resultJson(
        c,
        await deps.migrations.apply(
          c.req.param("id"),
          body as {
            acknowledgement: "safe" | "reviewed" | "destructive";
            confirmation_token?: string | null;
            lock_timeout?: string;
          },
          c.get("auth"),
        ),
      );
    } catch (error) {
      return resultJson(
        c,
        err(
          validationError(
            "bad_request",
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    }
  });

  app.get("/api/v1/expressions/help", (c) => {
    const keys = Object.keys(c.req.queries());
    const contexts = c.req.queries().context ?? [];
    if (keys.some((key) => key !== "context") || contexts.length > 1) {
      return resultJson(
        c,
        err(validationError("bad_request", "expression help query is invalid")),
      );
    }
    return resultJson(c, deps.expressions.help(contexts[0] ?? "query"));
  });
  app.post(
    "/api/v1/expressions/validate",
    async (c) =>
      resultJson(c, await deps.expressions.validate(await requestJson(c))),
  );

  app.post("/api/v1/queries", async (c) => {
    const result = await deps.queries.query(
      await requestJson(c),
      c.get("auth"),
    );
    if (!result.ok) return resultJson(c, result);
    const value = result.value;
    return c.json(successEnvelope({
      items: value.items,
      resolved_fields: value.resolved_fields,
      resolved_sort: value.resolved_sort,
    }, {
      next_cursor: value.next_cursor,
      has_more: value.has_more,
      total: value.total,
      policy_context_digest: value.policy_context_digest,
    }));
  });

  app.post("/api/v1/actions/:publisher/:pack/:action/stage", async (c) => {
    const result = await deps.actions.stage(
      c.req.param("publisher"),
      c.req.param("pack"),
      c.req.param("action"),
      await requestJson(c),
      c.get("auth"),
    );
    return result.ok
      ? c.json(
        successEnvelope(result.value),
        result.value && typeof result.value === "object" &&
          (result.value as Record<string, unknown>).stage === null
          ? 200
          : 201,
      )
      : resultJson(c, result);
  });
  app.post("/api/v1/packs/:publisher/:pack/seeds/stage", async (c) => {
    const result = await deps.seeds.stage(
      c.req.param("publisher"),
      c.req.param("pack"),
      await requestJson(c),
      c.get("auth"),
    );
    return result.ok
      ? c.json(
        successEnvelope(result.value),
        result.value && typeof result.value === "object" &&
          (result.value as Record<string, unknown>).stage === null
          ? 200
          : 201,
      )
      : resultJson(c, result);
  });

  app.post("/api/v1/changesets/stage", async (c) => {
    const result = await deps.changesets.stage(
      await requestJson(c),
      c.get("auth"),
    );
    if (result.ok) return c.json(successEnvelope(result.value), 201);
    return resultJson(c, result);
  });
  app.post(
    "/api/v1/changesets/:stage_id/commit",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.commit(
          c.req.param("stage_id"),
          await requestJson(c),
          c.get("auth"),
        ),
      ),
  );
  app.get(
    "/api/v1/changesets/:stage_id",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.inspect(c.req.param("stage_id"), c.get("auth")),
      ),
  );
  app.get(
    "/api/v1/changesets/:stage_id/approvals",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.approvals(c.req.param("stage_id"), c.get("auth")),
      ),
  );
  app.post(
    "/api/v1/changesets/:stage_id/approvals/:requirement_id/decide",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.decideApproval(
          c.req.param("stage_id"),
          c.req.param("requirement_id"),
          await requestJson(c),
          c.get("auth"),
        ),
      ),
  );
  app.post(
    "/api/v1/changesets/:stage_id/cancel",
    async (c) =>
      resultJson(
        c,
        await deps.changesets.cancel(
          c.req.param("stage_id"),
          await requestJson(c),
          c.get("auth"),
        ),
      ),
  );
  const registerObjectReads = (
    kind: "resource" | "relationship",
    plural: "objects" | "relationships",
  ) => {
    const path =
      `/api/v1/projects/:project_id/${plural}/:publisher/:pack/:name/:object_id`;
    const address = (
      c: { req: { param(name: string): string } },
    ): ReadAddress => ({
      projectId: c.req.param("project_id"),
      objectId: c.req.param("object_id"),
      definition: {
        kind,
        publisher: c.req.param("publisher"),
        pack: c.req.param("pack"),
        name: c.req.param("name"),
      },
    });
    app.get(path, async (c) => {
      if (Object.keys(c.req.queries()).length) {
        return resultJson(
          c,
          err(
            validationError(
              "validation_failed",
              "current object reads do not accept query parameters",
            ),
          ),
        );
      }
      return resultJson(
        c,
        await deps.objectReads.read(address(c), c.get("auth")),
      );
    });
    app.get(`${path}/history`, async (c) => {
      const unknown = Object.keys(c.req.queries()).filter((key) =>
        key !== "limit" && key !== "cursor"
      );
      if (unknown.length) {
        return resultJson(
          c,
          err(
            validationError(
              "validation_failed",
              `unknown history query parameter ${unknown[0]}`,
            ),
          ),
        );
      }
      const result = await deps.objectReads.history(address(c), c.get("auth"), {
        limit: c.req.query("limit"),
        cursor: c.req.query("cursor"),
      });
      if (!result.ok) return resultJson(c, result);
      const value = result.value as {
        items: unknown[];
        meta: Record<string, unknown>;
      };
      return c.json(successEnvelope({ items: value.items }, value.meta));
    });
  };
  registerObjectReads("resource", "objects");
  registerObjectReads("relationship", "relationships");

  app.get("/api/v1/outbox", async (c) => {
    const allowed = [
      "status",
      "hook",
      "event",
      "from",
      "to",
      "limit",
      "cursor",
    ];
    const input = c.req.query();
    const unknown = Object.keys(input).find((key) => !allowed.includes(key));
    if (unknown) {
      return resultJson(
        c,
        err(
          validationError(
            "validation_failed",
            `unknown outbox query parameter ${unknown}`,
          ),
        ),
      );
    }
    return resultJson(c, await deps.outbox.list(input, c.get("auth")));
  });
  app.post("/api/v1/outbox/drain", async (c) => {
    const body = await requestJson(c);
    if (Object.keys(body).some((key) => key !== "limit")) {
      throw new RequestValidationError(
        "request body contains unknown fields",
        "unknown_field",
      );
    }
    return resultJson(
      c,
      await deps.outbox.drain(
        typeof body.limit === "number" ? body.limit : undefined,
        c.get("auth"),
      ),
    );
  });
  app.get(
    "/api/v1/outbox/:id",
    async (c) =>
      resultJson(
        c,
        await deps.outbox.inspect(c.req.param("id"), c.get("auth")),
      ),
  );
  app.get("/api/v1/outbox/:id/attempts", async (c) => {
    const input = c.req.query();
    const unknown = Object.keys(input).find((key) =>
      !["limit", "cursor"].includes(key)
    );
    if (unknown) {
      return resultJson(
        c,
        err(
          validationError(
            "validation_failed",
            `unknown attempts query parameter ${unknown}`,
          ),
        ),
      );
    }
    return resultJson(
      c,
      await deps.outbox.attempts(c.req.param("id"), input, c.get("auth")),
    );
  });
  app.post("/api/v1/outbox/:id/retry", async (c) => {
    const body = await requestJson(c);
    if (
      Object.keys(body).some((key) => key !== "reason") ||
      (body.reason !== undefined && typeof body.reason !== "string")
    ) {
      throw new RequestValidationError(
        "request body failed validation",
        "invalid_value",
      );
    }
    return resultJson(
      c,
      await deps.outbox.retry(
        c.req.param("id"),
        body.reason as string | undefined,
        c.get("auth"),
      ),
    );
  });
  app.post("/api/v1/outbox/:id/cancel", async (c) => {
    const body = await requestJson(c);
    if (
      Object.keys(body).some((key) => key !== "reason") ||
      (body.reason !== undefined && typeof body.reason !== "string")
    ) {
      throw new RequestValidationError(
        "request body failed validation",
        "invalid_value",
      );
    }
    return resultJson(
      c,
      await deps.outbox.cancel(
        c.req.param("id"),
        body.reason as string | undefined,
        c.get("auth"),
      ),
    );
  });

  app.get(
    "/api/v1/secrets",
    async (c) =>
      resultJson(c, await deps.secrets.list({ auth: c.get("auth") })),
  );
  app.post("/api/v1/secrets", async (c) => {
    const body = await strictAuthenticatedJson(c, [
      "name",
      "description",
      "value",
    ]);
    return resultJson(c, await deps.secrets.create(body));
  });
  app.post("/api/v1/secrets/:id/rotate", async (c) => {
    const body = await strictAuthenticatedJson(c, ["value"]);
    return resultJson(c, await deps.secrets.rotate(c.req.param("id"), body));
  });
  app.post("/api/v1/secrets/:id/disable", async (c) => {
    const body = await strictAuthenticatedJson(c, []);
    return resultJson(c, await deps.secrets.disable(c.req.param("id"), body));
  });
  app.get(
    "/api/v1/hook-secret-grants",
    async (c) =>
      resultJson(c, await deps.hookSecretGrants.list({ auth: c.get("auth") })),
  );
  app.post(
    "/api/v1/hook-secret-grants",
    async (c) =>
      resultJson(
        c,
        await deps.hookSecretGrants.create(
          await strictAuthenticatedJson(c, [
            "hook_revision_id",
            "expected_security_digest",
            "slot",
            "secret_id",
          ]),
        ),
      ),
  );
  app.post(
    "/api/v1/hook-secret-grants/:id/replace",
    async (c) =>
      resultJson(
        c,
        await deps.hookSecretGrants.replace(
          c.req.param("id"),
          await strictAuthenticatedJson(c, [
            "expected_current_grant_id",
            "secret_id",
          ]),
        ),
      ),
  );
  app.post(
    "/api/v1/hook-secret-grants/:id/revoke",
    async (c) =>
      resultJson(
        c,
        await deps.hookSecretGrants.revoke(
          c.req.param("id"),
          await strictAuthenticatedJson(c, ["reason"]),
        ),
      ),
  );

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
    const invalidRequest = error instanceof RequestValidationError;
    return c.json(
      errorEnvelope({
        code: invalidJson
          ? "invalid_json"
          : invalidRequest
          ? "validation_failed"
          : "internal_error",
        message: invalidJson
          ? "request body is not valid JSON"
          : invalidRequest
          ? "request validation failed"
          : "unexpected server error",
        details: invalidRequest
          ? {
            issues: [{
              path: "/",
              code: error.issueCode,
              message: error.message,
            }],
          }
          : {},
      }),
      invalidJson ? 400 : invalidRequest ? 422 : 500,
    );
  });

  return app;
}

class RequestValidationError extends Error {
  constructor(
    message: string,
    readonly issueCode: "unknown_field" | "invalid_value",
  ) {
    super(message);
  }
}

async function requestJson(c: {
  req: { json(): Promise<unknown> };
}): Promise<Record<string, unknown>> {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SyntaxError("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

async function strictAuthenticatedJson(c: {
  req: { json(): Promise<unknown> };
  get(key: "auth"): AuthVariables["auth"];
}, allowed: string[]): Promise<Record<string, unknown>> {
  const body = await c.req.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SyntaxError("request body must be a JSON object");
  }
  const input = stripAuthority(body) as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !allowed.includes(key))) {
    throw new RequestValidationError(
      "request body contains unknown fields",
      "unknown_field",
    );
  }
  return { ...input, auth: c.get("auth") };
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

function metadataOptions(c: {
  req: {
    queries(): Record<string, string[]>;
    query(name: string): string | undefined;
  };
  get(name: "auth"): AuthVariables["auth"];
}): Result<MetadataOptions> {
  const unknown = Object.keys(c.req.queries()).filter((key) =>
    key !== "project_id" && key !== "include_security"
  );
  if (unknown.length) {
    return err(
      validationError(
        "validation_failed",
        `unknown metadata query parameter ${unknown[0]}`,
      ),
    );
  }
  const include = c.req.query("include_security");
  if (include !== undefined && include !== "true") {
    return err(
      validationError(
        "validation_failed",
        "include_security accepts only the exact value true",
      ),
    );
  }
  const projects = c.req.queries().project_id ?? [];
  const includes = c.req.queries().include_security ?? [];
  if (projects.length > 1 || includes.length > 1) {
    return err(
      validationError(
        "validation_failed",
        "metadata query parameters may appear only once",
      ),
    );
  }
  return {
    ok: true,
    value: {
      auth: c.get("auth"),
      projectId: c.req.query("project_id"),
      includeSecurity: include === "true",
    },
  };
}

async function multipartFiles(request: Request): Promise<UploadedPackFile[]> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;")) {
    throw new Error("pack preview requires multipart/form-data");
  }
  const form = await request.formData();
  const files: UploadedPackFile[] = [];
  for (const [key, value] of form.entries()) {
    if (key !== "file" || !(value instanceof File)) {
      throw new Error("multipart parts must be files named 'file'");
    }
    if (!value.name || value.size === 0) {
      throw new Error("multipart pack files must be non-empty and named");
    }
    files.push({
      path: value.name,
      text: await value.text(),
      kind: value.name.endsWith(".ts") ? "script" : "config",
    });
  }
  return files;
}
