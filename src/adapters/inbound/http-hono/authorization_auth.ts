import type { Context, Next } from "npm:hono";
import type { RequestAuthenticator } from "../../../application/ports/authentication.ts";
import { errorEnvelope } from "../../../schemas/api/contracts.ts";
import { toHttpStatus } from "../../../domain/errors/result.ts";
import type { AuthVariables } from "./auth_middleware.ts";

export async function requireAssignmentBearer(
  authenticator: RequestAuthenticator,
  c: Context<{ Variables: AuthVariables }>,
  next: Next,
) {
  const body = await c.req.raw.clone().json().catch(() => undefined);
  if (containsInjectedAuthority(body)) {
    return c.json(
      errorEnvelope({
        code: "validation_failed",
        message:
          "caller-supplied actor or effective-role authority is not accepted",
        details: {},
      }),
      422,
    );
  }
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(
    c.req.header("authorization") ?? "",
  );
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
  if (result.value.credentialKind === "authorization_request") {
    return c.json(
      errorEnvelope({
        code: "authorization_insufficient",
        message:
          "authorization-request credentials cannot administer assignments",
        details: { credential_kind: result.value.credentialKind },
      }),
      403,
    );
  }
  c.set("auth", result.value);
  await next();
}

function containsInjectedAuthority(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((item) => containsInjectedAuthority(item, depth + 1));
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replaceAll("-", "_");
    if (
      [
        "actor",
        "actor_id",
        "actor_context",
        "principal",
        "principal_id",
        "roles",
        "effective_roles",
        "attributes",
      ].includes(normalized)
    ) return true;
    // `role` is immutable assignment content only at the request root.
    if (normalized === "role" && depth > 0) return true;
    if (containsInjectedAuthority(child, depth + 1)) return true;
  }
  return false;
}
