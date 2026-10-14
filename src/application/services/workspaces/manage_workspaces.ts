import type { WorkspaceRepository } from "../../ports/workspace_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  err,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import type {
  Workspace,
  WorkspaceStatus,
} from "../../../domain/workspaces/model.ts";
import {
  decodeWorkspaceCursor,
  encodeWorkspaceCursor,
  type WorkspaceListFilter,
} from "../../../domain/workspaces/pagination.ts";
import {
  validateDescription,
  validateWorkspaceName,
  validateWorkspaceSlug,
} from "../../../domain/workspaces/model.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

export function makeWorkspaceService(repository: WorkspaceRepository) {
  const validId = (id: string): Result<true> =>
    isUuidV7(id) ? { ok: true, value: true } : err(
      validationError("validation_failed", "workspace_id must be a UUIDv7", {
        field: "workspace_id",
      }),
    );
  return {
    async create(
      auth: AuthContext,
      input: { slug: unknown; displayName: unknown; description?: unknown },
    ): Promise<Result<Workspace>> {
      const slug = validateWorkspaceSlug(input.slug);
      if (!slug.ok) return slug;
      const name = validateWorkspaceName(input.displayName);
      if (!name.ok) return name;
      const description = validateDescription(input.description);
      if (!description.ok) return description;
      return await repository.create(auth, {
        slug: slug.value,
        displayName: name.value,
        description: description.value,
      });
    },
    async list(
      auth: AuthContext,
      input: {
        status?: unknown;
        slug?: unknown;
        limit?: unknown;
        cursor?: unknown;
      },
    ): Promise<
      Result<{
        items: Workspace[];
        page: { limit: number; nextCursor: string | null };
      }>
    > {
      const status = input.status ?? "active";
      if (
        typeof status !== "string" ||
        !(["active", "archived", "all"] as string[]).includes(status)
      ) {
        return err(validationError(
          "validation_failed",
          "status must be active, archived, or all",
          { field: "status" },
        ));
      }
      let slug: string | undefined;
      if (input.slug !== undefined) {
        const valid = validateWorkspaceSlug(input.slug);
        if (!valid.ok) return valid;
        slug = valid.value;
      }
      const limit = input.limit === undefined ? 50 : Number(input.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return err(validationError(
          "validation_failed",
          "limit must be an integer from 1 to 100",
          { field: "limit", minimum: 1, maximum: 100 },
        ));
      }
      const filter: WorkspaceListFilter = {
        status: status as WorkspaceStatus | "all",
        ...(slug === undefined ? {} : { slug }),
      };
      let after;
      if (input.cursor !== undefined) {
        if (typeof input.cursor !== "string" || !input.cursor) {
          return err(validationError(
            "workspace_cursor_invalid",
            "workspace cursor is malformed",
            {},
          ));
        }
        const decoded = decodeWorkspaceCursor(input.cursor, filter);
        if (!decoded.ok) return decoded;
        after = decoded.value;
      }
      const result = await repository.list(auth, { filter, limit, after });
      if (!result.ok) return result;
      return {
        ok: true,
        value: {
          items: result.value.items,
          page: {
            limit,
            nextCursor: result.value.nextPosition
              ? encodeWorkspaceCursor(filter, result.value.nextPosition)
              : null,
          },
        },
      };
    },
    async get(auth: AuthContext, id: string) {
      const valid = validId(id);
      if (!valid.ok) return valid;
      return await repository.get(auth, id);
    },
    async update(
      auth: AuthContext,
      id: string,
      input: {
        expectedVersion: unknown;
        displayName?: unknown;
        description?: unknown;
      },
    ): Promise<Result<Workspace>> {
      const valid = validId(id);
      if (!valid.ok) return valid;
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        Number(input.expectedVersion) < 1
      ) {
        return err(
          validationError(
            "validation_failed",
            "expected_version must be a positive integer",
            { field: "expected_version" },
          ),
        );
      }
      if (
        !Object.hasOwn(input, "displayName") &&
        !Object.hasOwn(input, "description")
      ) {
        return err(
          validationError(
            "validation_failed",
            "at least one mutable field is required",
            {},
          ),
        );
      }
      const update: {
        expectedVersion: number;
        displayName?: string;
        description?: string | null;
      } = { expectedVersion: Number(input.expectedVersion) };
      if (Object.hasOwn(input, "displayName")) {
        const name = validateWorkspaceName(input.displayName);
        if (!name.ok) return name;
        update.displayName = name.value;
      }
      if (Object.hasOwn(input, "description")) {
        const description = validateDescription(input.description);
        if (!description.ok) return description;
        update.description = description.value;
      }
      return await repository.update(auth, id, update);
    },
    async archive(
      auth: AuthContext,
      id: string,
      expectedVersion: unknown,
    ): Promise<Result<Workspace>> {
      const valid = validId(id);
      if (!valid.ok) return valid;
      if (
        !Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1
      ) {
        return err(
          validationError(
            "validation_failed",
            "expected_version must be a positive integer",
            { field: "expected_version" },
          ),
        );
      }
      return await repository.archive(auth, id, Number(expectedVersion));
    },
  };
}
