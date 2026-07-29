import type { LoadedPack } from "../packs/loaded_pack.ts";
import { canonicalJson } from "../ids/canonical_json.ts";
import { uuidV7 } from "../ids/uuid_v7.ts";

export type MigrationClass = "safe" | "risky" | "destructive";
export type MigrationStatus = "ready" | "blocked" | "applied";
export type MigrationAcknowledgement = "safe" | "reviewed" | "destructive";
export type MigrationApplication = {
  id: string;
  migration_id: string;
  plan_digest: string;
  candidate_revision_id: string;
  applied_by_auth_context_id: string;
  applied_at: string;
  hook_secret_grants: {
    preserved: string[];
    reauthorization_required: string[];
    new_ungranted_slots: string[];
    unused_retained: string[];
  };
};
export type MigrationApplyRequest = {
  acknowledgement: MigrationAcknowledgement;
  confirmation_token?: string | null;
  lock_timeout?: string;
};
export type MigrationChange = {
  id: string;
  kind: string;
  class: MigrationClass;
  status: "ready" | "blocked";
  target: Record<string, string>;
  reason: string;
  facts: Record<string, unknown>;
  hazard_codes: string[];
  intermediate_revision_guidance: string | null;
  cleanup_required: string | null;
  destructive_action: string | null;
};
export type MigrationPlan = {
  id: string;
  schema_version: "migration.plan.v1";
  publisher: string;
  pack: string;
  from_pack_revision_id: string | null;
  to_pack_revision_id: string;
  candidate_source_digest: string;
  plan_digest: string;
  created_auth_context_id: string;
  created_at: string;
  class: MigrationClass;
  status: MigrationStatus;
  summary: {
    safe: number;
    risky: number;
    destructive: number;
    blocked: number;
    warnings: number;
    blocking: number;
  };
  changes: MigrationChange[];
  hazards: Array<
    {
      code: string;
      severity: "warning" | "blocking";
      change_id: string;
      message: string;
    }
  >;
  blockers: Array<
    { change_id: string; code: string; count: number; message: string }
  >;
  steps: Array<{
    id: string;
    kind: string;
    change_ids: string[];
    statement_indexes: number[];
  }>;
  dependency_graph: {
    edges: Array<{
      from_step_id: string;
      to_step_id: string;
      reason: string;
    }>;
    topological_order: string[];
  };
  live_facts_digest: string;
  last_validation: null | {
    id: string;
    status: "ready" | "blocked";
    live_facts_digest: string;
    blockers: Array<{
      change_id: string;
      code: string;
      count: number;
      message: string;
    }>;
    created_at: string;
  };
  application: MigrationApplication | null;
};
export type ActivePackSnapshot = {
  revisionId: string;
  normalized: Record<string, unknown>;
};
export type LiveFacts = {
  resourceRows: Record<string, number>;
  fieldPresentValues: Record<string, number>;
};

