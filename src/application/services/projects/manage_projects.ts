import type { ProjectRepository } from "../../ports/project_repository.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import {
  err,
  type Result,
  validationError,
} from "../../../domain/errors/result.ts";
import type { Project, ProjectStatus } from "../../../domain/projects/model.ts";
import {
  validateDescription,
  validateProjectName,
  validateProjectSlug,
} from "../../../domain/projects/model.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";

type ProjectAction =
  | "project.read"
  | "project.create"
  | "project.update"
  | "project.archive";

export function makeProjectService(repository: ProjectRepository) {
  const authorized = (auth: AuthContext, action: ProjectAction): Result<true> =>
    auth.roles.includes("system:super_admin")
      ? { ok: true, value: true }
      : err({
        code: "authorization_insufficient",
        message: `credential is not authorized for ${action}`,
        severity: "authorization",
        details: { action },
      });
  const validId = (id: string): Result<true> =>
    isUuidV7(id) ? { ok: true, value: true } : err(
      validationError("validation_failed", "project_id must be a UUIDv7", {
        field: "project_id",
      }),
    );
  return {
    async create(
      auth: AuthContext,
      input: { slug: unknown; displayName: unknown; description?: unknown },
    ): Promise<Result<Project>> {
      const permit = authorized(auth, "project.create");
      if (!permit.ok) return permit;
      const slug = validateProjectSlug(input.slug);
      if (!slug.ok) return slug;
      const name = validateProjectName(input.displayName);
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
      status: string,
      slug?: string,
    ): Promise<Result<Project[]>> {
      const permit = authorized(auth, "project.read");
      if (!permit.ok) return permit;
      if (!(["active", "archived", "all"] as string[]).includes(status)) {
        return err(
          validationError(
            "validation_failed",
            "status must be active, archived, or all",
            { field: "status" },
          ),
        );
      }
      if (slug !== undefined) {
        const valid = validateProjectSlug(slug);
        if (!valid.ok) return valid;
      }
      return await repository.list(auth, {
        status: status as ProjectStatus | "all",
        slug,
      });
    },
    async get(auth: AuthContext, id: string) {
      const permit = authorized(auth, "project.read");
      if (!permit.ok) return permit;
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
    ): Promise<Result<Project>> {
      const permit = authorized(auth, "project.update");
      if (!permit.ok) return permit;
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
        const name = validateProjectName(input.displayName);
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
    ): Promise<Result<Project>> {
      const permit = authorized(auth, "project.archive");
      if (!permit.ok) return permit;
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
