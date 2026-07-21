import { canonicalJson } from "../ids/canonical_json.ts";
import { uuidV7 } from "../ids/uuid_v7.ts";

export type ApprovalBoundary =
  | Readonly<{ type: "project"; project_id: string }>
  | Readonly<{ type: "all_projects" }>
  | Readonly<{ type: "system" }>;

export type ApprovalRequirement = Readonly<{
  id: string;
  key: string;
  role: string;
  boundary: ApprovalBoundary;
  minimum: number;
  principal_types: readonly ("human_user" | "agent_user")[];
  allow_initiator: boolean;
  expires_at: string | null;
  reason: string;
}>;

export class ApprovalContractError extends Error {
  constructor(readonly path: string, message: string) {
    super(message);
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[a-z][a-z0-9_]{0,62}$/;
const ROLE =
  /^(?:system:[a-z][a-z0-9_]{0,62}|[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9_]{0,62}:[a-z][a-z0-9_]{0,62})$/;

/** Canonicalize trusted hook requirements before they enter immutable evidence. */
export function canonicalizeApprovalRequirements(
  values: readonly unknown[],
  affectedProjects: ReadonlySet<string>,
  createdAt = new Date(),
  maximumWindowMs = 30 * 24 * 60 * 60 * 1000,
): ApprovalRequirement[] {
  const byKey = new Map<string, ApprovalRequirement>();
  values.forEach((raw, index) => {
    const path = `/approval_requirements/${index}`;
    if (!record(raw)) {
      throw new ApprovalContractError(path, "requirement must be an object");
    }
    const allowed = new Set([
      "id",
      "key",
      "role",
      "boundary",
      "minimum",
      "principal_types",
      "allow_initiator",
      "expires_at",
      "reason",
    ]);
    const unknown = Object.keys(raw).find((key) => !allowed.has(key));
    if (unknown) {
      throw new ApprovalContractError(
        `${path}/${unknown}`,
        "unknown requirement field",
      );
    }
    if (
      raw.id !== undefined && (typeof raw.id !== "string" || !UUID.test(raw.id))
    ) {
      throw new ApprovalContractError(
        `${path}/id`,
        "id must be a lowercase UUIDv7",
      );
    }
    if (typeof raw.key !== "string" || !KEY.test(raw.key)) {
      throw new ApprovalContractError(
        `${path}/key`,
        "key must be lowercase snake case",
      );
    }
    if (
      typeof raw.role !== "string" || !ROLE.test(raw.role) ||
      raw.role.includes("*")
    ) {
      throw new ApprovalContractError(
        `${path}/role`,
        "role must be one exact global role identity",
      );
    }
    if (!record(raw.boundary)) {
      throw new ApprovalContractError(
        `${path}/boundary`,
        "boundary is required",
      );
    }
    const boundary = canonicalBoundary(raw.boundary, path, affectedProjects);
    const minimum = raw.minimum === undefined ? 1 : raw.minimum;
    if (
      !Number.isInteger(minimum) || Number(minimum) < 1 || Number(minimum) > 10
    ) {
      throw new ApprovalContractError(
        `${path}/minimum`,
        "minimum must be an integer from 1 through 10",
      );
    }
    const types = raw.principal_types === undefined
      ? ["human_user"]
      : raw.principal_types;
    if (
      !Array.isArray(types) || types.length === 0 ||
      types.some((value) => value !== "human_user" && value !== "agent_user")
    ) {
      throw new ApprovalContractError(
        `${path}/principal_types`,
        "principal_types must be a non-empty allowed set",
      );
    }
    const principalTypes = [
      ...new Set(types as ("human_user" | "agent_user")[]),
    ].sort();
    const allowInitiator = raw.allow_initiator === undefined
      ? false
      : raw.allow_initiator;
    if (typeof allowInitiator !== "boolean") {
      throw new ApprovalContractError(
        `${path}/allow_initiator`,
        "allow_initiator must be boolean",
      );
    }
    if (
      typeof raw.reason !== "string" || raw.reason.trim().length === 0 ||
      new TextEncoder().encode(raw.reason).byteLength > 4096
    ) {
      throw new ApprovalContractError(
        `${path}/reason`,
        "reason must be non-empty bounded safe text",
      );
    }
    let expiresAt: string | null = null;
    if (raw.expires_at !== undefined && raw.expires_at !== null) {
      if (typeof raw.expires_at !== "string") {
        throw new ApprovalContractError(
          `${path}/expires_at`,
          "expires_at must be an RFC 3339 instant or null",
        );
      }
      const parsed = new Date(raw.expires_at);
      if (
        !Number.isFinite(parsed.getTime()) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(raw.expires_at)
      ) {
        throw new ApprovalContractError(
          `${path}/expires_at`,
          "expires_at must be an RFC 3339 UTC instant",
        );
      }
      if (
        parsed <= createdAt ||
        parsed.getTime() - createdAt.getTime() > maximumWindowMs
      ) {
        throw new ApprovalContractError(
          `${path}/expires_at`,
          "expires_at is outside the allowed future window",
        );
      }
      expiresAt = parsed.toISOString();
    }
    const requirement: ApprovalRequirement = {
      id: typeof raw.id === "string" ? raw.id : uuidV7(),
      key: raw.key,
      role: raw.role,
      boundary,
      minimum: Number(minimum),
      principal_types: principalTypes,
      allow_initiator: allowInitiator,
      expires_at: expiresAt,
      reason: raw.reason,
    };
    const existing = byKey.get(requirement.key);
    if (existing) {
      const withoutId = (value: ApprovalRequirement) =>
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "id"),
        );
      if (
        canonicalJson(withoutId(existing)) !==
          canonicalJson(withoutId(requirement))
      ) {
        throw new ApprovalContractError(
          `${path}/key`,
          "requirements with the same key conflict",
        );
      }
    } else byKey.set(requirement.key, requirement);
  });
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function canonicalBoundary(
  value: Record<string, unknown>,
  path: string,
  projects: ReadonlySet<string>,
): ApprovalBoundary {
  if (
    value.type === "project" &&
    Object.keys(value).every((key) => key === "type" || key === "project_id") &&
    typeof value.project_id === "string" && UUID.test(value.project_id)
  ) {
    if (!projects.has(value.project_id)) {
      throw new ApprovalContractError(
        `${path}/boundary/project_id`,
        "project boundary is not affected by this stage",
      );
    }
    return { type: "project", project_id: value.project_id };
  }
  if (
    (value.type === "all_projects" || value.type === "system") &&
    Object.keys(value).length === 1
  ) return { type: value.type };
  throw new ApprovalContractError(
    `${path}/boundary`,
    "boundary must be exactly project, all_projects, or system",
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
