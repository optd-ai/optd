import type { Context, Next } from "npm:hono";
import type { RequestAuthenticator } from "../../../application/ports/authentication.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { errorEnvelope } from "../../../schemas/api/contracts.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";

export type AuthVariables = { auth: AuthContext };

export async function requireBearer(
  authenticator: RequestAuthenticator,
  c: Context<{ Variables: AuthVariables }>,
  next: Next,
) {
  const authorityInput = c.req.query("actor") ?? c.req.query("role") ??
    c.req.header("x-operant-actor") ?? c.req.header("x-operant-role");
  if (authorityInput !== undefined) {
    return c.json(
      errorEnvelope({
        code: "validation_failed",
        message: "caller-supplied actor or role authority is not accepted",
        details: {},
      }),
      422,
    );
  }
  if ((c.req.header("content-type") ?? "").startsWith("application/json")) {
    const body = await c.req.raw.clone().json().catch(() => undefined);
    if (containsAuthority(body)) {
      return c.json(
        errorEnvelope({
          code: "validation_failed",
          message: "caller-supplied actor or role authority is not accepted",
          details: {},
        }),
        422,
      );
    }
  }
  const authorization = c.req.header("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization);
  if (!match) {
    return c.json(
      errorEnvelope({
        code: "authentication_required",
        message: "a bearer credential is required",
        details: {},
      }),
      401,
    );
  }
  const result = await authenticator.authenticate(match[1]);
  if (!result.ok) {
    return c.json(
      errorEnvelope(result.error),
      toHttpStatus(result.error) as 400,
    );
  }
  if (
    result.value.credentialKind === "authorization_request" &&
    !c.req.path.startsWith("/api/v1/auth/")
  ) {
    return c.json(
      errorEnvelope({
        code: "authorization_insufficient",
        message:
          "authorization-request credentials cannot perform platform work",
        details: { credential_kind: result.value.credentialKind },
      }),
      403,
    );
  }
  c.set("auth", result.value);
  await next();
}

export function serverActor(auth: AuthContext) {
  return {
    id: auth.principalId,
    roles: auth.roles.map((role) =>
      role === "system:super_admin" ? "super_admin" : role
    ),
    auth_context_id: auth.id,
    principal_type: auth.principalType,
    human_user_id: auth.humanUserId,
  };
}

function containsAuthority(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsAuthority);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === "actor" || key === "actor_id" || key === "role" || key === "roles"
    ) return true;
    if (containsAuthority(child)) return true;
  }
  return false;
}
