import type {
  LoadedPack,
  NormalizedDefinition,
} from "../../adapters/outbound/yaml/pack_loader.ts";

export type MigrationClass = "safe" | "risky" | "destructive" | "unsupported";
export type MigrationIssueStatus = "ready" | "blocked" | "staged" | "applied";
export type MigrationPlanStatus =
  | "previewed"
  | "ready"
  | "blocked"
  | "staged"
  | "awaiting_confirmation"
  | "applied"
  | "failed";

export type LiveFacts = {
  resourceRows: Record<string, number>;
  fieldPresentValues: Record<string, number>;
};

export type MigrationIssue = {
  id: string;
  class: MigrationClass;
  status: MigrationIssueStatus;
  kind: string;
  target: Record<string, string>;
  reason: string;
  facts?: Record<string, unknown>;
  sql?: string;
  stage_action?: string;
  cleanup_required?: string;
  destructive_action?: string;
};

export type MigrationPlan = {
  id: string;
  from_revision: string;
  to_revision: string;
  plan_digest: string;
  status: MigrationPlanStatus;
  summary: Record<string, number>;
  changes: MigrationIssue[];
  hazards: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  sql_preview: string[];
  confirmation_token: string;
};

export type ActivePackSnapshot = {
  revision: string;
  namespace: string;
  name: string;
  normalized: Record<string, unknown>;
};

type DefMap = Record<string, NormalizedDefinition>;

export async function buildMigrationPlan(input: {
  id: string;
  active: ActivePackSnapshot;
  candidate: LoadedPack;
  liveFacts: LiveFacts;
}): Promise<Omit<MigrationPlan, "plan_digest" | "confirmation_token">> {
  const changes: MigrationIssue[] = [];
  let counter = 1;
  const nextId = () => `chg_${counter++}`;
  const activeResources = defMap(input.active.normalized, "resources");
  const activeActions = defMap(input.active.normalized, "actions");
  const activeHooks = defMap(input.active.normalized, "hooks");
  const activeLifecycles = defMap(input.active.normalized, "lifecycles");

  for (
    const resource of Object.values(input.candidate.resources).sort(byName)
  ) {
    const current = activeResources[resource.name];
    if (!current) {
      changes.push({
        id: nextId(),
        class: "safe",
        status: "ready",
        kind: "add_resource",
        target: { resource: resource.name },
        reason: "resource added in desired config",
        sql: `create table if not exists ${qi(`res_${resource.name}`)} (...)`,
      });
      continue;
    }
    const currentFields = fields(current);
    const desiredFields = fields(resource);
    for (
      const [fieldName, desiredField] of Object.entries(desiredFields).sort()
    ) {
      const currentField = currentFields[fieldName];
      if (!currentField) {
        const required = desiredField.required === true;
        const rowCount = input.liveFacts.resourceRows[resource.name] ?? 0;
        changes.push({
          id: nextId(),
          class: required && rowCount > 0 ? "risky" : "safe",
          status: required && rowCount > 0 ? "blocked" : "ready",
          kind: "add_field",
          target: { resource: resource.name, field: fieldName },
          reason: required
            ? "required field added in desired config"
            : "nullable field added in desired config",
          facts: { row_count: rowCount },
          sql: `alter table ${qi(`res_${resource.name}`)} add column ${
            qi(fieldName)
          } ${sqlType(String(desiredField.type))}${
            required ? " not null" : ""
          }`,
          cleanup_required: required && rowCount > 0
            ? "backfill values before adding not-null field"
            : undefined,
        });
      } else if (String(currentField.type) !== String(desiredField.type)) {
        const from = String(currentField.type);
        const to = String(desiredField.type);
        const supportedRisky = from === "integer" && to === "decimal";
        changes.push({
          id: nextId(),
          class: supportedRisky ? "risky" : "unsupported",
          status: supportedRisky ? "ready" : "blocked",
          kind: "change_field_type",
          target: { resource: resource.name, field: fieldName },
          reason: `field type changed from ${from} to ${to}`,
          facts: {
            present_values: input.liveFacts
              .fieldPresentValues[`${resource.name}.${fieldName}`] ?? 0,
          },
          sql: supportedRisky
            ? `alter table ${qi(`res_${resource.name}`)} alter column ${
              qi(fieldName)
            } type ${sqlType(to)}`
            : undefined,
          cleanup_required: supportedRisky
            ? undefined
            : "add a replacement field and backfill through ordinary changesets",
        });
      }
    }
    for (const fieldName of Object.keys(currentFields).sort()) {
      if (!(fieldName in desiredFields)) {
        const present =
          input.liveFacts.fieldPresentValues[`${resource.name}.${fieldName}`] ??
            0;
        changes.push({
          id: nextId(),
          class: "destructive",
          status: present > 0 ? "blocked" : "ready",
          kind: "remove_field",
          target: { resource: resource.name, field: fieldName },
          reason: "field removed from desired config",
          facts: { present_values: present },
          sql: `alter table ${qi(`res_${resource.name}`)} drop column ${
            qi(fieldName)
          }`,
          stage_action: "mark field deprecated and block new writes",
          cleanup_required: present > 0
            ? "clear or export values through ordinary changesets"
            : undefined,
          destructive_action: "drop column",
        });
      }
    }
  }

  for (const resource of Object.values(activeResources).sort(byName)) {
    if (!input.candidate.resources[resource.name]) {
      const rows = input.liveFacts.resourceRows[resource.name] ?? 0;
      changes.push({
        id: nextId(),
        class: "destructive",
        status: rows > 0 ? "blocked" : "ready",
        kind: "remove_resource",
        target: { resource: resource.name },
        reason: "resource removed from desired config",
        facts: { row_count: rows },
        sql: `drop table ${qi(`res_${resource.name}`)}`,
        stage_action: "mark resource deprecated and block new writes",
        cleanup_required: rows > 0
          ? "archive or migrate rows through ordinary changesets"
          : undefined,
        destructive_action: "drop table",
      });
    }
  }

  diffBehavior(
    "actions",
    activeActions,
    input.candidate.actions,
    changes,
    nextId,
  );
  diffBehavior("hooks", activeHooks, input.candidate.hooks, changes, nextId);
  diffBehavior(
    "lifecycles",
    activeLifecycles,
    input.candidate.lifecycles,
    changes,
    nextId,
  );

  const summary = summarize(changes);
  const blockers = changes.filter((c) => c.status === "blocked").map((c) => ({
    change: c.id,
    code: c.kind === "remove_field"
      ? "PRESENT_VALUES"
      : c.kind === "remove_resource"
      ? "PRESENT_ROWS"
      : "BLOCKED",
    target: c.target,
    facts: c.facts ?? {},
  }));
  const hazards = changes.filter((c) =>
    c.class === "destructive" || c.class === "unsupported"
  ).map((c) => ({
    change: c.id,
    code: c.class === "unsupported" ? "UNSUPPORTED_CHANGE" : "DATA_LOSS",
    severity: c.status === "blocked" ? "blocking" : "review",
    message: c.reason,
  }));
  const status: MigrationPlanStatus = blockers.length > 0
    ? "blocked"
    : summary.destructive > 0
    ? "awaiting_confirmation"
    : "ready";
  return {
    id: input.id,
    from_revision: input.active.revision,
    to_revision: input.candidate.revision,
    status,
    summary,
    changes,
    hazards,
    blockers,
    sql_preview: changes.filter((c) => c.status === "ready" && c.sql).map((c) =>
      c.sql!
    ),
  };
}

