import { err, type Result } from "../../domain/errors/result.ts";

export function sanitizeOutboxAuthorizationResult<T>(
  result: Result<T>,
): Result<T> {
  if (result.ok || result.error.severity !== "authorization") return result;
  const details = record(result.error.details);
  return err({
    ...result.error,
    details: Object.fromEntries(
      [
        "action",
        "boundary",
        "checked_policies",
        "effective_roles",
        "resource",
      ].filter((key) => Object.hasOwn(details, key)).map((key) => [
        key,
        details[key],
      ]),
    ),
  });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") value = JSON.parse(value);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Application-owned orchestration boundary over the typed outbound port. */
export function makeProcessOutboxService<T extends object>(outbox: T): T {
  return Object.freeze(outbox);
}
