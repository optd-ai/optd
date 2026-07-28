import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { canonicalJson } from "../../../domain/ids/canonical_json.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { StageDto, StageSource } from "../../ports/stage_repository.ts";
import type {
  SeedCatalog,
  SeedReconciliationRepository,
} from "../../ports/repair/seeds.ts";

export type SeedStageDto = {
  status: "staged" | "unchanged";
  project_id: string;
  revision_id: string;
  seed_names: string[];
  stage: StageDto | null;
};

export type ActiveSeedRevision = Readonly<{ id: string; normalized: unknown }>;
export type SeedRowLookup = Readonly<{
  publisher: string;
  pack: string;
  resourceName: string;
  projectId: string;
  key: string;
  value: unknown;
}>;

type FrozenSeedReconciliation = SeedReconciliationRepository<
  SeedRowLookup,
  Record<string, unknown>,
  unknown,
  StageSource,
  AuthContext,
  Result<StageDto | null>
>;

/** Physical capabilities used by the seed reconciliation use case. */
export interface SeedStagePort
  extends SeedCatalog<ActiveSeedRevision>, FrozenSeedReconciliation {
  authorize(
    auth: AuthContext,
    projectId: string,
    action: string,
  ): Promise<Result<void>>;
}

/** Owns seed selection, active-only reconciliation, evidence, and stage orchestration. */
export function makeStageSeedsService(port: SeedStagePort) {
  return Object.freeze({
    async stage(
      publisher: string,
      pack: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<SeedStageDto>> {
      try {
        if (
          !isRecord(raw) || Object.keys(raw).some((key) =>
            !["project_id", "all", "seed_names"].includes(key)
          ) ||
          typeof raw.project_id !== "string" || !isUuidV7(raw.project_id) ||
          typeof raw.all !== "boolean" ||
          (raw.seed_names !== undefined &&
            (!Array.isArray(raw.seed_names) ||
              raw.seed_names.some((name) =>
                typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name)
              )))
        ) {
          return invalid("seed stage request is invalid");
        }
        const names = (raw.seed_names ?? []) as string[];
        const selectionIssue = validateSeedSelection(raw.all, names);
        if (selectionIssue) {
          return invalid(selectionIssue);
        }
        const revision = await port.loadActiveRevision(publisher, pack);
        if (!revision) {
          return invalid("active pack revision was not found");
        }
        const normalized = record(revision.normalized);
        const seeds = record(normalized.seeds);
        const resources = record(normalized.resources);
        const selected = (raw.all ? Object.keys(seeds) : names).sort();
        if (
          !selected.length ||
          selected.some((name) =>
            !Object.keys(record(seeds[name])).length
          )
        ) {
          return invalid("seed selection is empty or unknown");
        }
        for (const name of selected) {
          const action = `seed:${publisher}/${pack}:${name}`;
          const authorized = await port.authorize(auth, raw.project_id, action);
          if (!authorized.ok) return authorized;
        }
        const operations: Record<string, unknown>[] = [];
        const effects: Array<
          { resource: string; ops: string[]; authority_action: string }
        > = [];
        const operationAuthority: Record<string, string> = {};
        const dependencies: Record<string, unknown>[] = [];
        for (const name of selected) {
          const spec = record(record(seeds[name]).spec);
          const resource = String(spec.resource);
          const key = String(spec.key);
          const identity = resource.includes(":")
            ? resource
            : `${publisher}/${pack}:${resource}`;
          const resourceName = resource.split(":").at(-1) ?? resource;
          const fieldDescriptors = record(
            record(record(resources[resourceName]).spec).fields,
          );
          if (!Array.isArray(spec.rows)) {
            return invalid("seed resource is unavailable");
          }
          const ordered = spec.rows.filter(isRecord).sort((a, b) =>
            canonicalJson(a[key]).localeCompare(canonicalJson(b[key]))
          );
          const seen = new Set<string>();
          for (const row of ordered) {
            if (!Object.hasOwn(row, key)) {
              return invalid("seed row omits its required business key");
            }
            const signature = canonicalJson(row[key]);
            if (seen.has(signature)) {
              return invalid("seed contains duplicate business keys");
            }
            seen.add(signature);
            const current = await port.findActiveRow({
              publisher,
              pack,
              resourceName,
              projectId: raw.project_id,
              key,
              value: row[key],
            });
            dependencies.push({
              kind: "uniqueness",
              project_id: raw.project_id,
              definition: identity,
              key,
              value: row[key],
              present: Boolean(current),
              ...(current
                ? {
                  object_id: current.id,
                  expected_version_id: current.current_object_version_id,
                }
                : {}),
            });
            const reconciled = reconcileSeedRow(row, current, {
              operationKey: `${name}_${operations.length}`,
              projectId: raw.project_id,
              resource: identity,
            }, fieldDescriptors);
            if (reconciled) {
              operations.push(reconciled);
              operationAuthority[String(reconciled.key)] =
                `seed:${publisher}/${pack}:${name}`;
            }
          }
          effects.push({
            resource: identity,
            ops: ["create", "update"],
            authority_action: `seed:${publisher}/${pack}:${name}`,
          });
        }
        if (!operations.length) {
          return ok({
            status: "unchanged",
            project_id: raw.project_id,
            revision_id: revision.id,
            seed_names: selected,
            stage: null,
          });
        }
        const source: StageSource = {
          kind: "seed",
          identity: {
            pack: `${publisher}/${pack}`,
            seed_names: selected,
            revision_id: revision.id,
          },
          authority: {
            project_id: raw.project_id,
            actions: selected.map((name) =>
              `seed:${publisher}/${pack}:${name}`
            ),
            revision_id: revision.id,
            effects,
            operation_authority: operationAuthority,
          },
          dependencies,
        };
        const staged = await port.stageSource({ operations }, source, auth);
        if (!staged.ok) return staged;
        return ok({
          status: "staged",
          project_id: raw.project_id,
          revision_id: revision.id,
          seed_names: selected,
          stage: staged.value,
        });
      } catch (error) {
        console.error(error);
        return err({
          code: "internal_error",
          message: "unexpected server error",
          severity: "internal",
          details: {},
        });
      }
    },
  });
}

