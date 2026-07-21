import type { Sql } from "../../../adapters/outbound/postgres/client.ts";
import {
  query,
  quoteIdentifier,
} from "../../../adapters/outbound/postgres/client.ts";
import type { AuthContext } from "../../../domain/auth/model.ts";
import { err, ok, type Result } from "../../../domain/errors/result.ts";
import { canonicalJson } from "../../../domain/ids/canonical_json.ts";
import { isUuidV7 } from "../../../domain/ids/uuid_v7.ts";
import type { StageDto, StageSource } from "../../ports/stage_repository.ts";
import { PostgresAuthorizationRepository } from "../../../adapters/outbound/postgres/authorization_repository.ts";

export type SeedStageDto = {
  status: "staged" | "unchanged";
  project_id: string;
  revision_id: string;
  seed_names: string[];
  stage: StageDto | null;
};

export function makeStageSeedsService(
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
            !["project_id", "all", "names"].includes(key)
          ) ||
          typeof raw.project_id !== "string" || !isUuidV7(raw.project_id) ||
          typeof raw.all !== "boolean" ||
          (raw.names !== undefined &&
            (!Array.isArray(raw.names) ||
              raw.names.some((name) =>
                typeof name !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(name)
              )))
        ) return invalid("seed stage request is invalid");
        const names = (raw.names ?? []) as string[];
        const selectionIssue = validateSeedSelection(raw.all, names);
        if (selectionIssue) return invalid(selectionIssue);
        const revision = (await query<{ id: string; normalized: unknown }>(
          sql,
          `select cr.id,cr.normalized from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
         where ar.publisher=$1 and ar.pack_name=$2`,
          [publisher, pack],
        )).rows[0];
        if (!revision) return invalid("active pack revision was not found");
        const seeds = record(record(revision.normalized).seeds);
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
        const effects = new Map<string, Set<string>>();
        const dependencies: Record<string, unknown>[] = [];
        for (const name of selected) {
          const seed = record(seeds[name]);
          const spec = record(seed.spec);
          const resource = String(spec.resource);
          const key = String(spec.key);
          const identity = resource.includes(":")
            ? resource
            : `${publisher}/${pack}:${resource}`;
          const table = (await query<{ table_name: string }>(
            sql,
            `select table_name from pack_runtime_tables where publisher=$1 and pack_name=$2 and definition_kind='resource' and definition_name=$3`,
            [publisher, pack, resource.split(":").at(-1)],
          )).rows[0]?.table_name;
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
            });
            if (reconciled) operations.push(reconciled);
          }
          const set = effects.get(identity) ?? new Set<string>();
          set.add("create");
          set.add("update");
          effects.set(identity, set);
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
            effects: [...effects].map(([resource, ops]) => ({
              resource,
              ops: [...ops].sort(),
            })),
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
      canonicalJson(current[field]) !== canonicalJson(value)
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
