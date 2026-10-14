import { err, ok, type Result, validationError } from "../errors/result.ts";
import type { WorkspaceStatus } from "./model.ts";

export type WorkspaceListFilter = {
  status: WorkspaceStatus | "all";
  slug?: string;
};
export type WorkspaceCursorPosition = { slug: string; id: string };

type CursorPayload = {
  v: 1;
  status: WorkspaceStatus | "all";
  filter_slug: string | null;
  last_slug: string;
  last_id: string;
};

export function encodeWorkspaceCursor(
  filter: WorkspaceListFilter,
  position: WorkspaceCursorPosition,
): string {
  const payload: CursorPayload = {
    v: 1,
    status: filter.status,
    filter_slug: filter.slug ?? null,
    last_slug: position.slug,
    last_id: position.id,
  };
  return encodeBase64Url(JSON.stringify(payload));
}

export function decodeWorkspaceCursor(
  cursor: string,
  filter: WorkspaceListFilter,
): Result<WorkspaceCursorPosition> {
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(cursor));
  } catch {
    return err(validationError(
      "workspace_cursor_invalid",
      "workspace cursor is malformed",
      {},
    ));
  }
  if (!isCursorPayload(payload)) {
    return err(validationError(
      "workspace_cursor_invalid",
      "workspace cursor is malformed",
      {},
    ));
  }
  if (
    payload.status !== filter.status ||
    payload.filter_slug !== (filter.slug ?? null)
  ) {
    return err(validationError(
      "workspace_cursor_mismatch",
      "workspace cursor does not match the list filters",
      {},
    ));
  }
  return ok({ slug: payload.last_slug, id: payload.last_id });
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).sort().join(",") ===
      "filter_slug,last_id,last_slug,status,v" &&
    row.v === 1 && ["active", "archived", "all"].includes(String(row.status)) &&
    (row.filter_slug === null || typeof row.filter_slug === "string") &&
    typeof row.last_slug === "string" && typeof row.last_id === "string";
}

function encodeBase64Url(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("invalid base64url");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const bytes = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  return new TextDecoder().decode(bytes);
}
