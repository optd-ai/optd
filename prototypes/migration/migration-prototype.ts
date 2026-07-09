type Json = Record<string, unknown>;

type Field = {
  type: string;
  required?: boolean;
  maxLength?: number;
  ref?: string;
};
type Index = { name: string; type?: string; fields: string[]; where?: string };
type Constraint = {
  name: string;
  type: "check" | "foreign_key";
  expression?: string;
  field?: string;
  ref?: string;
};
type Lifecycle = {
  field: string;
  states: string[];
  transitions?: { from: string | string[]; to: string }[];
};
type Resource = {
  fields?: Record<string, Field>;
  indexes?: Index[];
  constraints?: Constraint[];
  lifecycle?: Lifecycle;
  hooks?: string[];
};
type Pack = {
  resources: Record<string, Resource>;
  actions?: Record<string, Json>;
  hooks?: Record<string, Json>;
};
type LiveFacts = {
  rows?: Record<string, number>;
  presentValues?: Record<string, number>;
  violations?: Record<string, number>;
  duplicates?: Record<string, number>;
  references?: Record<string, string[]>;
  tableSize?: Record<string, "small" | "medium" | "large">;
};
type Scenario = { name: string; current: Pack; desired: Pack; live: LiveFacts };

type Class = "safe" | "risky" | "destructive" | "blocking";
type Issue = {
  id: string;
  target: string;
  change: string;
  class: Class;
  reason: string;
  facts?: Json;
  suggestion: string;
  hazards?: string[];
};

export async function main() {
  const args = Deno.args;
  if (args.length === 1) {
    const scenario = JSON.parse(Deno.readTextFileSync(args[0])) as Scenario;
    printScenarioResult(scenario);
    return;
  }
  if (args.length >= 3 && args[0] === "diff-packs") {
    const current = await loadPackDir(args[1]);
    const desired = await loadPackDir(args[2]);
    const live = args[3]
      ? JSON.parse(Deno.readTextFileSync(args[3])) as LiveFacts
      : {};
    printScenarioResult({
      name: `pack diff ${args[1]} -> ${args[2]}`,
      current,
      desired,
      live,
    });
    return;
  }
  console.error(
    "usage:\n  deno run --allow-read migration-prototype.ts <scenario.json>\n  deno run --allow-read migration-prototype.ts diff-packs <current-pack-dir> <desired-pack-dir> [live-facts.json]",
  );
  Deno.exit(2);
}

function printScenarioResult(scenario: Scenario) {
  const issues = classifyScenario(scenario);
  const plan = buildPlan(scenario, issues);
  console.log(
    JSON.stringify(
      { scenario: scenario.name, summary: summarize(issues), issues, plan },
      null,
      2,
    ),
  );
}

export function classifyScenario(s: Scenario): Issue[] {
  return [
    ...classifyResources(s),
    ...classifyActions(s),
    ...classifyHooks(s),
  ];
}

export async function loadPackDir(root: string): Promise<Pack> {
  const pack: Pack = { resources: {}, actions: {}, hooks: {} };
  for await (const file of walkFiles(`${root}/resources`)) {
    if (!file.endsWith(".yaml")) continue;
    const doc = readYamlAsJson(file);
    const name = metadataName(doc, file);
    pack.resources[name] = (doc.spec ?? {}) as Resource;
  }
  for await (const file of walkFiles(`${root}/actions`)) {
    if (!file.endsWith(".yaml")) continue;
    const doc = readYamlAsJson(file);
    const name = metadataName(doc, file);
    pack.actions![name] = doc.spec ?? {};
  }
  for await (const file of walkFiles(`${root}/hooks`)) {
    if (file.endsWith(".yaml")) {
      const doc = readYamlAsJson(file);
      const name = metadataName(doc, file);
      pack.hooks![name] = doc.spec ?? {};
    }
  }
  // Attach script digests to hooks by convention: hooks/<name>.ts.
  for (const name of Object.keys(pack.hooks!)) {
    const script = `${root}/hooks/${name}.ts`;
    try {
      const text = await Deno.readTextFile(script);
      pack.hooks![name] = {
        ...pack.hooks![name],
        scriptDigest: digestText(text),
        scriptBytes: text.length,
      };
    } catch {
      pack.hooks![name] = { ...pack.hooks![name], missingScript: script };
    }
  }
  return pack;
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isFile) yield path;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function readYamlAsJson(path: string): any {
  // Prototype shortcut: fixtures use JSON-ish syntax in .yaml files.
  // The real implementation should parse restricted YAML and normalize to canonical JSON.
  return JSON.parse(stripTrailingCommas(Deno.readTextFileSync(path)));
}