export async function migrationDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" +
    Array.from(new Uint8Array(digest)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join("");
}

function defMap(normalized: Record<string, unknown>, key: string): DefMap {
  const source = normalized[key];
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  const out: DefMap = {};
  for (
    const [name, document] of Object.entries(source as Record<string, unknown>)
  ) {
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      continue;
    }
    const doc = document as Record<string, unknown>;
    out[name] = {
      kind: String(doc.kind ?? "Resource") as NormalizedDefinition["kind"],
      path: `${key}/${name}.yaml`,
      name,
      namespace: "default",
      document: doc as NormalizedDefinition["document"],
      spec:
        (doc.spec && typeof doc.spec === "object" && !Array.isArray(doc.spec)
          ? doc.spec
          : {}) as NormalizedDefinition["spec"],
    };
  }
  return out;
}
function fields(
  def: NormalizedDefinition,
): Record<string, Record<string, unknown>> {
  const raw = def.spec.fields;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, Record<string, unknown>>
    : {};
}
function diffBehavior(
  kind: string,
  active: DefMap,
  desired: DefMap,
  changes: MigrationIssue[],
  nextId: () => string,
) {
  for (const [name, current] of Object.entries(active).sort()) {
    const next = desired[name];
    if (!next) {
      changes.push({
        id: nextId(),
        class: "risky",
        status: "ready",
        kind: `remove_${kind.slice(0, -1)}`,
        target: { [kind.slice(0, -1)]: name },
        reason: `${kind.slice(0, -1)} removed from desired config`,
      });
    } else if (stableJson(current.document) !== stableJson(next.document)) {
      changes.push({
        id: nextId(),
        class: "risky",
        status: "ready",
        kind: `change_${kind.slice(0, -1)}`,
        target: { [kind.slice(0, -1)]: name },
        reason: `${kind.slice(0, -1)} changed in desired config`,
      });
    }
  }
}
function summarize(changes: MigrationIssue[]): Record<string, number> {
  const summary = {
    safe: 0,
    risky: 0,
    destructive: 0,
    unsupported: 0,
    blocked: 0,
  };
  for (const change of changes) {
    summary[change.class]++;
    if (change.status === "blocked") summary.blocked++;
  }
  return summary;
}
function sqlType(type: string): string {
  switch (type) {
    case "integer":
      return "integer";
    case "decimal":
      return "numeric";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamptz";
    case "date":
      return "date";
    default:
      return "text";
  }
}
function qi(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`invalid SQL identifier ${value}`);
  }
  return `"${value}"`;
}
function byName(a: { name: string }, b: { name: string }) {
  return a.name.localeCompare(b.name);
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a.localeCompare(b)
      ).map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
