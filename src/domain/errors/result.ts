export type ErrorSeverity =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "expired"
  | "locked"
  | "rate_limited"
  | "unavailable"
  | "internal";

export type StableError = {
  code: string;
  message: string;
  severity: ErrorSeverity;
  details?: unknown;
};

export type Ok<T> = { ok: true; value: T };
export type Err = { ok: false; error: StableError };
export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: StableError): Err {
  return { ok: false, error };
}

export function validationError(
  code: string,
  message: string,
  details?: unknown,
): StableError {
  return { code, message, severity: "validation", details };
}

export function internalError(message: string, details?: unknown): StableError {
  return {
    code: "internal_error",
    message,
    severity: "internal",
    details,
  };
}

const CODE_STATUS = new Map<string, number>([
  ["bad_request", 400],
  ["invalid_json", 400],
  ["invalid_cursor", 400],
  ["authentication_required", 401],
  ["credential_invalid", 401],
  ["session_revoked", 401],
  ["policy_denied", 403],
  ["authorization_insufficient", 403],
  ["not_found", 404],
  ["validation_failed", 422],
  ["changeset_too_large", 422],
  ["no_changes", 422],
  ["hook_rejected", 422],
  ["hook_coordinator_unavailable", 503],
  ["project_inactive", 409],
  ["project_conflict", 409],
  ["operation_conflict", 409],
  ["object_version_conflict", 409],
  ["already_committed", 409],
  ["already_rejected", 409],
  ["stage_cancelled", 409],
  ["stage_stale", 409],
  ["authorization_changed", 403],
  ["authorization_ancestor_invalid", 403],
  ["approval_changed", 409],
  ["constraint_conflict", 409],
  ["commit_retry_exhausted", 409],
  ["commit_busy", 423],
  ["pack_install_busy", 423],
  ["rate_limited", 429],
  ["internal_error", 500],
  ["unavailable", 503],
]);

/** Stable transport classification. Codes are never inferred from message text. */
export function toHttpStatus(error: StableError): number {
  const registered = CODE_STATUS.get(error.code);
  if (registered !== undefined) return registered;
  switch (error.severity) {
    case "validation":
      return 422;
    case "authentication":
      return 401;
    case "authorization":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "expired":
      return 410;
    case "locked":
      return 423;
    case "rate_limited":
      return 429;
    case "unavailable":
      return 503;
    case "internal":
      return 500;
  }
}

export function unwrapOrThrow<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}
