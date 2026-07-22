export const DELIVERY_STATUSES = [
  "pending",
  "running",
  "retry_wait",
  "succeeded",
  "dead_letter",
  "cancelled",
] as const;

export type DeliveryStatus = typeof DELIVERY_STATUSES[number];
export type DeliveryOutcome =
  | { outcome: "succeeded"; summary?: string; external_id?: string }
  | { outcome: "retry"; code: string; message: string; retry_after_ms?: number }
  | { outcome: "dead_letter"; code: string; message: string };

const CODE = /^[a-z][a-z0-9_]{0,127}$/;
const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;
const TEXT_LIMIT = 1_000;
const EXTERNAL_ID_LIMIT = 512;

export function parsePositiveDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DURATION.exec(value);
  if (!match) return null;
  const multiplier = match[2] === "ms"
    ? 1
    : match[2] === "s"
    ? 1_000
    : match[2] === "m"
    ? 60_000
    : 3_600_000;
  const milliseconds = Number(match[1]) * multiplier;
  return Number.isSafeInteger(milliseconds) && milliseconds > 0
    ? milliseconds
    : null;
}

export function parseDeliveryOutput(value: unknown): DeliveryOutcome | null {
  if (!isRecord(value) || typeof value.outcome !== "string") return null;
  if (value.outcome === "succeeded") {
    if (!only(value, ["outcome", "summary", "external_id"])) return null;
    if (
      !optionalText(value.summary, TEXT_LIMIT) ||
      !optionalText(value.external_id, EXTERNAL_ID_LIMIT)
    ) return null;
    return {
      outcome: "succeeded",
      ...(value.summary === undefined
        ? {}
        : { summary: value.summary as string }),
      ...(value.external_id === undefined
        ? {}
        : { external_id: value.external_id as string }),
    };
  }
  if (value.outcome === "retry") {
    if (
      !only(value, ["outcome", "code", "message", "retry_after"]) ||
      !requiredCode(value.code) || !requiredText(value.message, TEXT_LIMIT)
    ) {
      return null;
    }
    const retryAfter = value.retry_after === undefined
      ? undefined
      : parsePositiveDuration(value.retry_after);
    if (value.retry_after !== undefined && retryAfter === null) return null;
    return {
      outcome: "retry",
      code: value.code,
      message: value.message,
      ...(retryAfter === undefined
        ? {}
        : { retry_after_ms: retryAfter as number }),
    };
  }
  if (value.outcome === "dead_letter") {
    if (
      !only(value, ["outcome", "code", "message"]) ||
      !requiredCode(value.code) || !requiredText(value.message, TEXT_LIMIT)
    ) {
      return null;
    }
    return { outcome: "dead_letter", code: value.code, message: value.message };
  }
  return null;
}

export function fullJitterBackoffMs(
  attemptNumber: number,
  random: () => number = Math.random,
  initialMs = 5_000,
  maximumMs = 3_600_000,
): number {
  if (
    !Number.isSafeInteger(attemptNumber) || attemptNumber < 1 ||
    !Number.isSafeInteger(initialMs) || initialMs < 1 ||
    !Number.isSafeInteger(maximumMs) || maximumMs < initialMs
  ) {
    throw new RangeError("invalid retry policy");
  }
  const ceiling = Math.min(
    maximumMs,
    initialMs * 2 ** Math.min(52, attemptNumber - 1),
  );
  const sample = Math.max(0, Math.min(1 - Number.EPSILON, random()));
  return Math.floor(sample * ceiling);
}

export function retryDelayMs(
  attemptNumber: number,
  retryAfterMs: number | undefined,
  maximumRetryAfterMs: number,
  random: () => number,
  initialMs: number,
  maximumMs: number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(maximumRetryAfterMs, retryAfterMs);
  }
  return fullJitterBackoffMs(attemptNumber, random, initialMs, maximumMs);
}

export function boundedEvidence(value: unknown, maximum = TEXT_LIMIT): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return [...text].map((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).slice(0, maximum).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function optionalText(value: unknown, maximum: number): boolean {
  return value === undefined || requiredText(value, maximum);
}
function requiredText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 &&
    [...value].length <= maximum && !value.includes(String.fromCharCode(0));
}
function requiredCode(value: unknown): value is string {
  return typeof value === "string" && CODE.test(value);
}
