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
  const url = new URL(c.req.url);
  const authorityInput = [...url.searchParams.keys()].some(isAuthorityKey) ||
    [
      "x-operant-actor",
      "x-operant-role",
      "x-actor",
      "x-role",
      "x-roles",
    ].some((name) => c.req.header(name) !== undefined);
  if (authorityInput) {
    return c.json(
      errorEnvelope({
        code: "validation_failed",
        message: "caller-supplied actor or role authority is not accepted",
        details: {},
      }),
      422,
    );
  }
  if (!["GET", "HEAD"].includes(c.req.method)) {
    const contentType = c.req.header("content-type") ?? "";
    const multipart = contentType.toLowerCase().startsWith(
      "multipart/form-data",
    );
    const multipartRoute = c.req.path === "/packs/preview";
    if (multipartRoute !== multipart) {
      return c.json(
        errorEnvelope({
          code: "unsupported_media_type",
          message: multipartRoute
            ? "route requires Content-Type multipart/form-data"
            : "JSON routes require Content-Type application/json",
          details: {},
        }),
        415,
      );
    }
    if (!multipartRoute) {
      if (!isJsonContentType(contentType)) {
        return c.json(
          errorEnvelope({
            code: "unsupported_media_type",
            message: "JSON routes require Content-Type application/json",
            details: {},
          }),
          415,
        );
      }
      const body = await c.req.raw.clone().json().catch(() => undefined);
      if (containsAuthority(body, c.req.path === "/api/v1/auth/requests")) {
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

export function isJsonContentType(value: string): boolean {
  return /^application\/json(?:\s*;|$)/i.test(value.trim());
}

export function isAuthorityKey(key: string): boolean {
  return [
    "actor",
    "actor_id",
    "actor_context",
    "role",
    "roles",
    "effective_roles",
    "principal",
    "principal_id",
  ].includes(key.toLowerCase().replaceAll("-", "_"));
}

export function containsAuthority(
  value: unknown,
  allowRequestedRoles = false,
): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((child) => containsAuthority(child, allowRequestedRoles));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (
      isAuthorityKey(key) && !(allowRequestedRoles && normalized === "roles")
    ) return true;
    if (containsAuthority(child, allowRequestedRoles)) return true;
  }
  return false;
}
