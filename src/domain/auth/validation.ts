import { err, ok, type Result, validationError } from "../errors/result.ts";

const USERNAME = /^[a-z][a-z0-9._-]*$/;

export function normalizeUsername(value: unknown): Result<string> {
  const normalized = typeof value === "string"
    ? value.trim().toLowerCase()
    : "";
  if (
    typeof value !== "string" || unicodeLength(normalized) < 1 ||
    unicodeLength(normalized) > 63 || !USERNAME.test(normalized)
  ) {
    return err(validationError(
      "validation_failed",
      "username must be 1-63 lowercase letters, digits, dot, underscore, or hyphen",
      { field: "username" },
    ));
  }
  return ok(normalized);
}

export type PasswordPolicyInput = {
  minimumLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireDigit?: boolean;
  requireSymbol?: boolean;
};

export function validatePassword(
  value: unknown,
  policy: PasswordPolicyInput = {},
): Result<string> {
  if (typeof value !== "string") {
    return err(
      validationError("password_policy_failed", "password is required", {
        field: "password",
      }),
    );
  }
  const normalized = value.normalize("NFC");
  const bytes = new TextEncoder().encode(normalized).length;
  const minimumLength = policy.minimumLength ?? 8;
  if (
    unicodeLength(normalized) < minimumLength || bytes > 1024 ||
    unicodeLength(normalized.trim()) === 0 ||
    /[\n\r\0]/.test(normalized) ||
    (policy.requireUppercase === true && !/\p{Lu}/u.test(normalized)) ||
    (policy.requireLowercase === true && !/\p{Ll}/u.test(normalized)) ||
    (policy.requireDigit === true && !/\p{N}/u.test(normalized)) ||
    (policy.requireSymbol === true && !/[^\p{L}\p{N}\s]/u.test(normalized))
  ) {
    return err(validationError(
      "password_policy_failed",
      "password does not satisfy the configured policy",
      { minimum_length: minimumLength, maximum_bytes: 1024 },
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