export async function buildMigrationPlan(input: {
  id: string;
  candidateRevisionId: string;
  authContextId: string;
  active: ActivePackSnapshot | null;
  candidate: LoadedPack;
  liveFacts: LiveFacts;
  createdAt?: Date;
}): Promise<{ plan: MigrationPlan }> {
  const changes: MigrationChange[] = [];
  const activeResources = definitions(input.active?.normalized, "resources");
  const candidateResources = Object.fromEntries(
    Object.entries(input.candidate.resources).map((
      [name, def],
    ) => [name, def.document]),
  );
  const add = (change: Omit<MigrationChange, "id">) =>
    changes.push({ id: uuidV7(), ...change });

  for (const [name, document] of Object.entries(candidateResources).sort()) {
    const current = activeResources[name];
    if (!current) {
      add({
        kind: "add_resource",
        class: "safe",
        status: "ready",
        target: { resource: identity(input.candidate, name) },
        reason: "resource added in desired revision",
        facts: {},
        hazard_codes: [],
        intermediate_revision_guidance: null,
        cleanup_required: null,
        destructive_action: null,
      });
      continue;
    }
    const before = fields(current);
    const after = fields(document);
    for (const [field, descriptor] of Object.entries(after).sort()) {
      if (!before[field]) {
        const rows = input.liveFacts.resourceRows[name] ?? 0;
        const blocked = record(descriptor).required === true && rows > 0;
        add({
          kind: "add_field",
          class: blocked ? "risky" : "safe",
          status: blocked ? "blocked" : "ready",
          target: { resource: identity(input.candidate, name), field },
          reason: "field added in desired revision",
          facts: { row_count: rows },
          hazard_codes: blocked ? ["VALIDATION_SCAN"] : [],
          intermediate_revision_guidance: blocked
            ? "apply an intermediate revision with an optional field, then backfill through ordinary changesets"
            : null,
          cleanup_required: blocked ? "backfill existing rows" : null,
          destructive_action: null,
        });
      } else if (canonicalJson(before[field]) !== canonicalJson(descriptor)) {
        const typeChanged =
          record(before[field]).type !== record(descriptor).type;
        add({
          kind: "change_field",
          class: typeChanged ? "destructive" : "risky",
          status: typeChanged ? "blocked" : "ready",
          target: { resource: identity(input.candidate, name), field },
          reason: typeChanged
            ? "field type changes require an explicit intermediate revision"
            : "field validation changed",
          facts: {
            present_values:
              input.liveFacts.fieldPresentValues[`${name}.${field}`] ?? 0,
          },
          hazard_codes: typeChanged
            ? ["API_BREAK", "TABLE_REWRITE"]
            : ["VALIDATION_SCAN"],
          intermediate_revision_guidance: typeChanged
            ? "add a replacement field and migrate values through ordinary changesets"
            : null,
          cleanup_required: typeChanged
            ? "migrate values to a replacement field"
            : null,
          destructive_action: typeChanged ? "replace field type" : null,
        });
      }
    }
    for (const field of Object.keys(before).sort()) {
      if (!after[field]) {
        const count = input.liveFacts.fieldPresentValues[`${name}.${field}`] ??
          0;
        add({
          kind: "remove_field",
          class: "destructive",
          status: count > 0 ? "blocked" : "ready",
          target: { resource: identity(input.candidate, name), field },
          reason: "field removed from desired revision",
          facts: { present_values: count },
          hazard_codes: ["DATA_LOSS", "API_BREAK"],
          intermediate_revision_guidance:
            "remove references and clean data under an explicit intermediate revision",
          cleanup_required: count > 0
            ? "export or clear values through ordinary changesets"
            : null,
          destructive_action: "drop column",
        });
      }
    }
    const beforeConstraints = uniqueConstraints(current);
    const afterConstraints = uniqueConstraints(document);
    for (
      const constraintName of new Set([
        ...Object.keys(beforeConstraints),
        ...Object.keys(afterConstraints),
      ])
    ) {
      const prior = beforeConstraints[constraintName];
      const desired = afterConstraints[constraintName];
      if (
        prior && desired && canonicalJson(prior) === canonicalJson(desired)
      ) continue;
      const kind = !prior
        ? "add_resource_constraint"
        : !desired
        ? "remove_resource_constraint"
        : "change_resource_constraint";
      const constraint = desired ?? prior;
      add({
        kind,
        class: "risky",
        status: "ready",
        target: {
          resource: identity(input.candidate, name),
          constraint: constraintName,
        },
        reason: `resource uniqueness constraint ${
          !prior ? "added" : !desired ? "removed" : "changed"
        } in desired revision`,
        facts: {
          fields: Array.isArray(constraint.fields)
            ? constraint.fields.map(String)
            : [],
          predicate: constraint.where ?? null,
          previous: prior ?? null,
          desired: desired ?? null,
        },
        hazard_codes: !desired
          ? ["API_BREAK"]
          : ["VALIDATION_SCAN", "EXCLUSIVE_LOCK"],
        intermediate_revision_guidance: null,
        cleanup_required: null,
        destructive_action: null,
      });
    }
  }
  for (const name of Object.keys(activeResources).sort()) {
    if (!candidateResources[name]) {
      const count = input.liveFacts.resourceRows[name] ?? 0;
      add({
        kind: "remove_resource",
        class: "destructive",
        status: count > 0 ? "blocked" : "ready",
        target: { resource: identity(input.candidate, name) },
        reason: "resource removed from desired revision",
        facts: { row_count: count },
        hazard_codes: ["DATA_LOSS", "API_BREAK", "REFERENCE_BREAK"],
        intermediate_revision_guidance:
          "remove references and migrate objects under an explicit intermediate revision",
        cleanup_required: count > 0
          ? "export or migrate rows through ordinary changesets"
          : null,
        destructive_action: "drop table",
      });
    }
  }
  for (
    const kind of [
      "relationships",
      "lifecycles",
      "actions",
      "hooks",
      "roles",
      "policies",
      "seeds",
    ] as const
  ) diffDefinitions(input, kind, changes);
  changes.sort((a, b) =>
    canonicalJson(a.target).localeCompare(canonicalJson(b.target)) ||
    a.kind.localeCompare(b.kind)
  );
  const hazards = changes.flatMap((change) =>
    change.hazard_codes.map((code) => ({
      code,
      severity: change.status === "blocked"
        ? "blocking" as const
        : "warning" as const,
      change_id: change.id,
      message: hazardMessage(code, change.target),
    }))
  ).sort((a, b) =>
    a.code.localeCompare(b.code) || a.change_id.localeCompare(b.change_id)
  );
  const blockers = changes.filter((change) => change.status === "blocked").map((
    change,
  ) => ({
    change_id: change.id,
    code: blockerCode(change),
    count: Number(change.facts.present_values ?? change.facts.row_count ?? 0),
    message: `${change.kind} cannot be applied against current live facts`,
  }));
  const steps: MigrationPlan["steps"] = [];
  const dependencyGraph: MigrationPlan["dependency_graph"] = {
    edges: [],
    topological_order: [],
  };
  const rank = (value: MigrationClass) =>
    value === "destructive" ? 3 : value === "risky" ? 2 : 1;
  const planClass = changes.reduce<MigrationClass>(
    (highest, change) =>
      rank(change.class) > rank(highest) ? change.class : highest,
    "safe",
  );
  const liveFactsDigest = await migrationDigest(input.liveFacts);
  const createdAt = input.createdAt ?? new Date();
  const immutable = {
    id: input.id,
    schema_version: "migration.plan.v1" as const,
    publisher: input.candidate.publisher,
    pack: input.candidate.name,
    from_pack_revision_id: input.active?.revisionId ?? null,
    to_pack_revision_id: input.candidateRevisionId,
    candidate_source_digest: input.candidate.sourceDigest,
    created_auth_context_id: input.authContextId,
    created_at: createdAt.toISOString(),
    class: planClass,
    status: blockers.length ? "blocked" as const : "ready" as const,
    summary: {
      safe: changes.filter((x) => x.class === "safe").length,
      risky: changes.filter((x) => x.class === "risky").length,
      destructive: changes.filter((x) => x.class === "destructive").length,
      blocked: blockers.length,
      warnings: hazards.filter((x) => x.severity === "warning").length,
      blocking: hazards.filter((x) => x.severity === "blocking").length,
    },
    changes,
    hazards,
    blockers,
    steps,
    dependency_graph: dependencyGraph,
    live_facts_digest: liveFactsDigest,
    last_validation: null,
    application: null,
  };
  const planDigest = await migrationDigest(immutable);
  return { plan: { ...immutable, plan_digest: planDigest } };
}

