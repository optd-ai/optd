import type {
  ObjectReadBoundary,
  ReadAddress,
} from "../../ports/object_reader.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import type { BoundaryAuthority } from "../../../domain/authorization/model.ts";
import {
  assertReadAddress,
  qualifiedIdentity,
} from "../../../domain/objects/read.ts";
import { HistoryCursorSigner } from "../../../domain/history/cursor.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";

export function makeObjectReadService(deps: {
  boundary: ObjectReadBoundary;
  cursors: () => HistoryCursorSigner;
}) {
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
      return await deps.boundary.execute(
        auth,
        address,
        async (reader, authorization) => {
          const resource = qualifiedIdentity(address.definition);
          const authority = await authorization.authority(auth, {
            type: "project",
            projectId: address.projectId,
          });
          if (
            !authority.ok || !allowed(authority.value, "read", resource)
          ) return err(notFound());
          const value = await reader.read(address);
          if (
            !value ||
            (value.archived_at !== null &&
              !allowed(authority.value, "read_archived", resource))
          ) return err(notFound());
          const current = await authorization.authority(auth, {
            type: "project",
            projectId: address.projectId,
          });
          if (
            !current.ok || !allowed(current.value, "read", resource) ||
            (value.archived_at !== null &&
              !allowed(current.value, "read_archived", resource))
          ) return err(notFound());
          return ok(value);
        },
      );
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
      return await deps.boundary.execute(
        auth,
        address,
        async (reader, authorization) => {
          const resource = qualifiedIdentity(address.definition);
          const authority = await authorization.authority(auth, {
            type: "project",
            projectId: address.projectId,
          });
          if (
            !authority.ok || !historyAllowed(authority.value, resource)
          ) return err(notFound());
          let before: { createdAt: string; id: string } | undefined;
          if (input.cursor) {
            try {
              before = await deps.cursors().decode(
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
          const currentObject = await reader.read(address);
          if (
            !currentObject ||
            (currentObject.archived_at !== null &&
              !allowed(authority.value, "read_archived", resource))
          ) return err(notFound());
          const page = await reader.history(address, limit, before);
          if (!page) return err(notFound());
          const current = await authorization.authority(auth, {
            type: "project",
            projectId: address.projectId,
          });
          if (
            !current.ok || !historyAllowed(current.value, resource) ||
            (currentObject.archived_at !== null &&
              !allowed(current.value, "read_archived", resource))
          ) return err(notFound());
          const next = page.nextPosition
            ? await deps.cursors().encode(
              binding(address, auth, current.value, limit),
              page.nextPosition,
            )
            : null;
          return ok({
            items: page.items,
            meta: { next_cursor: next, has_more: page.hasMore },
          });
        },
      );
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
function historyAllowed(authority: BoundaryAuthority, resource: string) {
  return allowed(authority, "read", resource) &&
    allowed(authority, "history.read", resource);
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
