import type { Clock } from "../ports/clock.ts";
import type { AuthorizationRepository } from "../ports/authorization.ts";
import type { AuthContext } from "../../domain/auth/model.ts";
import {
  err,
  ok,
  type Result,
  type StableError,
} from "../../domain/errors/result.ts";
import { isUuidV7 } from "../../domain/ids/uuid_v7.ts";
import type { MetadataCatalog } from "../ports/repair/repositories.ts";

type MetadataDefinitionRequest = Readonly<
  {
    section: string;
    publisher: string;
    pack: string;
    name: string;
    options: MetadataOptions;
  }
>;
type MetadataPackRequest = Readonly<
  { publisher: string; pack: string; options: MetadataOptions }
>;
type MetadataRow = Record<string, unknown>;
export type MetadataFactsCatalog = MetadataCatalog<
  MetadataOptions | MetadataDefinitionRequest | MetadataPackRequest,
  readonly MetadataRow[],
  MetadataRow,
  MetadataRow,
  MetadataRow
>;

export type HomeDto = {
  version: string;
  generated_at: string;
  system: { active_packs: string[] };
  resources: string[];
  actions: string[];
  status: "ready";
  capabilities: string[];
  capability_projection: Record<string, unknown>;
  axi_readiness: AxiReadiness;
  help: string[];
};
export type MetadataOptions = Readonly<
  { auth: AuthContext; projectId?: string; includeSecurity?: boolean }
>;

