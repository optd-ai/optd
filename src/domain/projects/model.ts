import { err, ok, type Result, validationError } from "../errors/result.ts";

export type ProjectStatus = "active" | "archived";
export type Project = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  status: ProjectStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

const SLUG = /^[a-z][a-z0-9-]*$/;

export function validateProjectSlug(value: unknown): Result<string> {
  if (
    typeof value !== "string" || unicodeLength(value) < 1 ||
    unicodeLength(value) > 63 || !SLUG.test(value)
  ) {
    return err(
      validationError(
        "validation_failed",
        "slug must match [a-z][a-z0-9-]{0,62}",
        { field: "slug" },
      ),
    );
  }
  return ok(value);
}

export function validateProjectName(value: unknown): Result<string> {
  if (typeof value !== "string") {
    return err(
      validationError("validation_failed", "display_name is required", {
        field: "display_name",
      }),
    );
  }
  const trimmed = value.trim();
  if (unicodeLength(trimmed) < 1 || unicodeLength(trimmed) > 120) {
    return err(
      validationError(
        "validation_failed",
        "display_name must be 1-120 characters",
        { field: "display_name" },
      ),
    );
  }
  return ok(trimmed);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function validateDescription(value: unknown): Result<string | null> {
  if (value === null || value === undefined) return ok(null);
  if (
    typeof value !== "string" || new TextEncoder().encode(value).length > 16_384
  ) {
    return err(
      validationError(
        "validation_failed",
        "description must not exceed 16384 bytes",
        { field: "description" },
      ),
    );
  }
  return ok(value);
}