function stripTrailingCommas(text: string) {
  return text.replace(/,\s*([}\]])/g, "$1");
}

function metadataName(doc: any, path: string): string {
  const fromDoc = doc?.metadata?.name;
  if (typeof fromDoc === "string") return fromDoc;
  return path.split("/").pop()!.replace(/\.yaml$/, "");
}

function digestText(text: string): string {
  // Small deterministic prototype hash, not cryptographic.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function classifyResources(s: Scenario): Issue[] {
  const issues: Issue[] = [];
  const currentNames = Object.keys(s.current.resources).sort();
  const desiredNames = Object.keys(s.desired.resources).sort();
  const all = new Set([...currentNames, ...desiredNames]);

  for (const name of all) {
    const cur = s.current.resources[name];
    const next = s.desired.resources[name];
    if (!cur && next) {
      const existingRows = s.live.rows?.[name] ?? 0;
      issues.push({
        id: `resource:add:${name}`,
        target: name,
        change: "add_resource",
        class: existingRows > 0 ? "risky" : "safe",
        reason: existingRows > 0
          ? "target table appears to contain unmanaged rows"
          : "new resource is additive",
        facts: { rows: existingRows },
        suggestion: existingRows > 0
          ? "inspect existing table before adopting it"
          : "create generated resource table",
      });
      continue;
    }
    if (cur && !next) {
      const rows = s.live.rows?.[name] ?? 0;
      const refs = s.live.references?.[name] ?? [];
      issues.push({
        id: `resource:remove:${name}`,
        target: name,
        change: "remove_resource",
        class: rows > 0 || refs.length > 0 ? "destructive" : "destructive",
        reason: rows > 0
          ? "removing resource would remove existing data/API shape"
          : "removing resource breaks API shape even with no rows",
        facts: { rows, references: refs },
        suggestion:
          "deprecate resource first; block creates; preserve read/export; require destructive confirmation to drop",
      });
      continue;
    }
    if (cur && next) {
      issues.push(...classifyFields(name, cur, next, s.live));
      issues.push(...classifyIndexes(name, cur, next, s.live));
      issues.push(...classifyConstraints(name, cur, next, s.live));
      issues.push(...classifyLifecycle(name, cur, next, s.live));
    }
  }
  return issues;
}

function classifyFields(
  resource: string,
  cur: Resource,
  next: Resource,
  live: LiveFacts,
): Issue[] {
  const issues: Issue[] = [];
  const curFields = cur.fields ?? {};
  const nextFields = next.fields ?? {};
  const all = new Set([...Object.keys(curFields), ...Object.keys(nextFields)]);
  for (const field of [...all].sort()) {
    const a = curFields[field];
    const b = nextFields[field];
    const target = `${resource}.${field}`;
    if (!a && b) {
      const rows = live.rows?.[resource] ?? 0;
      if (b.required && rows > 0) {
        issues.push({
          id: `field:add-required:${target}`,
          target,
          change: "add_required_field",
          class: "blocking",
          reason: "required field added to resource with existing rows",
          facts: { rows },
          suggestion:
            "add optional field, backfill, validate, then make required",
        });
      } else {
        issues.push({
          id: `field:add:${target}`,
          target,
          change: "add_field",
          class: "safe",
          reason: b.required
            ? "required field added to empty resource"
            : "optional field is additive",
          facts: { rows },
          suggestion: "add column",
        });
      }
      continue;
    }
    if (a && !b) {
      const present = live.presentValues?.[target] ?? 0;
      const refs = live.references?.[target] ?? [];
      issues.push({
        id: `field:remove:${target}`,
        target,
        change: "remove_field",
        class: "destructive",
        reason: present > 0
          ? "dropping field would discard present values"
          : "removing field breaks API shape",
        facts: { presentValues: present, references: refs },
        suggestion:
          "deprecate field, block new writes, export/backfill, require destructive confirmation to drop",
      });
      continue;
    }
    if (a && b) {
      if (a.type !== b.type) {
        const cast = generatedCast(a, b);
        issues.push({
          id: `field:type:${target}`,
          target,
          change: "change_field_type",
          class: isWidening(a, b) ? "risky" : cast ? "destructive" : "blocking",
          reason: isWidening(a, b)
            ? "type widening may be compatible but needs validation"
            : cast
            ? `platform can stage generated cast ${cast}`
            : "type change has no supported generated cast",
          facts: { from: a.type, to: b.type, generatedCast: cast },
          suggestion: cast
            ? "stage replacement field, generated backfill cast, validate, then destructively swap columns"
            : "agent must add a new field, populate it with ordinary changesets or an action/hook, update readers/writers, then remove the old field later",
        });
      }
      if (!a.required && b.required) {
        const violations = live.violations?.[`required:${target}`] ?? 0;
        issues.push({
          id: `field:make-required:${target}`,
          target,
          change: "make_required",
          class: violations > 0 ? "blocking" : "risky",
          reason: violations > 0
            ? "existing rows are missing the field"
            : "requires validation scan before enforcing",
          facts: { violations },
          suggestion: violations > 0
            ? "fix missing values through changesets before enforcing"
            : "add NOT VALID check, validate, then enforce required",
        });
      }
      if (a.required && !b.required) {
        const refs = live.references?.[target] ?? [];
        issues.push({
          id: `field:make-optional:${target}`,
          target,
          change: "make_optional",
          class: refs.length > 0 ? "risky" : "safe",
          reason: refs.length > 0
            ? "hooks/actions may assume presence"
            : "loosening requiredness is backward-compatible for writes",
          facts: { references: refs },
          suggestion: "warn if hooks/actions use field without present() guard",
        });
      }
      if (a.maxLength && b.maxLength && b.maxLength < a.maxLength) {
        const violations = live.violations?.[`maxlength:${target}`] ?? 0;
        issues.push({
          id: `field:narrow:${target}`,
          target,
          change: "narrow_field",
          class: violations > 0 ? "blocking" : "risky",
          reason: "maxLength was reduced",
          facts: { violations },
          suggestion: "validate all values fit before tightening",
        });
      }
    }
  }
  return issues;
}

