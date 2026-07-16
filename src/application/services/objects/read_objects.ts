import type { AuthorizationRepository } from "../../ports/authorization.ts";
import type { ObjectReader, ReadAddress } from "../../ports/object_reader.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { BoundaryAuthority } from "../../../domain/authorization/model.ts";
import {
  assertReadAddress,
  qualifiedIdentity,
} from "../../../domain/objects/read.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";

export function makeObjectReadService(
  deps: { reader: ObjectReader; authorization: AuthorizationRepository },
) {
  return {
    async read(
      address: ReadAddress,
      auth: AuthContext,
    ): Promise<Result<unknown>> {
      try {
        assertAddress(address);
      } catch (error) {
        return err(validationError("bad_request", message(error)));
      }
      const authority = await deps.authorization.authority(auth, {
        type: "project",
        projectId: address.projectId,
      });
      if (
        !authority.ok ||
        !allowed(authority.value, "read", qualifiedIdentity(address.definition))
      ) return err(notFound());
      const value = await deps.reader.read(address);
      if (!value) return err(notFound());
      if (
        value.archived_at !== null &&
        !allowed(
          authority.value,
          "read_archived",
          qualifiedIdentity(address.definition),
        )
      ) return err(notFound());
      return ok(value);
    },
    async history(
      address: ReadAddress,
      auth: AuthContext,
      input: { limit?: string; cursor?: string },
    ): Promise<Result<unknown>> {
      try {
        assertAddress(address);
      } catch (error) {
        return err(validationError("bad_request", message(error)));
      }
      const limit = input.limit === undefined ? 50 : Number(input.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return err(
          validationError(
            "bad_request",
            "limit must be an integer from 1 through 100",
          ),
        );
      }
      const resource = qualifiedIdentity(address.definition);
      const authority = await deps.authorization.authority(auth, {
        type: "project",
        projectId: address.projectId,
      });
      if (
        !authority.ok || !allowed(authority.value, "read", resource) ||
        !allowed(authority.value, "history.read", resource)
      ) return err(notFound());
      let before: { createdAt: string; id: string } | undefined;
      if (input.cursor) {
        try {
          before = await decodeCursor(
            input.cursor,
            binding(address, auth, authority.value, limit),
          );
        } catch {
          return err(
            validationError(
              "invalid_cursor",
              "history cursor is invalid or does not match this request",
            ),
          );
        }
      }
      const current = await deps.reader.read(address);
      if (!current) return err(notFound());
      if (
        current.archived_at !== null &&
        !allowed(authority.value, "read_archived", resource)
      ) return err(notFound());
      const page = await deps.reader.history(address, limit, before);
      if (!page) return err(notFound());
      const next = page.nextPosition
        ? await encodeCursor(
          binding(address, auth, authority.value, limit),
          page.nextPosition,
        )
        : null;
      return ok({
        items: page.items,
        meta: { next_cursor: next, has_more: page.hasMore },
      });
    },
  };
}

function assertAddress(address: ReadAddress) {
  assertReadAddress({
    projectId: address.projectId,
    objectId: address.objectId,
    ...address.definition,
  });
}
function allowed(
  authority: BoundaryAuthority,
  action: string,
  resource: string,
): boolean {
  return authority.superAdmin ||
    authority.capabilities.some((capability) =>
      capability.condition === "unconditional" &&
      capability.action === action &&
      (capability.resource === "*" || capability.resource === resource)
    );
}
function notFound() {
  return {
    code: "not_found",
    message: "object not found",
    severity: "not_found" as const,
    details: {},
  };
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function binding(
  address: ReadAddress,
  auth: AuthContext,
  authority: BoundaryAuthority,
  limit: number,
) {
  return {
    v: 1,
    project_id: address.projectId,
    definition: address.definition,
    object_id: address.objectId,
    principal_id: auth.principalId,
    authorization_id: auth.authorizationId ?? null,
    policy_digest: authority.digest,
    limit,
  };
}
async function encodeCursor(
  bound: unknown,
  position: { createdAt: string; id: string },
): Promise<string> {
  const payload = { bound, created_at: position.createdAt, id: position.id };
  const digest = await sha(payload);
  return base64Url(JSON.stringify({ ...payload, digest }));
}
async function decodeCursor(
  cursor: string,
  expected: unknown,
): Promise<{ createdAt: string; id: string }> {
  if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new Error("bad cursor");
  }
  const value = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(
          cursor.replaceAll("-", "+").replaceAll("_", "/") +
            "===".slice((cursor.length + 3) % 4),
        ),
        (c) => c.charCodeAt(0),
      ),
    ),
  );
  if (
    !value ||
    Object.keys(value).sort().join(",") !== "bound,created_at,digest,id" ||
    JSON.stringify(value.bound) !== JSON.stringify(expected)
  ) throw new Error("cursor mismatch");
  if (
    typeof value.created_at !== "string" || typeof value.id !== "string" ||
    typeof value.digest !== "string"
  ) throw new Error("bad cursor");
  if (
    value.digest !==
      await sha({
        bound: value.bound,
        created_at: value.created_at,
        id: value.id,
      })
  ) throw new Error("cursor digest");
  assertReadAddress({
    projectId: value.id,
    objectId: value.id,
    publisher: "a",
    pack: "a",
    name: "a",
  });
  if (!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.created_at)) {
    throw new Error("bad timestamp");
  }
  return { createdAt: value.created_at, id: value.id };
}
async function sha(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return "sha256:" +
    [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}
