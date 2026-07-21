// deno-lint-ignore-file no-import-prefix
import { isMap, isScalar, parseAllDocuments, visit } from "npm:yaml@2";
import {
  type PackKind,
  schemaByKind,
  validatePackDocument,
} from "../../../schemas/packs/pack_schemas.ts";
import { validateHookContract } from "../../../schemas/hooks/hook_contract.ts";

export type JsonValue = null | boolean | number | string | JsonValue[] | {
  [key: string]: JsonValue;
};
export type UploadedPackFile = {
  path: string;
  text: string;
  kind?: "config" | "script";
};
export type NormalizedDefinition = {
  kind: PackKind;
  path: string;
  name: string;
  publisher: string;
  pack: string;
  identity: string;
  document: Record<string, JsonValue>;
  spec: Record<string, JsonValue>;
};
export type LoadedPack = {
  publisher: string;
  name: string;
  version: string;
  revision: string;
  sourceDigest: string;
  manifest: Record<string, JsonValue>;
  normalized: Record<string, JsonValue>;
  sourceFiles: Array<
    { path: string; kind: "config" | "script"; digest: string; content: string }
  >;
  resources: Record<string, NormalizedDefinition>;
  relationships: Record<string, NormalizedDefinition>;
  lifecycles: Record<string, NormalizedDefinition>;
  actions: Record<string, NormalizedDefinition>;
  hooks: Record<
    string,
    NormalizedDefinition & {
      script: string;
      scriptDigest: string;
      securityDigest: string;
    }
  >;
  roles: Record<string, NormalizedDefinition>;
  policies: Record<string, NormalizedDefinition>;
  seeds: Record<string, NormalizedDefinition>;
  scripts: Record<string, { path: string; digest: string; content: string }>;
};

const childName = "[a-z][a-z0-9_]{0,62}";
const allowedPath = new RegExp(
  `^(pack\\.yaml|(?:resources|relationships|lifecycles|actions|roles|policies|seeds)/${childName}\\.yaml|hooks/${childName}\\.(?:yaml|ts))$`,
);
const DOMAIN_POLICY_ACTIONS = new Set([
  "read",
  "read_archived",
  "history.read",
  "create",
  "update",
  "archive",
  "transition",
  "link",
  "unlink",
  "comment",
]);
const dirKind: Record<string, PackKind> = {
  resources: "Resource",
  relationships: "Relationship",
  lifecycles: "Lifecycle",
  actions: "Action",
  hooks: "Hook",
  roles: "Role",
  policies: "Policy",
  seeds: "Seed",
};