function classifyIndexes(
  resource: string,
  cur: Resource,
  next: Resource,
  live: LiveFacts,
): Issue[] {
  const issues: Issue[] = [];
  const curIdx = Object.fromEntries(
    (cur.indexes ?? []).map((i) => [i.name, i]),
  );
  const nextIdx = Object.fromEntries(
    (next.indexes ?? []).map((i) => [i.name, i]),
  );
  const all = new Set([...Object.keys(curIdx), ...Object.keys(nextIdx)]);
  for (const name of [...all].sort()) {
    const a = curIdx[name];
    const b = nextIdx[name];
    const target = `${resource}.${name}`;
    if (!a && b) {
      if (b.type === "unique") {
        const dupes = live.duplicates?.[target] ?? 0;
        issues.push({
          id: `index:add-unique:${target}`,
          target,
          change: "add_unique_index",
          class: dupes > 0 ? "blocking" : "risky",
          reason: dupes > 0
            ? "duplicate values violate unique index"
            : "unique index requires duplicate scan",
          facts: { duplicates: dupes, where: b.where },
          suggestion: dupes > 0
            ? "dedupe data before applying"
            : "create unique index concurrently if possible",
          hazards: ["VALIDATION_SCAN"],
        });
      } else {
        const size = live.tableSize?.[resource] ?? "small";
        issues.push({
          id: `index:add:${target}`,
          target,
          change: "add_index",
          class: size === "large" ? "risky" : "safe",
          reason: size === "large"
            ? "large table index build may be expensive"
            : "non-unique index is additive",
          facts: { tableSize: size, where: b.where },
          suggestion: "create index concurrently where possible",
          hazards: size === "large" ? ["INDEX_BUILD"] : [],
        });
      }
    } else if (a && !b) {
      issues.push({
        id: `index:remove:${target}`,
        target,
        change: "remove_index",
        class: a.type === "unique" ? "risky" : "safe",
        reason: a.type === "unique"
          ? "removing uniqueness weakens correctness"
          : "dropping non-unique index does not lose data",
        suggestion: a.type === "unique"
          ? "require confirmation; check pack invariants"
          : "drop index",
      });
    } else if (a && b && JSON.stringify(a) !== JSON.stringify(b)) {
      issues.push({
        id: `index:change:${target}`,
        target,
        change: "change_index",
        class: "risky",
        reason:
          "index definition changed; usually implemented as create new then drop old",
        suggestion:
          "create replacement index first, then drop old after validation",
        hazards: ["INDEX_BUILD"],
      });
    }
  }
  return issues;
}