function diffDefinitions(
  input: { active: ActivePackSnapshot | null; candidate: LoadedPack },
  kind:
    | "relationships"
    | "lifecycles"
    | "actions"
    | "hooks"
    | "roles"
    | "policies"
    | "seeds",
  changes: MigrationChange[],
) {
  const before = definitions(input.active?.normalized, kind);
  const after = Object.fromEntries(
    Object.entries(input.candidate[kind]).map((
      [name, def],
    ) => [name, def.document]),
  );
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (
      before[name] && after[name] &&
      canonicalJson(before[name]) === canonicalJson(after[name])
    ) continue;
    const removed = before[name] && !after[name];
    const changed = before[name] && after[name];
    const relationshipReplacement = kind === "relationships" && changed;
    const className: MigrationClass = removed || relationshipReplacement
      ? "destructive"
      : changed
      ? "risky"
      : "safe";
    changes.push({
      id: uuidV7(),
      kind: `${removed ? "remove" : changed ? "change" : "add"}_${
        kind.slice(0, -1)
      }`,
      class: className,
      status: removed || relationshipReplacement ? "blocked" : "ready",
      target: { [kind.slice(0, -1)]: identity(input.candidate, name) },
      reason: `${kind.slice(0, -1)} ${
        removed ? "removed" : changed ? "changed" : "added"
      } in desired revision`,
      facts: {},
      hazard_codes: removed
        ? ["REFERENCE_BREAK", "API_BREAK"]
        : relationshipReplacement
        ? ["DATA_LOSS", "API_BREAK", "TABLE_REWRITE", "EXCLUSIVE_LOCK"]
        : changed && (kind === "hooks" || kind === "actions")
        ? [kind === "hooks" ? "HOOK_BEHAVIOR_CHANGE" : "ACTION_CONTRACT_CHANGE"]
        : [],
      intermediate_revision_guidance: removed || relationshipReplacement
        ? "use an explicit intermediate revision and ordinary changesets before replacing dependent schema"
        : null,
      cleanup_required: removed || relationshipReplacement
        ? "remove or migrate dependent relationship rows"
        : null,
      destructive_action: removed || relationshipReplacement
        ? `${removed ? "remove" : "replace"} ${kind.slice(0, -1)}`
        : null,
    });
  }
}
function definitions(
  normalized: Record<string, unknown> | undefined,
  key: string,
): Record<string, Record<string, unknown>> {
  const value = normalized?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, Record<string, unknown>>
    : {};
}
function fields(document: Record<string, unknown>): Record<string, unknown> {
  return record(record(document).spec).fields as Record<string, unknown> ?? {};
}
function uniqueConstraints(
  document: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const raw = record(record(document).spec).constraints;
  if (!Array.isArray(raw)) return {};
  return Object.fromEntries(
    raw.map(record).filter((constraint) => constraint.kind === "unique").map(
      (constraint) => [String(constraint.name), constraint],
    ),
  );
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function identity(pack: LoadedPack, name: string) {
  return `${pack.publisher}/${pack.name}:${name}`;
}
function blockerCode(change: MigrationChange) {
  return change.kind === "remove_field"
    ? "PRESENT_VALUES"
    : change.kind === "remove_resource"
    ? "PRESENT_ROWS"
    : "INTERMEDIATE_REVISION_REQUIRED";
}
function hazardMessage(code: string, target: Record<string, string>) {
  return `${code} hazard for ${Object.values(target).join(":")}`;
}
export async function migrationDigest(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalJson(value)),
  );
  return "sha256:" +
    Array.from(new Uint8Array(digest)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
}