export async function loadPackFromFiles(
  inputFiles: UploadedPackFile[],
): Promise<LoadedPack> {
  if (inputFiles.length === 0) throw new Error("pack upload is empty");
  const files = inputFiles.map((file) => {
    const path = validateUploadPath(file.path);
    if (file.text.length === 0) throw new Error(`${path}: empty pack file`);
    return {
      ...file,
      path,
      kind: file.kind ??
        (path.endsWith(".ts") ? "script" as const : "config" as const),
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) {
      throw new Error(`duplicate pack path ${file.path}`);
    }
    paths.add(file.path);
    if (!allowedPath.test(file.path)) {
      throw new Error(`unexpected pack path ${file.path}`);
    }
    if ((file.path.endsWith(".ts")) !== (file.kind === "script")) {
      throw new Error(`${file.path}: file kind does not match extension`);
    }
  }
  const manifestFile = files.find((file) => file.path === "pack.yaml");
  if (!manifestFile) throw new Error("missing pack.yaml");
  const manifest = parseYamlJsonObject(manifestFile.text, "pack.yaml");
  assertKind(manifest, "Pack", "pack.yaml");
  validateOrThrow("Pack", manifest, "pack.yaml");
  const metadata = asRecord(manifest.metadata, "pack.yaml.metadata");
  const publisher = requiredString(
    metadata.publisher,
    "pack.yaml.metadata.publisher",
  );
  const name = requiredString(metadata.name, "pack.yaml.metadata.name");
  const version = requiredString(
    metadata.version,
    "pack.yaml.metadata.version",
  );
  const pack = {
    publisher,
    name,
    version,
    manifest,
    normalized: {},
    sourceFiles: [],
    resources: {},
    relationships: {},
    lifecycles: {},
    actions: {},
    hooks: {},
    roles: {},
    policies: {},
    seeds: {},
    scripts: {},
  } as Omit<LoadedPack, "revision" | "sourceDigest"> & {
    revision?: string;
    sourceDigest?: string;
  };

  for (const file of files) {
    if (
      file.kind === "script" &&
      /\bimport\s*(?:\(|[A-Za-z_$*{])|\bexport\s+(?:\*|{[^}]*})\s+from\s*["']/m
        .test(file.text)
    ) throw new Error(`${file.path}: hook imports are not supported`);
    const digest = await sha256(file.text);
    pack.sourceFiles.push({
      path: file.path,
      kind: file.kind,
      digest,
      content: file.text,
    });
    if (file.kind === "script") {
      pack.scripts[file.path] = { path: file.path, digest, content: file.text };
    }
  }
  pack.sourceDigest = await sha256(
    canonicalJson(
      pack.sourceFiles.map(({ path, kind, digest }) => ({
        path,
        kind,
        digest,
      })),
    ),
  );

  for (const file of files) {
    if (file.path === "pack.yaml" || file.kind === "script") continue;
    const [dir, filename] = file.path.split("/");
    const expectedKind = dirKind[dir];
    const basename = filename.slice(0, -5);
    const document = parseYamlJsonObject(file.text, file.path);
    assertKind(document, expectedKind, file.path);
    validateOrThrow(expectedKind, document, file.path);
    const objectName = requiredString(
      asRecord(document.metadata, `${file.path}.metadata`).name,
      `${file.path}.metadata.name`,
    );
    if (objectName !== basename) {
      throw new Error(
        `${file.path}: metadata.name '${objectName}' must match basename '${basename}'`,
      );
    }
    qualifyDocument(document, expectedKind, publisher, name);
    validateOrThrow(expectedKind, document, file.path);
    const spec = asRecord(document.spec, `${file.path}.spec`);
    const def: NormalizedDefinition = {
      kind: expectedKind,
      path: file.path,
      name: objectName,
      publisher,
      pack: name,
      identity: `${publisher}/${name}:${objectName}`,
      document,
      spec,
    };
    if (expectedKind === "Hook") {
      const script = requiredString(spec.script, `${file.path}.spec.script`);
      if (script !== `${basename}.ts`) {
        throw new Error(`${file.path}: script must be ${basename}.ts`);
      }
      const scriptFile = pack.scripts[`hooks/${script}`];
      if (!scriptFile) {
        throw new Error(
          `${file.path}: referenced hook script ${script} is missing`,
        );
      }
      let security;
      try {
        security = await validateHookContract(
          def.identity,
          spec,
          scriptFile.digest,
          scriptFile.content,
        );
      } catch (error) {
        throw new Error(
          `${file.path}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      document.spec = security.normalized as JsonValue;
      def.spec = security.normalized as Record<string, JsonValue>;
      pack.hooks[objectName] = {
        ...def,
        script,
        scriptDigest: scriptFile.digest,
        securityDigest: security.securityDigest,
      };
    } else {
      definitionMap(pack, expectedKind)[objectName] = def;
    }
  }
  for (const scriptPath of Object.keys(pack.scripts)) {
    const name = basenameFromPath(scriptPath).slice(0, -3);
    if (!pack.hooks[name]) {
      throw new Error(
        `${scriptPath}: hook script requires paired hooks/${name}.yaml`,
      );
    }
  }
  validateReferences(pack as LoadedPack);
  pack.normalized = canonicalize({
    pack: pack.manifest,
    resources: docs(pack.resources),
    relationships: docs(pack.relationships),
    lifecycles: docs(pack.lifecycles),
    actions: docs(pack.actions),
    hooks: docs(pack.hooks),
    roles: docs(pack.roles),
    policies: docs(pack.policies),
    seeds: docs(pack.seeds),
    scripts: Object.fromEntries(
      Object.entries(pack.scripts).map((
        [path, script],
      ) => [path, script.digest]),
    ),
  }) as Record<string, JsonValue>;
  const contentDigest = await sha256(canonicalJson(pack.normalized));
  pack.revision = `${publisher}/${name}@${version}:${contentDigest}`;
  return pack as LoadedPack;
}

export function parseYamlJsonObject(
  text: string,
  path: string,
): Record<string, JsonValue> {
  const docs = parseAllDocuments(text, {
    merge: true,
    uniqueKeys: true,
    schema: "core",
  });
  if (docs.length !== 1) {
    throw new Error(`${path}: expected exactly one YAML document`);
  }
  const doc = docs[0];
  if (doc.errors.length) {
    throw new Error(`${path}: ${doc.errors.map((e) => e.message).join("; ")}`);
  }
  let customTag = false;
  let nonStringKey = false;
  visit(doc, (_key, node) => {
    if (node && typeof node === "object" && "tag" in node) {
      const tag = String((node as { tag?: string }).tag ?? "");
      if (tag && !tag.startsWith("tag:yaml.org,2002:")) customTag = true;
    }
    if (isMap(node)) {
      for (const pair of node.items) {
        if (
          !isScalar(pair.key) ||
          (typeof pair.key.value !== "string" && pair.key.source !== "<<")
        ) nonStringKey = true;
      }
    }
  });
  if (customTag) throw new Error(`${path}: custom YAML tags are not allowed`);
  if (nonStringKey) {
    throw new Error(`${path}: YAML mapping keys must be strings`);
  }
  try {
    return asRecord(canonicalize(doc.toJS({ maxAliasCount: 100 })), path);
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
export function canonicalize(value: unknown): JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error("only JSON safe integers are allowed as pack numbers");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object" && value) {
    if (
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    ) throw new Error("non-JSON object is not allowed");
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error(`non-JSON value is not allowed: ${String(value)}`);
}

function qualifyDocument(
  document: Record<string, JsonValue>,
  kind: PackKind,
  publisher: string,
  pack: string,
) {
  const spec = asRecord(document.spec, "spec");
  const qualify = (value: unknown) => {
    if (typeof value !== "string") return value;
    if (value === "system:principal" || value.includes("/")) return value;
    if (value.includes(".") || value.includes(":")) {
      throw new Error(`legacy or malformed identity '${value}' is not allowed`);
    }
    return `${publisher}/${pack}:${value}`;
  };
  if (kind === "Resource") {
    for (const field of Object.values(asRecord(spec.fields, "spec.fields"))) {
      const f = asRecord(field, "field");
      if (f.ref) {
        f.ref = qualify(f.ref) as string;
      }
    }
  }
  if (kind === "Relationship") {
    asRecord(spec.from, "spec.from").resource = qualify(
      asRecord(spec.from, "spec.from").resource,
    ) as string;
    asRecord(spec.to, "spec.to").resource = qualify(
      asRecord(spec.to, "spec.to").resource,
    ) as string;
  }
  if (kind === "Lifecycle" || kind === "Seed") {
    spec.resource = qualify(spec.resource) as string;
  }
  if (kind === "Action") {
    if (spec.input) {
      for (const field of Object.values(asRecord(spec.input, "spec.input"))) {
        const descriptor = asRecord(field, "action input field");
        if (descriptor.ref) descriptor.ref = qualify(descriptor.ref) as string;
      }
    }
    if (spec.reads) {
      for (const read of Object.values(asRecord(spec.reads, "spec.reads"))) {
        asRecord(read, "read").resource = qualify(
          asRecord(read, "read").resource,
        ) as string;
      }
    }
    if (spec.availability) {
      asRecord(spec.availability, "spec.availability").resource = qualify(
        asRecord(spec.availability, "spec.availability").resource,
      ) as string;
    }
  }
  if (kind === "Hook") {
    for (
      const effect of asArray(
        asRecord(spec.effects, "spec.effects").operations,
        "spec.effects.operations",
      )
    ) {
      asRecord(effect, "effect").resource = qualify(
        asRecord(effect, "effect").resource,
      ) as string;
    }
    for (const attachment of asArray(spec.attachments, "spec.attachments")) {
      const a = asRecord(attachment, "attachment");
      if (a.resource) a.resource = qualify(a.resource) as string;
      if (a.action) a.action = qualify(a.action) as string;
    }
  }
  if (kind === "Policy") {
    for (const rule of asArray(spec.rules, "spec.rules")) {
      const r = asRecord(rule, "rule");
      r.roles = asArray(r.roles, "roles").map(qualify) as JsonValue[];
      r.resources = asArray(r.resources, "resources").map(
        qualify,
      ) as JsonValue[];
      if (r.relation) {
        asRecord(r.relation, "relation").relationship = qualify(
          asRecord(r.relation, "relation").relationship,
        ) as string;
      }
      r.actions = asArray(r.actions, "actions").map((action) =>
        typeof action === "string" && /^(?:action|seed):[^/]+$/.test(action)
          ? `${action.split(":")[0]}:${publisher}/${pack}:${
            action.split(":")[1]
          }`
          : action
      ) as JsonValue[];
    }
  }
}

function validateReferences(pack: LoadedPack) {
  const local = (
    identity: unknown,
    defs: Record<string, unknown>,
    path: string,
  ) => {
    if (typeof identity !== "string") return;
    const prefix = `${pack.publisher}/${pack.name}:`;
    if (identity.startsWith(prefix) && !defs[identity.slice(prefix.length)]) {
      throw new Error(`${path}: unknown reference ${identity}`);
    }
  };
  const reservedFields = new Set([
    "id",
    "project_id",
    "version",
    "current_version",
    "created_at",
    "updated_at",
    "archived_at",
    "created_by",
    "updated_by",
  ]);
  for (const def of Object.values(pack.resources)) {
    for (
      const [name, field] of Object.entries(
        asRecord(def.spec.fields, `${def.path}.spec.fields`),
      )
    ) {
      if (reservedFields.has(name)) {
        throw new Error(
          `${def.path}.spec.fields.${name}: reserved platform field`,
        );
      }
      const f = asRecord(field, name);
      if (f.ref) {
        local(f.ref, pack.resources, `${def.path}.spec.fields.${name}.ref`);
      }
      if (f.ref && (f.enum || f.format)) {
        throw new Error(
          `${def.path}.spec.fields.${name}: ref cannot be combined with enum or format`,
        );
      }
      if (
        typeof f.minLength === "number" && typeof f.maxLength === "number" &&
        f.minLength > f.maxLength
      ) {
        throw new Error(
          `${def.path}.spec.fields.${name}: minLength exceeds maxLength`,
        );
      }
      if (
        f.type === "decimal" && typeof f.precision === "number" &&
        typeof f.scale === "number" && f.scale > f.precision
      ) {
        throw new Error(
          `${def.path}.spec.fields.${name}: scale exceeds precision`,
        );
      }
    }
  }
  for (const def of Object.values(pack.relationships)) {
    local(
      asRecord(def.spec.from, "from").resource,
      pack.resources,
      `${def.path}.spec.from.resource`,
    );
    const to = asRecord(def.spec.to, "to").resource;
    if (to !== "system:principal") {
      local(to, pack.resources, `${def.path}.spec.to.resource`);
    }
    const from = asRecord(def.spec.from, "from").resource;
    if (from !== "system:principal") {
      local(from, pack.resources, `${def.path}.spec.from.resource`);
    }
    const relationshipFields = asRecord(def.spec.fields ?? {}, "fields");
    for (const reserved of ["from", "to", "from_id", "to_id"]) {
      if (reserved in relationshipFields) {
        throw new Error(
          `${def.path}.spec.fields.${reserved}: reserved relationship field`,
        );
      }
    }
  }
  const lifecycleResources = new Set<string>();
  for (const def of Object.values(pack.lifecycles)) {
    local(def.spec.resource, pack.resources, `${def.path}.spec.resource`);
    if (lifecycleResources.has(String(def.spec.resource))) {
      throw new Error(`${def.path}: resource has more than one lifecycle`);
    }
    lifecycleResources.add(String(def.spec.resource));
    const resource =
      pack.resources[String(def.spec.resource).split(":").pop()!];
    const field = resource &&
      asRecord(resource.spec.fields, "fields")[String(def.spec.field)];
    if (
      !field || asRecord(field, "field").type !== "string" ||
      asRecord(field, "field").required !== true
    ) {
      throw new Error(
        `${def.path}: lifecycle field must be a required string field`,
      );
    }
    validateLifecycle(def, resource, asRecord(field, "field"));
  }
  for (const def of Object.values(pack.actions)) {
    if (def.spec.reads) {
      for (const read of Object.values(asRecord(def.spec.reads, "reads"))) {
        local(
          asRecord(read, "read").resource,
          pack.resources,
          `${def.path}.spec.reads`,
        );
      }
    }
    const attached = Object.values(pack.hooks).some((hook) =>
      asArray(hook.spec.attachments, "attachments").some((attachment) =>
        asRecord(attachment, "attachment").phase === "action.stage" &&
        asRecord(attachment, "attachment").action === def.identity
      )
    );
    if (!attached) {
      throw new Error(
        `${def.path}: action has no action.stage hook attachment`,
      );
    }
  }
  for (const def of Object.values(pack.policies)) {
    for (const rule of asArray(def.spec.rules, "rules")) {
      const r = asRecord(rule, "rule");
      for (const role of asArray(r.roles, "roles")) {
        local(role, pack.roles, `${def.path}.roles`);
      }
      for (const resource of asArray(r.resources, "resources")) {
        local(resource, pack.resources, `${def.path}.resources`);
      }
      for (const action of asArray(r.actions, "actions")) {
        if (typeof action !== "string" || action === "*") {
          throw new Error(
            `${def.path}: wildcard or non-string policy action is not allowed`,
          );
        }
        if (action.startsWith(`action:${pack.publisher}/${pack.name}:`)) {
          local(
            action.slice("action:".length),
            pack.actions,
            `${def.path}.actions`,
          );
        } else if (action.startsWith(`seed:${pack.publisher}/${pack.name}:`)) {
          local(
            action.slice("seed:".length),
            pack.seeds,
            `${def.path}.actions`,
          );
        } else if (!DOMAIN_POLICY_ACTIONS.has(action)) {
          throw new Error(`${def.path}: unknown policy action ${action}`);
        }
      }
    }
  }
  for (const def of Object.values(pack.seeds)) {
    local(def.spec.resource, pack.resources, `${def.path}.spec.resource`);
    const resource =
      pack.resources[String(def.spec.resource).split(":").pop()!];
    const fields = asRecord(resource.spec.fields, "fields");
    const key = asRecord(fields[String(def.spec.key)], "seed key");
    if (key.required !== true || key.unique !== true) {
      throw new Error(
        `${def.path}: seed key must be a required unique resource field`,
      );
    }
    const seen = new Set<string>();
    for (const row of asArray(def.spec.rows, "rows")) {
      const values = asRecord(row, "row");
      for (const [field, value] of Object.entries(values)) {
        if (!fields[field]) {
          throw new Error(
            `${def.path}: seed row contains undeclared field ${field}`,
          );
        }
        validateSeedValue(
          asRecord(fields[field], `${def.path}.resource.fields.${field}`),
          value,
          `${def.path}.spec.rows.${field}`,
        );
      }
      for (const [field, descriptor] of Object.entries(fields)) {
        if (
          asRecord(descriptor, field).required === true &&
          !(field in values)
        ) {
          throw new Error(
            `${def.path}: seed row omits required field ${field}`,
          );
        }
      }
      const keyValue = canonicalJson(values[String(def.spec.key)]);
      if (seen.has(keyValue)) {
        throw new Error(`${def.path}: duplicate seed key ${keyValue}`);
      }
      seen.add(keyValue);
    }
  }
}

function validateLifecycle(
  lifecycle: NormalizedDefinition,
  resource: NormalizedDefinition,
  lifecycleField: Record<string, JsonValue>,
) {
  const path = lifecycle.path;
  const fields = asRecord(resource.spec.fields, `${resource.path}.spec.fields`);
  const stateRecords = asArray(lifecycle.spec.states, `${path}.spec.states`)
    .map(
      (state, index) => asRecord(state, `${path}.spec.states.${index}`),
    );
  const stateNames = stateRecords.map((state) => String(state.name));
  assertUniqueNames(stateNames, `${path}.spec.states`, "state");
  const initial = String(lifecycle.spec.initial);
  const initialState = stateRecords.find((state) => state.name === initial);
  if (!initialState) {
    throw new Error(`${path}.spec.initial: unknown lifecycle state ${initial}`);
  }
  if (initialState.terminal === true) {
    throw new Error(
      `${path}.spec.initial: initial lifecycle state must be nonterminal`,
    );
  }
  const enumValues = Array.isArray(lifecycleField.enum)
    ? lifecycleField.enum.map(String)
    : null;
  if (
    enumValues &&
    (enumValues.some((value) => !stateNames.includes(value)) ||
      stateNames.some((value) => !enumValues.includes(value)))
  ) {
    throw new Error(
      `${path}.spec.states: lifecycle states must exactly match the lifecycle field enum`,
    );
  }
  for (const state of stateRecords) {
    validateStringConstant(
      lifecycleField,
      String(state.name),
      `${path}.spec.states.${state.name}.name`,
    );
    for (
      const required of asArray(
        state.required_fields ?? [],
        `${path}.spec.states.${state.name}.required_fields`,
      )
    ) {
      if (!fields[String(required)]) {
        throw new Error(
          `${path}.spec.states.${state.name}.required_fields: undeclared resource field ${required}`,
        );
      }
    }
  }
  const transitions = asArray(
    lifecycle.spec.transitions,
    `${path}.spec.transitions`,
  ).map((transition, index) =>
    asRecord(transition, `${path}.spec.transitions.${index}`)
  );
  assertUniqueNames(
    transitions.map((transition) => String(transition.name)),
    `${path}.spec.transitions`,
    "transition",
  );
  const terminalStates = new Set(
    stateRecords.filter((state) => state.terminal === true).map((state) =>
      String(state.name)
    ),
  );
  const reachable = new Set([initial]);
  for (const transition of transitions) {
    const transitionPath = `${path}.spec.transitions.${transition.name}`;
    const fromStates = asArray(transition.from, `${transitionPath}.from`).map(
      String,
    );
    for (const from of fromStates) {
      if (!stateNames.includes(from)) {
        throw new Error(
          `${transitionPath}.from: unknown lifecycle state ${from}`,
        );
      }
      if (terminalStates.has(from)) {
        throw new Error(
          `${transitionPath}.from: terminal state ${from} cannot have outgoing transitions`,
        );
      }
    }
    const to = String(transition.to);
    if (!stateNames.includes(to)) {
      throw new Error(`${transitionPath}.to: unknown lifecycle state ${to}`);
    }
    const set = asRecord(transition.set ?? {}, `${transitionPath}.set`);
    const unset = asArray(transition.unset ?? [], `${transitionPath}.unset`)
      .map(
        String,
      );
    for (const fieldName of Object.keys(set)) {
      const descriptor = fields[fieldName];
      if (!descriptor) {
        throw new Error(
          `${transitionPath}.set.${fieldName}: undeclared resource field`,
        );
      }
      if (fieldName === lifecycle.spec.field) {
        throw new Error(
          `${transitionPath}.set.${fieldName}: lifecycle field is mutated by transition.to`,
        );
      }
      validateFieldConstant(
        asRecord(descriptor, `${resource.path}.spec.fields.${fieldName}`),
        set[fieldName],
        `${transitionPath}.set.${fieldName}`,
      );
    }
    for (const fieldName of unset) {
      const descriptor = fields[fieldName];
      if (!descriptor) {
        throw new Error(
          `${transitionPath}.unset: undeclared resource field ${fieldName}`,
        );
      }
      if (fieldName === lifecycle.spec.field) {
        throw new Error(
          `${transitionPath}.unset: lifecycle field is mutated by transition.to`,
        );
      }
      if (asRecord(descriptor, fieldName).required === true) {
        throw new Error(
          `${transitionPath}.unset: required field ${fieldName} cannot be unset`,
        );
      }
      if (fieldName in set) {
        throw new Error(
          `${transitionPath}: set and unset mutations overlap at ${fieldName}`,
        );
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const transition of transitions) {
      if (
        asArray(transition.from, "from").some((from) =>
          reachable.has(String(from))
        ) && !reachable.has(String(transition.to))
      ) {
        reachable.add(String(transition.to));
        changed = true;
      }
    }
  }
  const unreachable = stateNames.filter((state) => !reachable.has(state));
  if (unreachable.length) {
    throw new Error(
      `${path}.spec.states: unreachable lifecycle states ${
        unreachable.join(",")
      }`,
    );
  }
}

function assertUniqueNames(values: string[], path: string, kind: string) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`${path}: duplicate ${kind} name ${value}`);
    }
    seen.add(value);
  }
}

function validateFieldConstant(
  descriptor: Record<string, JsonValue>,
  value: JsonValue,
  path: string,
) {
  validateSeedValue(descriptor, value, path);
  if (descriptor.type === "string") {
    validateStringConstant(descriptor, String(value), path);
  }
  if (descriptor.type === "integer" && typeof value === "number") {
    if (typeof descriptor.minimum === "number" && value < descriptor.minimum) {
      throw new Error(`${path}: value is below minimum`);
    }
    if (typeof descriptor.maximum === "number" && value > descriptor.maximum) {
      throw new Error(`${path}: value exceeds maximum`);
    }
  }
  if (descriptor.type === "decimal" && typeof value === "string") {
    const numeric = Number(value);
    if (
      typeof descriptor.minimum === "string" &&
      numeric < Number(descriptor.minimum)
    ) throw new Error(`${path}: value is below minimum`);
    if (
      typeof descriptor.maximum === "string" &&
      numeric > Number(descriptor.maximum)
    ) throw new Error(`${path}: value exceeds maximum`);
    const [integer, fraction = ""] = value.replace("-", "").split(".");
    if (
      typeof descriptor.scale === "number" && fraction.length > descriptor.scale
    ) throw new Error(`${path}: decimal scale exceeds field scale`);
    if (
      typeof descriptor.precision === "number" &&
      integer.length + fraction.length > descriptor.precision
    ) throw new Error(`${path}: decimal precision exceeds field precision`);
  }
}

function validateStringConstant(
  descriptor: Record<string, JsonValue>,
  value: string,
  path: string,
) {
  if (Array.isArray(descriptor.enum) && !descriptor.enum.includes(value)) {
    throw new Error(`${path}: value is not in field enum`);
  }
  if (
    typeof descriptor.minLength === "number" &&
    [...value].length < descriptor.minLength
  ) throw new Error(`${path}: value is shorter than minLength`);
  if (
    typeof descriptor.maxLength === "number" &&
    [...value].length > descriptor.maxLength
  ) throw new Error(`${path}: value exceeds maxLength`);
  if (
    (descriptor.format === "uuid" || descriptor.ref) &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) throw new Error(`${path}: value is not a UUID`);
  if (
    descriptor.format === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)
  ) throw new Error(`${path}: value is not an email`);
  if (descriptor.format === "uri") {
    try {
      new URL(value);
    } catch {
      throw new Error(`${path}: value is not a URI`);
    }
  }
}

function validateSeedValue(
  descriptor: Record<string, JsonValue>,
  value: JsonValue,
  path: string,
) {
  const type = descriptor.type;
  const valid = type === "integer"
    ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string";
  if (!valid) {
    const expected = type === "decimal" ? "canonical decimal string" : type;
    throw new Error(`${path}: expected ${expected}`);
  }
  if (
    type === "decimal" &&
    !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(String(value))
  ) {
    throw new Error(`${path}: expected canonical decimal string`);
  }
  if (type === "date") {
    const text = String(value);
    const parsed = new Date(`${text}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== text
    ) {
      throw new Error(`${path}: expected valid YYYY-MM-DD date`);
    }
  }
  if (type === "timestamp") {
    const text = String(value);
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(text) ||
      Number.isNaN(Date.parse(text))
    ) {
      throw new Error(`${path}: expected UTC RFC 3339 timestamp`);
    }
  }
}

function definitionMap(
  pack: Omit<LoadedPack, "revision" | "sourceDigest">,
  kind: PackKind,
): Record<string, NormalizedDefinition> {
  switch (kind) {
    case "Resource":
      return pack.resources;
    case "Relationship":
      return pack.relationships;
    case "Lifecycle":
      return pack.lifecycles;
    case "Action":
      return pack.actions;
    case "Role":
      return pack.roles;
    case "Policy":
      return pack.policies;
    case "Seed":
      return pack.seeds;
    default:
      throw new Error(`unsupported definition kind ${kind}`);
  }
}
function validateOrThrow(kind: PackKind, value: unknown, path: string) {
  const issues = validatePackDocument(kind, value);
  if (issues.length) {
    throw new Error(
      `${path}: ${
        issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")
      }`,
    );
  }
}
function assertKind(
  value: Record<string, JsonValue>,
  kind: PackKind | undefined,
  path: string,
) {
  if (
    !kind || typeof value.kind !== "string" ||
    !Object.prototype.hasOwnProperty.call(schemaByKind, value.kind) ||
    value.kind !== kind
  ) {
    throw new Error(`${path}: expected kind ${kind ?? "for directory"}`);
  }
}
function docs(defs: Record<string, NormalizedDefinition>) {
  return Object.fromEntries(
    Object.entries(defs).map(([name, def]) => [name, def.document]),
  );
}
function asRecord(value: unknown, path: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path}: expected object`);
  }
  return value as Record<string, JsonValue>;
}
function asArray(value: unknown, path: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected array`);
  return value;
}
function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${path}: expected non-empty string`);
  }
  return value;
}
function basenameFromPath(path: string): string {
  return path.split("/").pop() ?? path;
}
function validateUploadPath(path: string): string {
  if (
    !path || path.includes("\\") || path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) throw new Error(`invalid pack path ${path}`);
  return path;
}
async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return "sha256:" +
    Array.from(new Uint8Array(hash)).map((byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
}