function classifyConstraints(
  resource: string,
  cur: Resource,
  next: Resource,
  live: LiveFacts,
): Issue[] {
  const issues: Issue[] = [];
  const curCons = Object.fromEntries(
    (cur.constraints ?? []).map((c) => [c.name, c]),
  );
  const nextCons = Object.fromEntries(
    (next.constraints ?? []).map((c) => [c.name, c]),
  );
  const all = new Set([...Object.keys(curCons), ...Object.keys(nextCons)]);
  for (const name of [...all].sort()) {
    const a = curCons[name];
    const b = nextCons[name];
    const target = `${resource}.${name}`;
    if (!a && b) {
      const violations = live.violations?.[`constraint:${target}`] ?? 0;
      if (b.type === "foreign_key") {
        issues.push({
          id: `constraint:add-fk:${target}`,
          target,
          change: "add_foreign_key",
          class: violations > 0 ? "blocking" : "risky",
          reason: violations > 0
            ? "orphan rows violate new foreign key"
            : "foreign key requires validation scan",
          facts: { violations },
          suggestion: violations > 0
            ? "fix orphans before applying foreign key"
            : "add NOT VALID foreign key, validate, then enforce",
          hazards: ["VALIDATION_SCAN"],
        });
      } else {
        issues.push({
          id: `constraint:add-check:${target}`,
          target,
          change: "add_check_constraint",
          class: violations > 0 ? "blocking" : "risky",
          reason: violations > 0
            ? "existing rows violate new check constraint"
            : "check constraint requires validation scan",
          facts: { violations },
          suggestion: violations > 0
            ? "fix violating rows before applying check"
            : "add NOT VALID check, validate, then enforce",
          hazards: ["VALIDATION_SCAN"],
        });
      }
    } else if (a && !b) {
      issues.push({
        id: `constraint:remove:${target}`,
        target,
        change: "remove_constraint",
        class: "risky",
        reason: "removing constraint weakens correctness guarantees",
        suggestion:
          "require review/confirmation before removing correctness constraint",
      });
    } else if (a && b && JSON.stringify(a) !== JSON.stringify(b)) {
      issues.push({
        id: `constraint:change:${target}`,
        target,
        change: "change_constraint",
        class: "risky",
        reason:
          "constraint definition changed; validate as remove old plus add new",
        suggestion: "create replacement constraint, validate, then remove old",
        hazards: ["VALIDATION_SCAN"],
      });
    }
  }
  return issues;
}

function classifyLifecycle(
  resource: string,
  cur: Resource,
  next: Resource,
  live: LiveFacts,
): Issue[] {
  const issues: Issue[] = [];
  const a = cur.lifecycle;
  const b = next.lifecycle;
  if (!a && b) {
    return [{
      id: `lifecycle:add:${resource}`,
      target: resource,
      change: "add_lifecycle",
      class: "risky",
      reason: "adding lifecycle may need mapping existing rows to states",
      suggestion: "validate lifecycle field values against new states",
    }];
  }
  if (a && !b) {
    return [{
      id: `lifecycle:remove:${resource}`,
      target: resource,
      change: "remove_lifecycle",
      class: "destructive",
      reason: "removing lifecycle changes behavior/API",
      suggestion: "deprecate lifecycle behavior first",
    }];
  }
  if (!a || !b) return issues;
  for (const state of a.states) {
    if (!b.states.includes(state)) {
      const count = live.violations?.[`state:${resource}.${state}`] ?? 0;
      issues.push({
        id: `lifecycle:remove-state:${resource}.${state}`,
        target: `${resource}.${state}`,
        change: "remove_lifecycle_state",
        class: count > 0 ? "blocking" : "destructive",
        reason: count > 0
          ? "existing objects use removed state"
          : "state removal breaks lifecycle API",
        facts: { rowsInState: count },
        suggestion: "provide state migration map before removal",
      });
    }
  }
  const newTransitions = transitionKeys(b);
  for (const transition of transitionKeys(a)) {
    if (!newTransitions.has(transition)) {
      const refs = live.references?.[`transition:${resource}.${transition}`] ??
        [];
      issues.push({
        id: `lifecycle:remove-transition:${resource}.${transition}`,
        target: `${resource}.${transition}`,
        change: "remove_lifecycle_transition",
        class: refs.length > 0 ? "risky" : "safe",
        reason: refs.length > 0
          ? "actions/hooks reference removed transition"
          : "transition removal changes behavior but not existing data",
        facts: { references: refs },
        suggestion: "review workflows/actions before removing transition",
      });
    }
  }
  return issues;
}

function transitionKeys(lifecycle: Lifecycle): Set<string> {
  const keys = new Set<string>();
  for (const t of lifecycle.transitions ?? []) {
    const froms = Array.isArray(t.from) ? t.from : [t.from];
    for (const from of froms) keys.add(`${from}->${t.to}`);
  }
  return keys;
}

