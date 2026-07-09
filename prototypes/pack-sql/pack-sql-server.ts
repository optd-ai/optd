import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
type UploadedFile = { path: string; text: string; kind: "config" | "script" };
type NormalizedPack = {
  namespace: string;
  name: string;
  version: string;
  revision: string;
  manifest: Json;
  resources: Record<string, ResourceSpec>;
  actions: Record<string, Json>;
  hooks: Record<string, HookSpec>;
  relationships: Record<string, RelationshipSpec>;
  lifecycles: Record<string, Json>;
  policies: Record<string, Json>;
  seeds: Record<string, SeedSpec>;
  scripts: Record<
    string,
    { path: string; content: string; digest: string; bytes: number }
  >;
};
type ResourceSpec = {
  fields?: Record<string, FieldSpec>;
  lifecycle?: Json;
  indexes?: Json[];
};
type FieldSpec = { type: string; required?: boolean; ref?: string };
type HookSpec = { script?: string; output?: Json; permissions?: Json };
type RelationshipSpec = {
  from?: { resource?: string; field?: string };
  to?: { resource?: string; field?: string };
  fields?: Record<string, FieldSpec>;
};
type SeedSpec = { resource?: string; key?: string; rows?: Json[] };
type CompileStep = {
  kind: string;
  target: string;
  sql?: string;
  details?: Json;
};

type App = {
  db: PGlite;
  handler: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};

export async function createApp(): Promise<App> {
  const db = new PGlite();
  await initializePlatform(db);
  return {
    db,
    handler: (request) => route(db, request),
    close: async () => await db.close(),
  };
}

export async function startServer(port = 0) {
  const app = await createApp();
  const server = Deno.serve({ hostname: "127.0.0.1", port }, app.handler);
  return {
    app,
    url: `http://127.0.0.1:${server.addr.port}`,
    close: async () => {
      await server.shutdown();
      await app.close();
    },
  };
}

async function initializePlatform(db: PGlite) {
  await db.exec(`
    create table pack_revisions(
      revision text primary key,
      namespace text not null,
      name text not null,
      version text not null,
      active boolean not null default false,
      manifest jsonb not null,
      normalized jsonb not null,
      created_at timestamptz default now()
    );
    create table pack_files(
      revision text not null references pack_revisions(revision),
      path text not null,
      digest text not null,
      bytes integer not null,
      kind text not null,
      content text not null,
      primary key(revision, path)
    );
    create table resource_definitions(
      revision text not null references pack_revisions(revision),
      namespace text not null,
      name text not null,
      table_name text not null,
      spec jsonb not null,
      primary key(revision, namespace, name)
    );
    create table field_definitions(
      revision text not null references pack_revisions(revision),
      resource text not null,
      name text not null,
      type text not null,
      required boolean not null,
      ref text,
      primary key(revision, resource, name)
    );
    create table hook_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      script_path text not null,
      script_digest text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table action_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table relationship_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      table_name text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table lifecycle_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table policy_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table seed_definitions(
      revision text not null references pack_revisions(revision),
      name text not null,
      resource text not null,
      key_field text not null,
      spec jsonb not null,
      primary key(revision, name)
    );
    create table seed_records(
      revision text not null references pack_revisions(revision),
      seed_name text not null,
      resource text not null,
      key_value text not null,
      row_json jsonb not null,
      primary key(revision, seed_name, key_value)
    );
    create table pack_apply_events(
      id text primary key,
      revision text not null,
      event text not null,
      details jsonb not null,
      created_at timestamptz default now()
    );
  `);
}

