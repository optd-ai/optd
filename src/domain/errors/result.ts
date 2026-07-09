export type ErrorSeverity =
  | "validation"
  | "not_found"
  | "conflict"
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

export function toHttpStatus(error: StableError): number {
  switch (error.severity) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "internal":
      return 500;
  }
}

export function unwrapOrThrow<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(`${result.error.code}: ${result.error.message}`);
}
