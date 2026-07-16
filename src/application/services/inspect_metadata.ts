import type { Clock } from "../ports/clock.ts";
import type { Queryable } from "../../adapters/outbound/postgres/client.ts";
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
  const child = (section: string, kind: string) =>
  async (
    publisher: string,
    pack: string,
    name: string,
  ): Promise<Result<unknown>> => {
    const row = await getDefinition(deps.sql, section, publisher, pack, name);
    if (!row) {
      return err(notFound(`${kind} ${publisher}/${pack}:${name} not found`));
    }
    const spec = jsonRecord(row.spec);
    return ok({
      kind,
      identity: `${publisher}/${pack}:${name}`,
      publisher,
      pack,
      name,
      schema: section === "resources"
        ? { fields: spec.fields ?? {} }
        : undefined,
      axi: spec.axi ?? {},
      script_digest: section === "hooks" ? row.script_digest : undefined,
      spec,
    });
  };
  return {
    async home(): Promise<Result<HomeDto>> {
      const active = await getActivePack(deps.sql);
      const manifest = jsonRecord(active?.manifest);
      const normalized = jsonRecord(active?.normalized);
      const spec = jsonRecord(manifest.spec);
      const axi = jsonRecord(spec.axi);
      const home = jsonRecord(axi.home);
      const publisher = typeof active?.publisher === "string"
        ? active.publisher
        : null;
      const pack = typeof active?.name === "string" ? active.name : null;
      const qualify = (section: string) =>
        publisher && pack
          ? Object.keys(jsonRecord(normalized[section])).sort().map((name) =>
            `${publisher}/${pack}:${name}`
          )
          : [];
      return ok({
        version: deps.version,
        generated_at: deps.clock.now().toISOString(),
        system: {
          active_pack: publisher && pack
            ? `${publisher}/${pack}@${active?.version}`
            : null,
        },
        resources: preferred(home.resources, qualify("resources")),
        actions: preferred(home.actions, qualify("actions")),
        status: "ready",
        capabilities: ["health", "metadata.home", "pack.preview"],
        help: preferred(home.help, [
          "optctl pack preview <pack-dir> --json",
          "optctl metadata resource <publisher>/<pack>:<name>",
        ]),
      });
    },
    async packs(): Promise<Result<unknown>> {
      return ok({ packs: await listPacks(deps.sql) });
    },
    async pack(publisher: string, pack: string): Promise<Result<unknown>> {
      const value = await getPack(deps.sql, publisher, pack);
      return value
        ? ok(value)
        : err(notFound(`pack ${publisher}/${pack} not found`));
    },
    resource: child("resources", "resource"),
    relationship: child("relationships", "relationship"),
    lifecycle: child("lifecycles", "lifecycle"),
    action: child("actions", "action"),
    hook: child("hooks", "hook"),
    role: child("roles", "role"),
    policy: child("policies", "policy"),
    seed: child("seeds", "seed"),
  };
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
