import { canonicalSha256 } from "../ids/canonical_json.ts";

export type OutboxCursorPosition = { created_at: string; id: string };

export async function encodeOutboxCursor(
  position: OutboxCursorPosition,
  filters: Record<string, unknown>,
): Promise<string> {
  const payload = {
    v: 1,
    created_at: position.created_at,
    id: position.id,
    filters: await canonicalSha256(normalizeFilters(filters)),
  };
  return encodeBase64Url(JSON.stringify(payload));
}

export async function decodeOutboxCursor(
  cursor: string,
  filters: Record<string, unknown>,
): Promise<OutboxCursorPosition | null> {
  try {
    const parsed = JSON.parse(decodeBase64Url(cursor));
    if (
      !isRecord(parsed) || Object.keys(parsed).sort().join(",") !==
        "created_at,filters,id,v" ||
      parsed.v !== 1 ||
      typeof parsed.created_at !== "string" ||
      !Number.isFinite(Date.parse(parsed.created_at)) ||
      typeof parsed.id !== "string" || typeof parsed.filters !== "string" ||
      parsed.filters !== await canonicalSha256(normalizeFilters(filters))
    ) {
      return null;
    }
    return { created_at: parsed.created_at, id: parsed.id };
  } catch {
    return null;
  }
}

export function normalizeFilters(
  filters: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) =>
      value !== undefined && value !== null && value !== ""
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid cursor");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(
    Uint8Array.from(binary, (char) => char.charCodeAt(0)),
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
