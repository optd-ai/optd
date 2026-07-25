import {
  ObjectReadAuthorityInvalidError,
  type ObjectReadBoundary,
  type ReadAddress,
} from "../../ports/object_reader.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { assertReadAddress } from "../../../domain/objects/read.ts";
import { HistoryCursorSigner } from "../../../domain/history/cursor.ts";
import {
  err,
  ok,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import { evaluateObjectPolicy } from "../query_objects.ts";

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
      try {
        return await deps.boundary.execute(
          auth,
          address,
          async (reader, _authorization, _anchor, sql) => {
            const value = await reader.read(address);
            if (!value) return err(notFound());
            const actions = value.archived_at === null
              ? ["read"]
              : ["read", "read_archived"];
            const policyInput = {
              projectId: address.projectId,
              objectId: address.objectId,
              definition: address.definition,
              actions,
            };
            if (!(await evaluateObjectPolicy(sql, policyInput, auth)).allowed) {
              return err(notFound());
            }
            if (!(await evaluateObjectPolicy(sql, policyInput, auth)).allowed) {
              return err(notFound());
            }
            return ok(value);
          },
        );
      } catch (error) {
        if (error instanceof ObjectReadAuthorityInvalidError) {
          return err(notFound());
        }
        throw error;
      }
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
      try {
        return await deps.boundary.execute(
          auth,
          address,
          async (reader, _authorization, anchor, sql) => {
            const currentObject = await reader.read(address);
            if (!currentObject) return err(notFound());
            const actions = currentObject.archived_at === null
              ? ["read", "history.read"]
              : ["read", "history.read", "read_archived"];
            const policyInput = {
              projectId: address.projectId,
              objectId: address.objectId,
              definition: address.definition,
              actions,
            };
            const authority = await evaluateObjectPolicy(
              sql,
              policyInput,
              auth,
            );
            if (!authority.allowed) return err(notFound());
            let before: { createdAt: string; id: string } | undefined;
            if (input.cursor) {
              try {
                before = await deps.cursors().decode(
                  input.cursor,
                  binding(
                    address,
                    auth,
                    authority.policyDigest,
                    anchor.authorizationRootId,
                    limit,
                  ),
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
            const page = await reader.history(address, limit, before);
            if (!page) return err(notFound());
            const current = await evaluateObjectPolicy(sql, policyInput, auth);
            if (!current.allowed) return err(notFound());
            const next = page.nextPosition
              ? await deps.cursors().encode(
                binding(
                  address,
                  auth,
                  current.policyDigest,
                  anchor.authorizationRootId,
                  limit,
                ),
                page.nextPosition,
              )
              : null;
            return ok({
              items: page.items,
              meta: { next_cursor: next, has_more: page.hasMore },
            });
          },
        );
      } catch (error) {
        if (error instanceof ObjectReadAuthorityInvalidError) {
          return err(notFound());
        }
        throw error;
      }
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
  policyDigest: string,
  authorizationRootId: string,
  limit: number,
) {
  return {
    v: 1,
    project_id: address.projectId,
    definition: address.definition,
    object_id: address.objectId,
    principal_id: auth.principalId,
    authorization_id: auth.authorizationId ?? null,
    authorization_root_id: authorizationRootId,
    policy_digest: policyDigest,
    limit,
  };
}