async function route(db: PGlite, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/debug/schema") {
      return json(await inspectSchema(db));
    }
    if (request.method === "GET" && url.pathname === "/debug/platform") {
      return json(await inspectPlatform(db));
    }
    if (request.method === "POST" && url.pathname === "/packs/preview") {
      const uploaded = await readMultipartPack(request);
      const pack = normalizePack(uploaded);
      return json({
        ok: true,
        mode: "preview",
        pack: packSummary(pack),
        steps: compilePack(pack),
        databaseChanged: false,
      });
    }
    if (request.method === "POST" && url.pathname === "/packs/apply") {
      const uploaded = await readMultipartPack(request);
      const pack = normalizePack(uploaded);
      const steps = compilePack(pack);
      await applyPack(db, pack, uploaded, steps);
      return json({
        ok: true,
        mode: "apply",
        pack: packSummary(pack),
        steps,
        databaseChanged: true,
      });
    }
    return errorResponse("not_found", `${request.method} ${url.pathname}`, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(
      message.startsWith("bad_request:") ? "bad_request" : "internal_error",
      message,
      message.startsWith("bad_request:") ? 400 : 500,
    );
  }
}

async function readMultipartPack(request: Request): Promise<UploadedFile[]> {
  const form = await request.formData();
  const files: UploadedFile[] = [];
  for (const [key, value] of form.entries()) {
    if (!(value instanceof File)) continue;
    const path = key === "file" ? value.name : key;
    files.push({
      path,
      text: await value.text(),
      kind: path.endsWith(".ts") ? "script" : "config",
    });
  }
  if (!files.some((file) => file.path === "pack.yaml")) {
    throw new Error("bad_request: missing pack.yaml");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizePack(files: UploadedFile[]): NormalizedPack {
  validatePaths(files);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifest = readYamlAsJson(byPath.get("pack.yaml")!.text, "pack.yaml");
  if (manifest.kind !== "Pack") {
    throw new Error("bad_request: pack.yaml kind must be Pack");
  }
  const metadata = asRecord(manifest.metadata, "pack.metadata");
  const namespace = stringField(
    metadata,
    "namespace",
    "pack.metadata.namespace",
  );
  const name = stringField(metadata, "name", "pack.metadata.name");
  const version = stringField(metadata, "version", "pack.metadata.version");
  assertSnake(namespace, "namespace");
  assertSnake(name, "name");

  const resources: Record<string, ResourceSpec> = {};
  const actions: Record<string, Json> = {};
  const hooks: Record<string, HookSpec> = {};
  const relationships: Record<string, RelationshipSpec> = {};
  const lifecycles: Record<string, Json> = {};
  const policies: Record<string, Json> = {};
  const seeds: Record<string, SeedSpec> = {};
  const scripts: NormalizedPack["scripts"] = {};

  for (const file of files) {
    if (file.path.startsWith("resources/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Resource", file.path);
      const objectName = objectNameFromFileOrMetadata(
        doc,
        file.path,
        "resources/",
      );
      resources[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as ResourceSpec;
    }
    if (file.path.startsWith("actions/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Action", file.path);
      const objectName = objectNameFromFileOrMetadata(
        doc,
        file.path,
        "actions/",
      );
      actions[objectName] = asRecord(doc.spec ?? {}, `${file.path}.spec`);
    }
    if (file.path.startsWith("hooks/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Hook", file.path);
      const objectName = objectNameFromFileOrMetadata(doc, file.path, "hooks/");
      hooks[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as HookSpec;
    }
    if (file.path.startsWith("relationships/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Relationship", file.path);
      const objectName = objectNameFromFileOrMetadata(
        doc,
        file.path,
        "relationships/",
      );
      relationships[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as RelationshipSpec;
    }
    if (file.path.startsWith("lifecycles/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Lifecycle", file.path);
      const objectName = objectNameFromFileOrMetadata(
        doc,
        file.path,
        "lifecycles/",
      );
      lifecycles[objectName] = asRecord(doc.spec ?? {}, `${file.path}.spec`);
    }
    if (file.path.startsWith("policies/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Policy", file.path);
      const objectName = objectNameFromFileOrMetadata(
        doc,
        file.path,
        "policies/",
      );
      policies[objectName] = asRecord(doc.spec ?? {}, `${file.path}.spec`);
    }
    if (file.path.startsWith("seeds/") && file.path.endsWith(".yaml")) {
      const doc = readYamlAsJson(file.text, file.path);
      requireKind(doc, "Seed", file.path);
      const objectName = objectNameFromFileOrMetadata(doc, file.path, "seeds/");
      seeds[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as SeedSpec;
    }
    if (file.path.startsWith("hooks/") && file.path.endsWith(".ts")) {
      scripts[file.path] = {
        path: file.path,
        content: file.text,
        digest: digestText(file.text),
        bytes: file.text.length,
      };
    }
  }

  for (const [hookName, hook] of Object.entries(hooks)) {
    if (typeof hook.script !== "string") {
      throw new Error(`bad_request: hook ${hookName} must declare spec.script`);
    }
    if (hook.script.includes("/")) {
      throw new Error(
        `bad_request: hook ${hookName} script must be a basename, not a path`,
      );
    }
    const scriptPath = `hooks/${hook.script}`;
    if (!scripts[scriptPath]) {
      throw new Error(
        `bad_request: hook ${hookName} references missing script ${scriptPath}`,
      );
    }
  }
  for (const scriptPath of Object.keys(scripts)) {
    const hookName = scriptPath.slice("hooks/".length).replace(/\.ts$/, "");
    if (!hooks[hookName]) {
      throw new Error(
        `bad_request: hook script ${scriptPath} requires hooks/${hookName}.yaml`,
      );
    }
  }

  for (const [actionName, action] of Object.entries(actions)) {
    if (typeof action.hook === "string" && !hooks[action.hook]) {
      throw new Error(
        `bad_request: action ${actionName} references missing hook ${action.hook}`,
      );
    }
  }
  for (const [relName, rel] of Object.entries(relationships)) {
    if (!rel.from?.resource || !rel.to?.resource) {
      throw new Error(
        `bad_request: relationship ${relName} must declare from/to resources`,
      );
    }
    if (!resources[rel.from.resource]) {
      throw new Error(
        `bad_request: relationship ${relName} from resource missing ${rel.from.resource}`,
      );
    }
    if (!resources[rel.to.resource]) {
      throw new Error(
        `bad_request: relationship ${relName} to resource missing ${rel.to.resource}`,
      );
    }
  }
  for (const [seedName, seed] of Object.entries(seeds)) {
    if (!seed.resource || !seed.key || !Array.isArray(seed.rows)) {
      throw new Error(
        `bad_request: seed ${seedName} must declare resource, key, rows`,
      );
    }
  }

  const revision = `${namespace}.${name}@${version}:${
    digestText(
      JSON.stringify({
        manifest,
        resources,
        actions,
        hooks,
        relationships,
        lifecycles,
        policies,
        seeds,
        scripts: Object.fromEntries(
          Object.entries(scripts).map(([k, v]) => [k, v.digest]),
        ),
      }),
    )
  }`;
  return {
    namespace,
    name,
    version,
    revision,
    manifest,
    resources,
    actions,
    hooks,
    relationships,
    lifecycles,
    policies,
    seeds,
    scripts,
  };
}

function validatePaths(files: UploadedFile[]) {
  const allowed =
    /^(pack\.yaml|resources\/[a-z_][a-z0-9_]*\.yaml|actions\/[a-z_][a-z0-9_]*\.yaml|hooks\/[a-z_][a-z0-9_]*\.(yaml|ts)|relationships\/[a-z_][a-z0-9_]*\.yaml|lifecycles\/[a-z_][a-z0-9_]*\.yaml|policies\/[a-z_][a-z0-9_]*\.yaml|seeds\/[a-z_][a-z0-9_]*\.yaml)$/;
  for (const file of files) {
    if (!allowed.test(file.path)) {
      throw new Error(`bad_request: unexpected pack path ${file.path}`);
    }
  }
}

function compilePack(pack: NormalizedPack): CompileStep[] {
  const steps: CompileStep[] = [];
  for (const [resourceName, spec] of Object.entries(pack.resources).sort()) {
    const table = tableName(resourceName);
    const columns = [
      "id text primary key",
      "version integer not null default 1",
      "archived_at timestamptz",
    ];
    for (const [fieldName, field] of Object.entries(spec.fields ?? {})) {
      columns.push(
        `${qi(fieldName)} ${sqlType(field.type)}${
          field.required ? " not null" : ""
        }`,
      );
    }
    steps.push({
      kind: "create_resource_table",
      target: resourceName,
      sql: `create table ${qi(table)} (${columns.join(", ")});`,
      details: { table },
    });
    for (const [fieldName, field] of Object.entries(spec.fields ?? {})) {
      if (field.ref) {
        steps.push({
          kind: "record_reference",
          target: `${resourceName}.${fieldName}`,
          details: { ref: field.ref },
        });
      }
    }
    if (spec.lifecycle) {
      steps.push({
        kind: "record_lifecycle",
        target: resourceName,
        details: spec.lifecycle,
      });
    }
  }
  for (const [relName, rel] of Object.entries(pack.relationships).sort()) {
    const table = relationshipTableName(relName);
    const columns = [
      "id text primary key",
      `from_id text not null references ${
        qi(tableName(rel.from!.resource!))
      }(id)`,
      `to_id text not null references ${qi(tableName(rel.to!.resource!))}(id)`,
    ];
    for (const [fieldName, field] of Object.entries(rel.fields ?? {})) {
      columns.push(
        `${qi(fieldName)} ${sqlType(field.type)}${
          field.required ? " not null" : ""
        }`,
      );
    }
    steps.push({
      kind: "create_relationship_table",
      target: relName,
      sql: `create table ${qi(table)} (${columns.join(", ")});`,
      details: { table, from: rel.from, to: rel.to },
    });
  }
  for (
    const [lifecycleName, lifecycle] of Object.entries(pack.lifecycles).sort()
  ) {
    steps.push({
      kind: "store_lifecycle",
      target: lifecycleName,
      details: lifecycle,
    });
  }
  for (const [policyName, policy] of Object.entries(pack.policies).sort()) {
    steps.push({ kind: "store_policy", target: policyName, details: policy });
  }
  for (const [seedName, seed] of Object.entries(pack.seeds).sort()) {
    steps.push({
      kind: "preview_seed_changeset",
      target: seedName,
      details: { resource: seed.resource, rows: seed.rows?.length ?? 0 },
    });
  }
  for (const [hookName, hook] of Object.entries(pack.hooks).sort()) {
    steps.push({
      kind: "store_hook",
      target: hookName,
      details: { script: hook.script },
    });
  }
  for (const [actionName, action] of Object.entries(pack.actions).sort()) {
    steps.push({ kind: "store_action", target: actionName, details: action });
  }
  return steps;
}

async function applyPack(
  db: PGlite,
  pack: NormalizedPack,
  files: UploadedFile[],
  steps: CompileStep[],
) {
  await db.exec("begin");
  try {
    await db.query(
      "update pack_revisions set active=false where namespace=$1 and name=$2",
      [pack.namespace, pack.name],
    );
    await db.query(
      "insert into pack_revisions(revision, namespace, name, version, active, manifest, normalized) values ($1, $2, $3, $4, true, $5, $6)",
      [
        pack.revision,
        pack.namespace,
        pack.name,
        pack.version,
        pack.manifest,
        pack as unknown as Json,
      ],
    );
    for (const file of files) {
      await db.query(
        "insert into pack_files(revision, path, digest, bytes, kind, content) values ($1, $2, $3, $4, $5, $6)",
        [
          pack.revision,
          file.path,
          digestText(file.text),
          file.text.length,
          file.kind,
          file.text,
        ],
      );
    }
    for (const [resourceName, spec] of Object.entries(pack.resources)) {
      const table = tableName(resourceName);
      await db.query(
        "insert into resource_definitions(revision, namespace, name, table_name, spec) values ($1, $2, $3, $4, $5)",
        [
          pack.revision,
          pack.namespace,
          resourceName,
          table,
          spec as unknown as Json,
        ],
      );
      for (const [fieldName, field] of Object.entries(spec.fields ?? {})) {
        await db.query(
          "insert into field_definitions(revision, resource, name, type, required, ref) values ($1, $2, $3, $4, $5, $6)",
          [
            pack.revision,
            resourceName,
            fieldName,
            field.type,
            Boolean(field.required),
            field.ref ?? null,
          ],
        );
      }
    }
    for (const [relName, rel] of Object.entries(pack.relationships)) {
      await db.query(
        "insert into relationship_definitions(revision, name, table_name, spec) values ($1, $2, $3, $4)",
        [
          pack.revision,
          relName,
          relationshipTableName(relName),
          rel as unknown as Json,
        ],
      );
    }
    for (const [lifecycleName, lifecycle] of Object.entries(pack.lifecycles)) {
      await db.query(
        "insert into lifecycle_definitions(revision, name, spec) values ($1, $2, $3)",
        [pack.revision, lifecycleName, lifecycle],
      );
    }
    for (const [policyName, policy] of Object.entries(pack.policies)) {
      await db.query(
        "insert into policy_definitions(revision, name, spec) values ($1, $2, $3)",
        [pack.revision, policyName, policy],
      );
    }
    for (const [seedName, seed] of Object.entries(pack.seeds)) {
      await db.query(
        "insert into seed_definitions(revision, name, resource, key_field, spec) values ($1, $2, $3, $4, $5)",
        [
          pack.revision,
          seedName,
          seed.resource,
          seed.key,
          seed as unknown as Json,
        ],
      );
      for (const row of seed.rows ?? []) {
        const keyValue = String(row[seed.key!]);
        await db.query(
          "insert into seed_records(revision, seed_name, resource, key_value, row_json) values ($1, $2, $3, $4, $5)",
          [pack.revision, seedName, seed.resource, keyValue, row],
        );
      }
    }
    for (const [hookName, hook] of Object.entries(pack.hooks)) {
      const scriptPath = `hooks/${hook.script}`;
      await db.query(
        "insert into hook_definitions(revision, name, script_path, script_digest, spec) values ($1, $2, $3, $4, $5)",
        [
          pack.revision,
          hookName,
          scriptPath,
          pack.scripts[scriptPath].digest,
          hook as unknown as Json,
        ],
      );
    }
    for (const [actionName, action] of Object.entries(pack.actions)) {
      await db.query(
        "insert into action_definitions(revision, name, spec) values ($1, $2, $3)",
        [pack.revision, actionName, action],
      );
    }
    for (const step of steps) {
      if (
        (step.kind === "create_resource_table" ||
          step.kind === "create_relationship_table") && step.sql
      ) {
        await db.exec(step.sql);
      }
    }
    await db.query(
      "insert into pack_apply_events(id, revision, event, details) values ($1, $2, 'pack_applied', $3)",
      [`evt_${digestText(pack.revision).slice(-10)}`, pack.revision, {
        steps: steps.length,
      }],
    );
    await db.exec("commit");
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function inspectSchema(db: PGlite) {
  const tables = await db.query(
    "select tablename from pg_tables where schemaname='public' order by tablename",
  );
  const columns = await db.query(
    "select table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema='public' and (table_name like 'res_%' or table_name like 'pack_%' or table_name like '%definitions') order by table_name, ordinal_position",
  );
  return { tables: tables.rows, columns: columns.rows };
}
async function inspectPlatform(db: PGlite) {
  const revisions = await db.query(
    "select revision, namespace, name, version, active from pack_revisions order by created_at",
  );
  const resources = await db.query(
    "select name, table_name from resource_definitions order by name",
  );
  const fields = await db.query(
    "select resource, name, type, required, ref from field_definitions order by resource, name",
  );
  const hooks = await db.query(
    "select name, script_path, script_digest from hook_definitions order by name",
  );
  const actions = await db.query(
    "select name, spec from action_definitions order by name",
  );
  const relationships = await db.query(
    "select name, table_name, spec from relationship_definitions order by name",
  );
  const lifecycles = await db.query(
    "select name, spec from lifecycle_definitions order by name",
  );
  const policies = await db.query(
    "select name, spec from policy_definitions order by name",
  );
  const seeds = await db.query(
    "select name, resource, key_field from seed_definitions order by name",
  );
  const seedRecords = await db.query(
    "select seed_name, key_value, row_json from seed_records order by seed_name, key_value",
  );
  const files = await db.query(
    "select path, digest, bytes, kind from pack_files order by path",
  );
  return {
    revisions: revisions.rows,
    resources: resources.rows,
    fields: fields.rows,
    hooks: hooks.rows,
    actions: actions.rows,
    relationships: relationships.rows,
    lifecycles: lifecycles.rows,
    policies: policies.rows,
    seeds: seeds.rows,
    seedRecords: seedRecords.rows,
    files: files.rows,
  };
}

function packSummary(pack: NormalizedPack) {
  return {
    namespace: pack.namespace,
    name: pack.name,
    version: pack.version,
    revision: pack.revision,
    resources: Object.keys(pack.resources),
    relationships: Object.keys(pack.relationships),
    lifecycles: Object.keys(pack.lifecycles),
    policies: Object.keys(pack.policies),
    seeds: Object.keys(pack.seeds),
    actions: Object.keys(pack.actions),
    hooks: Object.keys(pack.hooks),
    scripts: Object.keys(pack.scripts),
  };
}
function readYamlAsJson(text: string, path: string): any {
  try {
    return JSON.parse(stripTrailingCommas(text));
  } catch {
    throw new Error(
      `bad_request: ${path} must be JSON-compatible YAML in this prototype`,
    );
  }
}
function stripTrailingCommas(text: string) {
  return text.replace(/,\s*([}\]])/g, "$1");
}
function requireKind(doc: Json, kind: string, path: string) {
  if (doc.kind !== kind) {
    throw new Error(`bad_request: ${path} kind must be ${kind}`);
  }
}
function objectNameFromFileOrMetadata(doc: Json, path: string, prefix: string) {
  const basename = path.slice(prefix.length).replace(/\.yaml$/, "");
  const metadata = asRecord(doc.metadata, `${path}.metadata`);
  if (typeof metadata.name !== "string") {
    throw new Error(`bad_request: ${path}.metadata.name is required`);
  }
  const name = metadata.name;
  assertSnake(name, `${path}.metadata.name`);
  if (name !== basename) {
    throw new Error(`bad_request: ${path} filename must match metadata.name`);
  }
  return name;
}
function asRecord(value: unknown, path: string): Json {
  if (!isRecord(value)) throw new Error(`bad_request: ${path} must be object`);
  return value;
}
function stringField(value: Json, field: string, path: string) {
  if (typeof value[field] !== "string") {
    throw new Error(`bad_request: ${path} is required`);
  }
  return value[field] as string;
}
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertSnake(value: string, path: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new Error(`bad_request: ${path} must be lowercase snake case`);
  }
}
function tableName(resource: string) {
  return `res_${resource}`;
}
function relationshipTableName(relationship: string) {
  return `rel_${relationship}`;
}
function sqlType(type: string) {
  if (type === "integer") return "integer";
  if (type === "decimal") return "numeric";
  return "text";
}
function qi(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe identifier ${identifier}`);
  }
  return `"${identifier}"`;
}
function digestText(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function errorResponse(code: string, message: string, status: number) {
  return json({ ok: false, error: { code, message, details: [] } }, status);
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8789);
  await startServer(port);
}
