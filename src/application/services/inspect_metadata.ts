import type { Clock } from "../ports/clock.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import {
  query,
  type Queryable,
} from "../../adapters/outbound/postgres/client.ts";
import {
  getActivePack,
  getDefinition,
  listPacks,
} from "../../adapters/outbound/postgres/pack_repository.ts";
import {
  err,
  ok,
  type Result,
  type StableError,
} from "../../domain/errors/result.ts";
import { isUuidV7 } from "../../domain/ids/uuid_v7.ts";

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
export type MetadataOptions = Readonly<
  { auth: AuthContext; projectId?: string; includeSecurity?: boolean }
>;

export function makeInspectMetadataService(
  deps: {
    sql: Queryable;
    clock: Clock;
    version: string;
    authorization: AuthorizationRepository;
  },
) {
  async function projection(
    options: MetadataOptions,
  ): Promise<Result<Record<string, unknown>>> {
    if (!options.projectId) return ok({ boundary_required: true });
    if (!isUuidV7(options.projectId)) {
      return err(badRequest("project_id must be a lowercase UUIDv7"));
    }
    const authority = await deps.authorization.authority(options.auth, {
      type: "project",
      projectId: options.projectId,
    });
    if (!authority.ok) return authority;
    return ok({
      project_id: options.projectId,
      boundary_required: false,
      capabilities: authority.value.capabilities.filter((c) =>
        c.condition === "unconditional"
      ).map((c) => ({
        action: c.action,
        resource: c.resource,
        summary: c.summary,
      })).sort(byJson),
    });
  }
  async function security(options: MetadataOptions): Promise<Result<true>> {
    if (!options.includeSecurity) return ok(true);
    const authority = await deps.authorization.authority(options.auth, {
      type: "system",
    }, true);
    return authority.ok ? ok(true) : authority;
  }
  const child = (section: string, kind: string) =>
  async (
    publisher: string,
    pack: string,
    name: string,
    options: MetadataOptions,
  ): Promise<Result<unknown>> => {
    const boundary = await projection(options);
    if (!boundary.ok) return boundary;
    if (
      options.includeSecurity && section !== "hooks" && section !== "policies"
    ) {
      return err(
        badRequest(
          "include_security is supported only for Pack, Hook, and Policy metadata",
        ),
      );
    }
    const permitted = await security(options);
    if (!permitted.ok) return permitted;
    const row = await getDefinition(deps.sql, section, publisher, pack, name);
    if (!row) {
      return err(notFound(`${kind} ${publisher}/${pack}:${name} not found`));
    }
    const spec = jsonRecord(row.spec);
    const base: Record<string, unknown> = {
      kind,
      identity: `${publisher}/${pack}:${name}`,
      publisher,
      pack,
      name,
      capability_projection: boundary.value,
    };
    if (section === "resources") {
      Object.assign(base, {
        schema: { fields: spec.fields ?? {} },
        axi: spec.axi ?? {},
      });
    } else if (section === "relationships") {
      Object.assign(base, {
        from: spec.from,
        to: spec.to,
        schema: { fields: spec.fields ?? {} },
        axi: spec.axi ?? {},
      });
    } else if (section === "hooks") {
      const attachments = arrayRecords(spec.attachments);
      Object.assign(base, {
        purpose: jsonRecord(spec.axi).purpose ?? null,
        phases: [
          ...new Set(
            attachments.map((item) => item.phase).filter((v): v is string =>
              typeof v === "string"
            ),
          ),
        ],
        output: summary(spec.output),
        effects: summary(spec.effects),
      });
      if (options.includeSecurity) {
        Object.assign(base, {
          script_digest: row.script_digest ??
            await hookDigest(deps.sql, publisher, pack, name),
          security: {
            permissions: allow(jsonRecord(spec.permissions), [
              "net",
              "env",
              "read",
            ]),
            secret_slots: Array.isArray(spec.secrets)
              ? spec.secrets.map((item) =>
                typeof item === "string"
                  ? item
                  : allow(jsonRecord(item), ["name", "slot"])
              )
              : [],
            attachments: attachments.map((item) =>
              allow(item, ["phase", "resource", "relationship", "order"])
            ),
          },
        });
      }
    } else if (section === "policies") {
      const rules = arrayRecords(spec.rules);
      Object.assign(base, {
        axi: spec.axi ?? {},
        capabilities: rules.map((rule) =>
          allow(rule, ["id", "action", "resource", "summary"])
        ),
      });
      if (options.includeSecurity) {
        base.rules = rules.map((rule) =>
          allow(rule, [
            "id",
            "action",
            "resource",
            "condition",
            "predicate",
            "summary",
          ])
        );
      }
    } else if (section === "roles") {
      Object.assign(base, {
        display_name: spec.displayName ?? spec.display_name,
        description: spec.description,
        axi: spec.axi ?? {},
        capabilities: spec.capabilities ?? [],
      });
    } else if (section === "actions") {
      Object.assign(base, {
        input: spec.input ?? {},
        output: spec.output ?? {},
        axi: spec.axi ?? {},
        effects: summary(spec.effects),
      });
    } else if (section === "lifecycles") {
      Object.assign(base, {
        states: spec.states ?? [],
        transitions: spec.transitions ?? [],
        axi: spec.axi ?? {},
      });
    } else if (section === "seeds") {
      Object.assign(base, {
        axi: spec.axi ?? {},
        resources: Array.isArray(spec.resources) ? spec.resources : [],
      });
    }
    return ok(base);
  };
  return {
    async home(): Promise<Result<HomeDto>> {
      const active = await getActivePack(deps.sql);
      const manifest = jsonRecord(active?.manifest);
      const normalized = jsonRecord(active?.normalized);
      const spec = jsonRecord(manifest.spec);
      const home = jsonRecord(jsonRecord(spec.axi).home);
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
    async packs(options: MetadataOptions): Promise<Result<unknown>> {
      const p = await projection(options);
      return p.ok
        ? ok({
          packs: (await listPacks(deps.sql)).map((row) =>
            allow(row as Record<string, unknown>, [
              "publisher",
              "name",
              "version",
              "revision_id",
            ])
          ),
          capability_projection: p.value,
        })
        : p;
    },
    async pack(
      publisher: string,
      pack: string,
      options: MetadataOptions,
    ): Promise<Result<unknown>> {
      const p = await projection(options);
      if (!p.ok) return p;
      const s = await security(options);
      if (!s.ok) return s;
      const value = await getActivePack(deps.sql, publisher, pack);
      if (!value) return err(notFound(`pack ${publisher}/${pack} not found`));
      const normalized = jsonRecord(value.normalized);
      const names = (key: string) =>
        Object.keys(jsonRecord(normalized[key])).sort();
      return ok({
        publisher,
        name: pack,
        version: value.version,
        revision_id: value.id,
        resources: names("resources"),
        relationships: names("relationships"),
        lifecycles: names("lifecycles"),
        actions: names("actions"),
        hooks: names("hooks"),
        roles: names("roles"),
        policies: names("policies"),
        seeds: names("seeds"),
        capability_projection: p.value,
        ...(options.includeSecurity
          ? { security: packSecurity(normalized) }
          : {}),
      });
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
function packSecurity(normalized: Record<string, unknown>) {
  const scripts = jsonRecord(normalized.scripts);
  const hooks = Object.entries(jsonRecord(normalized.hooks)).sort(([a], [b]) =>
    a.localeCompare(b)
  ).map(([name, document]) => {
    const spec = jsonRecord(jsonRecord(document).spec);
    return {
      name,
      script_digest: scripts[`hooks/${name}.ts`] ?? null,
      permissions: allow(jsonRecord(spec.permissions), ["net", "env", "read"]),
      secret_slots: Array.isArray(spec.secrets)
        ? spec.secrets.map((item) =>
          typeof item === "string"
            ? item
            : allow(jsonRecord(item), ["name", "slot"])
        )
        : [],
      attachments: arrayRecords(spec.attachments).map((item) =>
        allow(item, ["phase", "resource", "relationship", "order"])
      ),
    };
  });
  const policies = Object.entries(jsonRecord(normalized.policies)).sort((
    [a],
    [b],
  ) => a.localeCompare(b)).map(([name, document]) => ({
    name,
    rules: arrayRecords(jsonRecord(jsonRecord(document).spec).rules).map(
      (rule) =>
        allow(rule, [
          "id",
          "action",
          "resource",
          "condition",
          "predicate",
          "summary",
        ]),
    ),
  }));
  return { hooks, policies };
}

async function hookDigest(
  sql: Queryable,
  publisher: string,
  pack: string,
  name: string,
): Promise<string | null> {
  const result = await query<{ digest: string | null }>(
    sql,
    `select jsonb_extract_path_text(cr.normalized,'scripts',$3) digest
       from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
      where ar.publisher=$1 and ar.pack_name=$2`,
    [publisher, pack, `hooks/${name}.ts`],
  );
  return result.rows[0]?.digest ?? null;
}
function notFound(message: string): StableError {
  return { code: "not_found", message, severity: "not_found" };
}
function badRequest(message: string): StableError {
  return { code: "bad_request", message, severity: "validation" };
}
function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function preferred(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : fallback;
}
function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.map(jsonRecord) : [];
}
function allow(value: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((
      key,
    ) => [key, value[key]]),
  );
}
function summary(value: unknown) {
  const record = jsonRecord(value);
  return allow(record, ["schema", "operations", "events", "summary"]);
}
function byJson(a: unknown, b: unknown) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}