function classifyActions(s: Scenario): Issue[] {
  const issues: Issue[] = [];
  const cur = s.current.actions ?? {};
  const next = s.desired.actions ?? {};
  for (const name of new Set([...Object.keys(cur), ...Object.keys(next)])) {
    if (!cur[name] && next[name]) {
      issues.push({
        id: `action:add:${name}`,
        target: name,
        change: "add_action",
        class: "safe",
        reason: "new action is additive",
        suggestion: "register action",
      });
    } else if (cur[name] && !next[name]) {
      issues.push({
        id: `action:remove:${name}`,
        target: name,
        change: "remove_action",
        class: (s.live.references?.[`action:${name}`]?.length ?? 0)
          ? "destructive"
          : "risky",
        reason: "removing action can break agents or workflows",
        facts: { references: s.live.references?.[`action:${name}`] ?? [] },
        suggestion: "deprecate action before removal",
      });
    } else if (JSON.stringify(cur[name]) !== JSON.stringify(next[name])) {
      issues.push({
        id: `action:change:${name}`,
        target: name,
        change: "change_action",
        class: "risky",
        reason: "action behavior/input may change agent contract",
        suggestion: "preview changed input/availability/hook behavior",
      });
    }
  }
  return issues;
}

function classifyHooks(s: Scenario): Issue[] {
  const issues: Issue[] = [];
  const cur = s.current.hooks ?? {};
  const next = s.desired.hooks ?? {};
  for (const name of new Set([...Object.keys(cur), ...Object.keys(next)])) {
    if (!cur[name] && next[name]) {
      issues.push({
        id: `hook:add:${name}`,
        target: name,
        change: "add_hook",
        class: "safe",
        reason: "new unreferenced hook is additive",
        suggestion: "register hook",
      });
    } else if (cur[name] && !next[name]) {
      issues.push({
        id: `hook:remove:${name}`,
        target: name,
        change: "remove_hook",
        class: (s.live.references?.[`hook:${name}`]?.length ?? 0)
          ? "destructive"
          : "safe",
        reason: "hook removal breaks references if attached",
        facts: { references: s.live.references?.[`hook:${name}`] ?? [] },
        suggestion: "remove attachments before removing hook",
      });
    } else if (JSON.stringify(cur[name]) !== JSON.stringify(next[name])) {
      issues.push({
        id: `hook:change:${name}`,
        target: name,
        change: "change_hook",
        class: "risky",
        reason: "hook script/config digest changed",
        suggestion: "run fixtures/sample previews; record new digest",
      });
    }
  }
  return issues;
}

function generatedCast(a: Field, b: Field): string | null {
  if (a.type === "integer" && b.type === "string") return "integer_to_string";
  if (a.type === "integer" && b.type === "decimal") return "integer_to_decimal";
  if (a.type === "decimal" && b.type === "string") return "decimal_to_string";
  return null;
}

function isWidening(a: Field, b: Field): boolean {
  return (a.type === "integer" && b.type === "decimal") ||
    (a.type === "string" && b.type === "string" &&
      (b.maxLength ?? 0) > (a.maxLength ?? 0));
}
export function summarize(issues: Issue[]) {
  const counts: Record<string, number> = {
    safe: 0,
    risky: 0,
    destructive: 0,
    blocking: 0,
  };
  for (const i of issues) counts[i.class]++;
  const overall: Class = counts.blocking
    ? "blocking"
    : counts.destructive
    ? "destructive"
    : counts.risky
    ? "risky"
    : "safe";
  return { overall, counts, total: issues.length };
}
function buildPlan(_s: Scenario, issues: Issue[]) {
  const plan: string[] = [];
  const blockers = issues.filter((i) => i.class === "blocking");
  if (blockers.length) {
    plan.push(
      "Resolve blocking data violations before enforcement/destructive cleanup.",
    );
  }
  for (const i of issues) {
    if (i.class === "safe") plan.push(`AUTO: ${i.suggestion} (${i.target})`);
    if (i.class === "risky") plan.push(`REVIEW: ${i.suggestion} (${i.target})`);
    if (i.class === "destructive") {
      plan.push(`STAGE: ${i.suggestion} (${i.target})`);
    }
    if (i.class === "blocking") {
      plan.push(`BLOCKED: ${i.suggestion} (${i.target})`);
    }
  }
  if (issues.some((i) => i.class === "destructive")) {
    plan.push(
      "Generate digest-bound confirmation token before any destructive drop/contract step.",
    );
  }
  return plan;
}

if (import.meta.main) await main();