export function makeInspectMetadataService(
  deps: {
    catalog: MetadataFactsCatalog;
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
    const row = await deps.catalog.definition({
      section,
      publisher,
      pack,
      name,
      options,
    });
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
      axi_readiness: axiReadiness(kind, spec.axi),
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
          hook_revision_id: row.component_revision_id,
          security_digest: row.security_digest,
          script_digest: row.script_digest ??
            await deps.catalog.hookScriptDigest({
              section: "hooks",
              publisher,
              pack,
              name,
              options,
            }),
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
                  : allow(jsonRecord(item), ["name", "slot", "env"])
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
        capabilities: rules.map(policyRuleSummary),
      });
      if (options.includeSecurity) base.rules = rules;
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
    async home(options: MetadataOptions): Promise<Result<HomeDto>> {
      if (options.includeSecurity) {
        return err(
          badRequest("include_security is not supported for metadata home"),
        );
      }
      const boundary = await projection(options);
      if (!boundary.ok) return boundary;
      const result = { rows: [...await deps.catalog.home(options)] };
      const activePacks: string[] = [];
      const resources = new Set<string>();
      const actions = new Set<string>();
      const help = new Set<string>();
      for (const row of result.rows) {
        const publisher = String(row.publisher);
        const pack = String(row.name);
        activePacks.push(`${publisher}/${pack}@${String(row.version)}`);
        const normalized = jsonRecord(row.normalized);
        for (const name of Object.keys(jsonRecord(normalized.resources))) {
          resources.add(`${publisher}/${pack}:${name}`);
        }
        for (const name of Object.keys(jsonRecord(normalized.actions))) {
          actions.add(`${publisher}/${pack}:${name}`);
        }
        const manifest = jsonRecord(row.manifest);
        const home = jsonRecord(
          jsonRecord(jsonRecord(manifest.spec).axi).home,
        );
        for (const command of preferred(home.help, [])) {
          help.add(
            options.projectId
              ? command.replaceAll("${project}", options.projectId)
              : command,
          );
        }
      }
      const missingGuidance: string[] = [];
      for (const row of result.rows) {
        const publisher = String(row.publisher);
        const pack = String(row.name);
        const normalized = jsonRecord(row.normalized);
        const manifestAxi = jsonRecord(
          jsonRecord(jsonRecord(row.manifest).spec).axi,
        );
        if (!Object.keys(manifestAxi).length) {
          missingGuidance.push(`${publisher}/${pack}`);
        }
        for (const [section, kind] of Object.entries(SECTION_KINDS)) {
          for (
            const [name, document] of Object.entries(
              jsonRecord(normalized[section]),
            )
          ) {
            const axi = jsonRecord(jsonRecord(jsonRecord(document).spec).axi);
            if (!Object.keys(axi).length) {
              missingGuidance.push(`${kind}:${publisher}/${pack}:${name}`);
            }
          }
        }
      }
      return ok({
        version: deps.version,
        generated_at: deps.clock.now().toISOString(),
        system: { active_packs: activePacks },
        resources: [...resources].sort(),
        actions: [...actions].sort(),
        status: "ready",
        capabilities: [
          "metadata.home",
          "metadata.inspect",
          "project.list",
          "pack.preview",
          "query",
          "changeset.stage",
          "action.stage",
        ],
        capability_projection: boundary.value,
        axi_readiness: {
          ready: missingGuidance.length === 0,
          missing_guidance: missingGuidance.sort(),
        },
        help: [...help].sort(),
      });
    },
    async packs(options: MetadataOptions): Promise<Result<unknown>> {
      const p = await projection(options);
      return p.ok
        ? ok({
          packs: (await deps.catalog.listPacks(options)).map((row) =>
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
      const value = await deps.catalog.pack({ publisher, pack, options });
      if (!value) return err(notFound(`pack ${publisher}/${pack} not found`));
      const normalized = jsonRecord(value.normalized);
      const names = (key: string) =>
        Object.keys(jsonRecord(normalized[key])).sort();
      const missingGuidance: string[] = [];
      const manifestAxi = jsonRecord(jsonRecord(value.manifest).spec).axi;
      if (!Object.keys(jsonRecord(manifestAxi)).length) {
        missingGuidance.push(`${publisher}/${pack}`);
      }
      for (const [section, kind] of Object.entries(SECTION_KINDS)) {
        for (
          const [name, document] of Object.entries(
            jsonRecord(normalized[section]),
          )
        ) {
          const axi = jsonRecord(jsonRecord(jsonRecord(document).spec).axi);
          if (!Object.keys(axi).length) {
            missingGuidance.push(`${kind}:${publisher}/${pack}:${name}`);
          }
        }
      }
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
        axi_readiness: {
          ready: missingGuidance.length === 0,
          missing_guidance: missingGuidance.sort(),
        },
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
type AxiReadiness = { ready: boolean; missing_guidance: string[] };
const SECTION_KINDS: Record<string, string> = {
  resources: "resource",
  relationships: "relationship",
  lifecycles: "lifecycle",
  actions: "action",
  hooks: "hook",
  roles: "role",
  policies: "policy",
  seeds: "seed",
};
const AXI_REQUIRED: Record<string, string[]> = {
  resource: ["purpose", "whenToUse", "identity", "list", "detail", "help"],
  action: ["purpose", "examples", "successHelp"],
  relationship: ["purpose", "whenToUse", "help"],
  lifecycle: ["purpose", "whenToUse", "help"],
  hook: ["purpose", "whenToUse", "help"],
  role: ["purpose", "whenToUse", "help"],
  policy: ["purpose", "whenToUse", "help"],
  seed: ["purpose", "whenToUse", "help"],
};
function axiReadiness(kind: string, value: unknown): AxiReadiness {
  const axi = jsonRecord(value);
  const missing = Object.keys(axi).length === 0
    ? (AXI_REQUIRED[kind] ?? []).map((field) => `axi.${field}`)
    : [];
  return { ready: missing.length === 0, missing_guidance: missing };
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
    rules: arrayRecords(jsonRecord(jsonRecord(document).spec).rules),
  }));
  return { hooks, policies };
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
function policyRuleSummary(rule: Record<string, unknown>) {
  return {
    name: rule.name,
    actions: Array.isArray(rule.actions) ? rule.actions : [],
    resources: Array.isArray(rule.resources) ? rule.resources : [],
    conditional: typeof rule.where === "string",
    relation: rule.relation
      ? allow(jsonRecord(rule.relation), [
        "relationship",
        "object_side",
        "subject_side",
        "subject",
      ])
      : null,
    summary: jsonRecord(rule.axi).summary ?? null,
  };
}
function byJson(a: unknown, b: unknown) {
  return JSON.stringify(a).localeCompare(JSON.stringify(b));
}
