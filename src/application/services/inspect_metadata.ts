import type { Clock } from "../ports/clock.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";
import { query } from "../../adapters/outbound/postgres/client.ts";
import {
  getActivePack,
  getDefinition,
  getPack,
  listPacks,
} from "../../adapters/outbound/postgres/pack_repository.ts";
import {
  err,
  ok,
  type Result,
  type StableError,
} from "../../domain/errors/result.ts";

export type HomeDto = {
  version: string;
  generated_at: string;
  system: { active_pack: string | null };
  resources: string[];
  actions: string[];
  status: "ready";
  capabilities: string[];
  help: string[];
};

export function makeInspectMetadataService(
  deps: { sql: Queryable; clock: Clock; version: string },
) {
  return {
    async home(): Promise<Result<HomeDto>> {
      const pack = await getActivePack(deps.sql) as
        | Record<string, unknown>
        | null;
      const manifest = jsonRecord(pack?.manifest);
      const spec = isRecord(manifest.spec) ? manifest.spec : {};
      const axi = isRecord(spec.axi) ? spec.axi : {};
      const home = isRecord(axi.home) ? axi.home : {};
      const revision = typeof pack?.revision === "string"
        ? pack.revision
        : null;
      const resources = revision
        ? (await query<{ namespace: string; name: string }>(
          deps.sql,
          "select namespace,name from resource_definitions where revision=$1 order by name",
          [revision],
        )).rows.map((r) => `${r.namespace}.${r.name}`)
        : [];
      const actions = revision
        ? (await query<{ namespace: string; name: string }>(
          deps.sql,
          "select namespace,name from action_definitions where revision=$1 order by name",
          [revision],
        )).rows.map((r) => `${r.namespace}.${r.name}`)
        : [];
      return ok({
        version: deps.version,
        generated_at: deps.clock.now().toISOString(),
        system: {
          active_pack: pack
            ? `${pack.namespace}.${pack.name}@${pack.version}`
            : null,
        },
        resources: preferred(home.resources, resources),
        actions: preferred(home.actions, actions),
        status: "ready",
        capabilities: [
          "health",
          "metadata.home",
          "packs.preview",
          "packs.apply",
        ],
        help: preferred(home.help, [
          "optctl pack preview <pack-dir> --json",
          "optctl metadata resource <namespace.resource>",
        ]),
      });
    },
    async packs(): Promise<Result<unknown>> {
      return ok({ packs: await listPacks(deps.sql) });
    },
    async pack(namespace: string, name: string): Promise<Result<unknown>> {
      const pack = await getPack(deps.sql, namespace, name);
      if (!pack) return err(notFound(`pack ${namespace}.${name} not found`));
      return ok(pack);
    },
    async resource(namespace: string, name: string): Promise<Result<unknown>> {
      return await metadataObject(
        deps.sql,
        "resources",
        "resource",
        "resource_definitions",
        namespace,
        name,
      );
    },
    async action(namespace: string, name: string): Promise<Result<unknown>> {
      return await metadataObject(
        deps.sql,
        "actions",
        "action",
        "action_definitions",
        namespace,
        name,
      );
    },
    async hook(namespace: string, name: string): Promise<Result<unknown>> {
      return await metadataObject(
        deps.sql,
        "hooks",
        "hook",
        "hook_definitions",
        namespace,
        name,
      );
    },
    async policy(namespace: string, name: string): Promise<Result<unknown>> {
      return await metadataObject(
        deps.sql,
        "policies",
        "policy",
        "policy_definitions",
        namespace,
        name,
      );
    },
  };
}

async function metadataObject(
  sql: Queryable,
  plural: string,
  kind: string,
  table: string,
  namespace: string,
  name: string,
): Promise<Result<unknown>> {
  const row = await getDefinition(sql, table, namespace, name) as
    | Record<string, unknown>
    | null;
  if (!row) return err(notFound(`${kind} ${namespace}.${name} not found`));
  const spec = jsonRecord(row.spec);
  return ok({
    kind,
    name: `${namespace}.${name}`,
    schema: plural === "resources" ? { fields: spec.fields ?? {} } : undefined,
    axi: spec.axi ?? {},
    script_digest: plural === "hooks" ? row.script_digest : undefined,
    spec,
  });
}

function notFound(message: string): StableError {
  return { code: "not_found", message, severity: "not_found" };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return isRecord(value) ? value : {};
}
function preferred(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}
