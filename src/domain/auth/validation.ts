import { err, ok, type Result, validationError } from "../errors/result.ts";

const USERNAME = /^[a-z][a-z0-9._-]{0,62}$/;

export function normalizeUsername(value: unknown): Result<string> {
  if (typeof value !== "string" || !USERNAME.test(value.trim().toLowerCase())) {
    return err(validationError(
      "validation_failed",
      "username must be 1-63 lowercase letters, digits, dot, underscore, or hyphen",
      { field: "username" },
    ));
  }
  return ok(value.trim().toLowerCase());
}

export function validatePassword(value: unknown): Result<string> {
  if (typeof value !== "string") {
    return err(
      validationError("password_policy_failed", "password is required", {
        field: "password",
      }),
    );
  }
  const normalized = value.normalize("NFC");
  const bytes = new TextEncoder().encode(normalized).length;
  if (
    normalized.length < 8 || bytes > 1024 || normalized.trim().length === 0 ||
    /[\n\r\0]/.test(normalized)
  ) {
    return err(validationError(
      "password_policy_failed",
      "password does not satisfy the configured policy",
      { minimum_length: 8, maximum_bytes: 1024 },
    ));
  }
  return ok(normalized);
}

export function validateDisplayName(value: unknown): Result<string> {
  if (typeof value !== "string") {
    return err(
      validationError("validation_failed", "display_name is required", {
        field: "display_name",
      }),
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
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
