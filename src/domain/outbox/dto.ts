const DELIVERY_KEYS = [
  "id",
  "event_id",
  "attachment_id",
  "hook_identity",
  "hook_revision_id",
  "candidate_revision_id",
  "status",
  "retry_generation",
  "attempts_in_generation",
  "total_attempts",
  "max_attempts",
  "available_at",
  "last_error_code",
  "last_error_message",
  "created_at",
  "updated_at",
] as const;
const ATTEMPT_KEYS = [
  "id",
  "retry_generation",
  "attempt_number",
  "total_attempt_number",
  "started_at",
  "lease_expires_at",
  "completed_at",
  "outcome",
  "error_code",
  "error_message",
  "external_id",
] as const;

export function deliveryDto(value: unknown): Record<string, unknown> {
  return select(value, DELIVERY_KEYS);
}
export function attemptDto(value: unknown): Record<string, unknown> {
  return select(value, ATTEMPT_KEYS);
}

function select(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((
      key,
    ) => [key, source[key]]),
  );
}
