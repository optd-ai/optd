import type { Hono } from "npm:hono";
import type { Result } from "../../../domain/errors/result.ts";
import type { BootstrapResult } from "../../../domain/auth/model.ts";
import {
  errorEnvelope,
  successEnvelope,
} from "../../../schemas/api/contracts.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";
import type { AuthVariables } from "./auth_middleware.ts";

export type BootstrapHttpService = {
  required(): Promise<boolean>;
  initialize(
    input: {
      bootstrapToken: string;
      username: unknown;
      displayName: unknown;
      password: unknown;
    },
  ): Promise<Result<BootstrapResult>>;
};

export function registerAuthRoutes(
  app: Hono<{ Variables: AuthVariables }>,
  service: BootstrapHttpService,
) {
  app.get(
    "/api/v1/auth/bootstrap/status",
    async (c) =>
      c.json(
        successEnvelope({
          status: await service.required() ? "bootstrap_required" : "ready",
        }),
      ),
  );
  app.post("/api/v1/auth/bootstrap", async (c) => {
    const authorization = c.req.header("authorization") ?? "";
    const match = /^Operant-Bootstrap (.+)$/.exec(authorization);
    const body = await c.req.json().catch(() => undefined);
    if (
      !strictObject(body, ["username", "display_name", "password"], [
        "username",
        "password",
      ])
    ) {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "bootstrap request is invalid",
          details: {},
        }),
        422,
      );
    }
    const result = await service.initialize({
      bootstrapToken: match?.[1] ?? "",
      username: body.username,
      displayName: body.display_name ?? body.username,
      password: body.password,
    });
    if (!result.ok) {
      return c.json(
        errorEnvelope(result.error),
        toHttpStatus(result.error) as 400,
      );
    }
    return c.json(
      successEnvelope({
        user: {
          id: result.value.user.id,
          principal_id: result.value.user.principalId,
          username: result.value.user.username,
          display_name: result.value.user.displayName,
        },
        credentials: {
          token: result.value.credentials.token,
          authorization_request_token: result.value.credentials.requestToken,
        },
      }),
      201,
    );
  });
}

export function strictObject(
  value: unknown,
  allowed: string[],
  required: string[] = [],
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(value, key));
}
