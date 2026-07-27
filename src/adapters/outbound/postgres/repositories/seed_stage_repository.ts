import type { Sql } from "../client.ts";
import { query, quoteIdentifier } from "../client.ts";
import type { AuthContext } from "../../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../../domain/errors/result.ts";
import { canonicalJson } from "../../../../domain/ids/canonical_json.ts";
import { isUuidV7 } from "../../../../domain/ids/uuid_v7.ts";
import type {
  StageDto,
  StageSource,
} from "../../../../application/ports/stage_repository.ts";
import { PostgresAuthorizationRepository } from "../authorization_repository.ts";

export type SeedStageDto = {
  status: "staged" | "unchanged";
  project_id: string;
  revision_id: string;
  seed_names: string[];
  stage: StageDto | null;
};

export function makePostgresSeedStageRepository(
  sql: Sql,
  common: {
    stageSource(
      input: unknown,
      source: StageSource,
      auth: AuthContext,
    ): Promise<Result<StageDto | null>>;
  },
) {
  return {
    async stage(
      publisher: string,
      pack: string,
      raw: unknown,
      auth: AuthContext,
    ): Promise<Result<SeedStageDto>> {
      try {
        if (
          !isRecord(raw) ||
          Object.keys(raw).some((key) =>
            !["project_id", "all", "seed_names"].includes(key)
          ) ||
          typeof raw.project_id !== "string" || !isUuidV7(raw.project_id) ||
          typeof raw.all !== "boolean" ||
          (raw.seed_names !== undefined &&
            (!Array.isArray(raw.seed_names) ||
              raw.seed_names.some((name) =>
                typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name)
              )))
        ) return invalid("seed stage request is invalid");
        const names = (raw.seed_names ?? []) as string[];
        const selectionIssue = validateSeedSelection(raw.all, names);
        if (selectionIssue) return invalid(selectionIssue);
        const revision = (await query<{ id: string; normalized: unknown }>(
          sql,
          `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
         where ar.publisher=$1 and ar.pack_name=$2`,
          [publisher, pack],
        )).rows[0];
        if (!revision) return invalid("active pack revision was not found");
        const normalized = record(revision.normalized);
        const seeds = record(normalized.seeds);
        const resources = record(normalized.resources);
        const selected = (raw.all ? Object.keys(seeds) : names).sort();
        if (
          !selected.length || selected.some((name) => !record(seeds[name]))
        ) return invalid("seed selection is empty or unknown");
        for (const name of selected) {
          const semantic = `seed:${publisher}/${pack}:${name}`;
          const authority = await new PostgresAuthorizationRepository(sql)
            .authorize({
              auth,
              boundary: { type: "project", projectId: raw.project_id },
              action: semantic,
              resource: semantic,
            });
          if (!authority.ok) return authority;
        }
        const operations: Record<string, unknown>[] = [];
        const effects: Array<
          { resource: string; ops: string[]; authority_action: string }
        > = [];
        const operationAuthority: Record<string, string> = {};
        const dependencies: Record<string, unknown>[] = [];
        for (const name of selected) {
          const seed = record(seeds[name]);
          const spec = record(seed.spec);
          const resource = String(spec.resource);
          const key = String(spec.key);
          const identity = resource.includes(":")
            ? resource
            : `${publisher}/${pack}:${resource}`;
          const resourceName = resource.split(":").at(-1) ?? resource;
          const table = (await query<{ table_name: string }>(
            sql,
            `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
            [publisher, pack, resourceName],
          )).rows[0]?.table_name;
          const fieldDescriptors = record(
            record(record(resources[resourceName]).spec).fields,
          );
          if (!table || !Array.isArray(spec.rows)) {
            return invalid(
              "seed resource is unavailable",
            );
          }
          const ordered = [...spec.rows].filter((
            value,
          ): value is Record<string, unknown> => isRecord(value)).sort((a, b) =>
            canonicalJson(a[key]).localeCompare(canonicalJson(b[key]))
          );
          const seen = new Set<string>();
          for (const row of ordered) {
            if (!Object.hasOwn(row, key)) {
              return invalid(
                "seed row omits its required business key",
              );
            }
            const signature = canonicalJson(row[key]);
            if (seen.has(signature)) {
              return invalid(
                "seed contains duplicate business keys",
              );
            }
            seen.add(signature);
            const current = (await query<Record<string, unknown>>(
              sql,
              `select * from ${
                quoteIdentifier(table)
              } where project_id=$1 and ${quoteIdentifier(key)}=$2 for share`,
              [raw.project_id, row[key]],
            )).rows[0];
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
        const staged = await common.stageSource({ operations }, source, auth);
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
  };
}
export function validateSeedSelection(
  all: boolean,
  names: readonly string[],
): string | null {
  if (
    (all && names.length > 0) || (!all && names.length === 0) ||
    new Set(names).size !== names.length
  ) {
    return "seed selection must use exactly one of all or unique names";
  }
  return null;
}

export function reconcileSeedRow(
  desired: Record<string, unknown>,
  current: Record<string, unknown> | undefined,
  context: { operationKey: string; projectId: string; resource: string },
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
  switch (descriptor.type) {
    case "integer":
      return integerValue(current) !== null &&
        integerValue(current) === integerValue(desired);
    case "decimal":
      return decimalValue(current) !== null &&
        decimalValue(current) === decimalValue(desired);
    case "date":
      return dateValue(current) !== null &&
        dateValue(current) === dateValue(desired);
    case "timestamp":
      return timestampValue(current) !== null &&
        timestampValue(current) === timestampValue(desired);
    default:
      return canonicalJson(current) === canonicalJson(desired);
  }
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
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger, rawFraction = ""] = unsigned.split(".");
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
  if (Number.isNaN(date.valueOf())) return null;
  return date.toISOString().replace(/\.000Z$/, "Z");
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
