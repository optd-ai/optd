const DELIVERY_KEYS = [
  "id",
  "event_id",
  "object_version_id",
  "attachment_id",
  "hook_identity",
  "hook_revision_id",
  "candidate_revision_id",
  "script_digest",
  "security_digest",
  "attachment_digest",
  "config_digest",
  "envelope_schema",
  "output_schema",
  "auth_context_id",
  "changeset_commit_id",
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
  "worker_instance_id",
  "hook_revision_id",
  "idempotency_key",
  "started_at",
  "lease_expires_at",
  "completed_at",
  "outcome",
  "error_code",
  "error_message",
  "external_id",
  "hook_execution_id",
] as const;

export function deliveryDto(value: unknown): Record<string, unknown> {
  const dto = select(value, DELIVERY_KEYS);
  const source = record(value);
  if (Object.hasOwn(source, "attempts_by_outcome")) {
    dto.attempts_summary = {
      by_outcome: record(source.attempts_by_outcome),
      latest: source.latest_attempt_id
        ? {
          attempt_id: source.latest_attempt_id,
          outcome: source.latest_outcome ?? null,
          completed_at: source.latest_completed_at ?? null,
        }
        : null,
    };
    const actions = availableActions(String(source.status));
    dto.available_actions = actions;
    dto.help = {
      summary: helpSummary(String(source.status)),
      commands: actions.map((action) => `outbox ${action} ${source.id}`),
    };
  }
  return dto;
}

export function attemptDto(value: unknown): Record<string, unknown> {
  const source = record(value);
  const dto = select(source, ATTEMPT_KEYS);
  dto.state = source.completed_at === null ? "running" : "completed";
  dto.grants = Array.isArray(source.grant_evidence_json)
    ? source.grant_evidence_json.map((item) => {
      const evidence = record(item);
      return select(evidence, [
        "grant_id",
        "slot",
        "secret_id",
        "value_version",
      ]);
    })
    : [];
  return dto;
}

function availableActions(status: string): string[] {
  if (status === "pending" || status === "retry_wait") {
    return ["cancel", "inspect"];
  }
  if (status === "dead_letter" || status === "cancelled") {
    return ["retry", "inspect"];
  }
  return ["inspect"];
}

function helpSummary(status: string): string {
  if (status === "running") return "Delivery is currently being processed.";
  if (status === "retry_wait") {
    return "Delivery is waiting for its next attempt.";
  }
  if (status === "dead_letter") {
    return "Delivery stopped after a permanent or exhausted failure.";
  }
  if (status === "cancelled") {
    return "Delivery was cancelled before completion.";
  }
  if (status === "succeeded") return "Delivery completed successfully.";
  return "Delivery is queued for processing.";
}

function select(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const source = record(value);
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [
      key,
      source[key],
    ]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