export function validateSeedSelection(
  all: boolean,
  names: readonly string[],
): string | null {
  return (all && names.length > 0) || (!all && names.length === 0) ||
      new Set(names).size !== names.length
    ? "seed selection must use exactly one of all or unique names"
    : null;
}

export function reconcileSeedRow(
  desired: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  context: {
    operationKey: string;
    projectId: string;
    resource: string;
  },
  fieldDescriptors: Record<string, unknown> = {},
): Record<string, unknown> | null {
  if (!current) {
    return {
      op: "create",
      key: context.operationKey,
      project_id: context.projectId,
      resource: context.resource,
      fields: structuredClone(desired),
    };
  }
  const changed = Object.fromEntries(
    Object.entries(desired).filter(([field, value]) =>
      !seedFieldValuesEqual(
        current[field],
        value,
        record(fieldDescriptors[field]),
      )
    ),
  );
  if (!Object.keys(changed).length) return null;
  return {
    op: "update",
    key: context.operationKey,
    project_id: context.projectId,
    resource: context.resource,
    object_id: current.id,
    expected_version: Number(current.version),
    set: changed,
  };
}

function seedFieldValuesEqual(
  current: unknown,
  desired: unknown,
  descriptor: Record<string, unknown>,
): boolean {
  if (current === null || desired === null) return current === desired;
  if (descriptor.type === "integer") {
    return integerValue(current) !== null &&
      integerValue(current) === integerValue(desired);
  }
  if (descriptor.type === "decimal") {
    return decimalValue(current) !== null &&
      decimalValue(current) === decimalValue(desired);
  }
  if (descriptor.type === "date") {
    return dateValue(current) !== null &&
      dateValue(current) === dateValue(desired);
  }
  if (descriptor.type === "timestamp") {
    return timestampValue(current) !== null &&
      timestampValue(current) === timestampValue(desired);
  }
  return canonicalJson(current) === canonicalJson(desired);
}
function integerValue(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : null;
  }
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)$/.test(value)) {
    return null;
  }
  try {
    return BigInt(value).toString();
  } catch {
    return null;
  }
}
function decimalValue(value: unknown): string | null {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    return null;
  }
  const negative = value.startsWith("-");
  const [rawInteger, rawFraction = ""] = (negative ? value.slice(1) : value)
    .split(".");
  const integer = rawInteger.replace(/^0+(?=\d)/, "");
  const fraction = rawFraction.replace(/0+$/, "");
  const magnitude = fraction ? `${integer}.${fraction}` : integer;
  return `${negative && magnitude !== "0" ? "-" : ""}${magnitude}`;
}
function dateValue(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? value
    : null;
}
function timestampValue(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf())
    ? null
    : date.toISOString().replace(/\.000Z$/, "Z");
}
function invalid(message: string): Result<never> {
  return err({
    code: "validation_failed",
    message,
    severity: "validation",
    details: {},
  });
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
