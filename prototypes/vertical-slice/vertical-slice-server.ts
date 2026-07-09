import { PGlite } from "npm:@electric-sql/pglite";

type Json = Record<string, unknown>;
type UploadedFile = { path: string; text: string; kind: "config" | "script" };
type FieldSpec = { type: string; required?: boolean; ref?: string };
type ResourceSpec = {
  fields?: Record<string, FieldSpec>;
  lifecycle?: { field?: string; states?: string[] };
  axi?: Json;
};
type RelationshipSpec = {
  from?: { resource?: string };
  to?: { resource?: string };
  fields?: Record<string, FieldSpec>;
};
type HookSpec = {
  script?: string;
  output?: { schema?: string };
  permissions?: Json;
  attachments?: Json[];
};
type SeedSpec = {
  resource?: string;
  key?: string;
  rows?: Json[];
  mode?: string;
};
type Pack = {
  namespace: string;
  name: string;
  version: string;
  revision: string;
  manifest: Json;
  resources: Record<string, ResourceSpec>;
  relationships: Record<string, RelationshipSpec>;
  actions: Record<string, Json>;
  hooks: Record<string, HookSpec>;
  seeds: Record<string, SeedSpec>;
  lifecycles: Record<string, Json>;
  policies: Record<string, Json>;
  scripts: Record<string, { path: string; content: string; digest: string }>;
};
type Operation = {
  op: string;
  resource?: string;
  relationship?: string;
  id?: string;
  as?: string;
  fields?: Json;
  to?: string;
  from?: string;
  expectedVersion?: number;
};

type App = {
  db: PGlite;
  handler: (request: Request) => Promise<Response>;
  close: () => Promise<void>;
};

export async function createApp(): Promise<App> {
  const db = new PGlite();
  const scriptDir = await Deno.makeTempDir({ prefix: "operant-hooks-" });
  await initialize(db);
  return {
    db,
    handler: (request) => route(db, scriptDir, request),
    close: async () => {
      await db.close();
      await Deno.remove(scriptDir, { recursive: true }).catch(() => {});
    },
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

async function initialize(db: PGlite) {
  await db.exec(`
    create table pack_revisions(revision text primary key, namespace text not null, name text not null, version text not null, active boolean not null, manifest jsonb not null, normalized jsonb not null, created_at timestamptz default now());
    create table pack_files(revision text not null, path text not null, digest text not null, kind text not null, content text not null, primary key(revision,path));
    create table resource_definitions(revision text not null, name text not null, table_name text not null, spec jsonb not null, primary key(revision,name));
    create table relationship_definitions(revision text not null, name text not null, table_name text not null, spec jsonb not null, primary key(revision,name));
    create table action_definitions(revision text not null, name text not null, spec jsonb not null, primary key(revision,name));
    create table hook_definitions(revision text not null, name text not null, script_path text not null, script_digest text not null, spec jsonb not null, primary key(revision,name));
    create table seed_definitions(revision text not null, name text not null, resource text not null, key_field text not null, spec jsonb not null, primary key(revision,name));
    create table lifecycle_definitions(revision text not null, name text not null, spec jsonb not null, primary key(revision,name));
    create table policy_definitions(revision text not null, name text not null, spec jsonb not null, primary key(revision,name));
    create table changesets(id text primary key, actor_id text not null, status text not null, operations_json jsonb not null, created_at timestamptz default now(), committed_at timestamptz);
    create table object_versions(id text primary key, resource text not null, object_id text not null, version integer not null, previous_version_id text, changeset_id text not null, operation text not null, snapshot_json jsonb not null, changed_fields text[] not null, actor_id text not null, created_at timestamptz default now(), unique(resource,object_id,version));
    create table audit_events(id text primary key, changeset_id text not null, object_version_id text, actor_id text not null, event_type text not null, resource text, object_id text, action text, decision text not null, details_json jsonb not null default '{}', created_at timestamptz default now());
    create table events(id text primary key, changeset_id text not null, object_version_id text, event_type text not null, resource text, object_id text, payload_json jsonb not null default '{}', occurred_at timestamptz default now());
    create table outbox(id text primary key, event_id text not null, hook_name text not null, envelope_json jsonb not null, status text not null default 'pending', attempts integer not null default 0, created_at timestamptz default now(), updated_at timestamptz default now());
    create table hook_executions(id text primary key, hook_name text not null, outbox_id text, phase text not null, status text not null, stdout_json jsonb, stderr_text text, created_at timestamptz default now());
  `);
}

async function route(
  db: PGlite,
  scriptDir: string,
  request: Request,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/debug/platform") {
      return json(await inspectPlatform(db));
    }
    if (request.method === "GET" && url.pathname === "/metadata/home") {
      return json(await metadataHome(db));
    }
    if (request.method === "GET" && url.pathname === "/metadata/packs") {
      return json(await metadataPacks(db));
    }
    const metadataMatch = url.pathname.match(
      /^\/metadata\/(resources|actions|hooks|policies)\/([a-z_][a-z0-9_]*)\/([a-z_][a-z0-9_]*)$/,
    );
    if (request.method === "GET" && metadataMatch) {
      return json(
        await metadataObject(
          db,
          metadataMatch[1],
          metadataMatch[2],
          metadataMatch[3],
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/packs/apply") {
      const files = await readMultipartPack(request);
      const pack = normalizePack(files);
      const result = await applyPack(db, scriptDir, pack, files);
      return json({ ok: true, pack: packSummary(pack), ...result });
    }
    if (request.method === "POST" && url.pathname === "/changesets/preview") {
      const body = await request.json();
      return json(
        await previewChangeset(
          db,
          scriptDir,
          body.actor_id ?? "agent",
          body.operations ?? [],
        ),
      );
    }
    if (request.method === "POST" && url.pathname === "/changesets/commit") {
      const body = await request.json();
      return json(
        await commitOperations(
          db,
          scriptDir,
          body.actor_id ?? "agent",
          body.operations ?? [],
          body.id,
        ),
      );
    }
    const actionMatch = url.pathname.match(
      /^\/actions\/([a-z_][a-z0-9_]*)\/(preview|commit)$/,
    );
    if (request.method === "POST" && actionMatch) {
      const body = await request.json();
      const actionResult = await runAction(
        db,
        scriptDir,
        actionMatch[1],
        body.input ?? {},
        body.actor_id ?? "agent",
      );
      if (actionMatch[2] === "preview") return json(actionResult);
      const commit = await commitOperations(
        db,
        scriptDir,
        body.actor_id ?? "agent",
        actionResult.operations as Operation[],
      );
      return json({ ...commit, action: actionResult });
    }
    if (request.method === "POST" && url.pathname === "/queries") {
      return json(await queryObjects(db, await request.json()));
    }
    const historyMatch = url.pathname.match(
      /^\/history\/([a-z_][a-z0-9_]*)\/([^/]+)$/,
    );
    if (request.method === "GET" && historyMatch) {
      return json(await history(db, historyMatch[1], historyMatch[2]));
    }
    if (request.method === "POST" && url.pathname === "/outbox/process") {
      return json(await processOutbox(db, scriptDir));
    }
    return error("not_found", `${request.method} ${url.pathname}`, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return error(
      message.startsWith("bad_request:") ? "bad_request" : "internal_error",
      message,
      message.startsWith("bad_request:") ? 400 : 500,
    );
  }
}

async function readMultipartPack(request: Request) {
  const form = await request.formData();
  const files: UploadedFile[] = [];
  for (const [key, value] of form.entries()) {
    if (value instanceof File) {
      const path = key === "file" ? value.name : key;
      files.push({
        path,
        text: await value.text(),
        kind: path.endsWith(".ts") ? "script" : "config",
      });
    }
  }
  if (!files.some((f) => f.path === "pack.yaml")) {
    throw new Error("bad_request: missing pack.yaml");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function normalizePack(files: UploadedFile[]): Pack {
  const allowed =
    /^(pack\.yaml|resources\/[a-z_][a-z0-9_]*\.yaml|relationships\/[a-z_][a-z0-9_]*\.yaml|actions\/[a-z_][a-z0-9_]*\.yaml|hooks\/[a-z_][a-z0-9_]*\.(yaml|ts)|seeds\/[a-z_][a-z0-9_]*\.yaml|lifecycles\/[a-z_][a-z0-9_]*\.yaml|policies\/[a-z_][a-z0-9_]*\.yaml)$/;
  for (const file of files) {
    if (!allowed.test(file.path)) {
      throw new Error(`bad_request: unexpected pack path ${file.path}`);
    }
  }
  const byPath = new Map(files.map((f) => [f.path, f]));
  const manifest = parseJsonYaml(byPath.get("pack.yaml")!.text, "pack.yaml");
  const meta = asRecord(manifest.metadata, "metadata");
  const namespace = stringField(meta, "namespace", "pack.metadata.namespace");
  const name = stringField(meta, "name", "pack.metadata.name");
  const version = stringField(meta, "version", "pack.metadata.version");
  const pack: Pack = {
    namespace,
    name,
    version,
    revision: "",
    manifest,
    resources: {},
    relationships: {},
    actions: {},
    hooks: {},
    seeds: {},
    lifecycles: {},
    policies: {},
    scripts: {},
  };
  for (const file of files) {
    if (file.path === "pack.yaml") continue;
    if (file.path.endsWith(".ts")) {
      pack.scripts[file.path] = {
        path: file.path,
        content: file.text,
        digest: digestText(file.text),
      };
      continue;
    }
    const doc = parseJsonYaml(file.text, file.path);
    const objectName = objectNameFromMetadata(doc, file.path);
    if (file.path.startsWith("resources/")) {
      pack.resources[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as ResourceSpec;
    }
    if (file.path.startsWith("relationships/")) {
      pack.relationships[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as RelationshipSpec;
    }
    if (file.path.startsWith("actions/")) {
      pack.actions[objectName] = asRecord(doc.spec ?? {}, `${file.path}.spec`);
    }
    if (file.path.startsWith("hooks/")) {
      pack.hooks[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as HookSpec;
    }
    if (file.path.startsWith("seeds/")) {
      pack.seeds[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      ) as SeedSpec;
    }
    if (file.path.startsWith("lifecycles/")) {
      pack.lifecycles[objectName] = asRecord(
        doc.spec ?? {},
        `${file.path}.spec`,
      );
    }
    if (file.path.startsWith("policies/")) {
      pack.policies[objectName] = asRecord(doc.spec ?? {}, `${file.path}.spec`);
    }
  }
  for (const [hookName, hook] of Object.entries(pack.hooks)) {
    if (!hook.script) {
      throw new Error(`bad_request: hook ${hookName} missing script`);
    }
    const scriptPath = `hooks/${hook.script}`;
    if (!pack.scripts[scriptPath]) {
      throw new Error(
        `bad_request: hook ${hookName} references missing script ${scriptPath}`,
      );
    }
  }
  pack.revision = `${namespace}.${name}@${version}:${
    digestText(JSON.stringify({
      manifest,
      resources: pack.resources,
      relationships: pack.relationships,
      actions: pack.actions,
      hooks: pack.hooks,
      seeds: pack.seeds,
      lifecycles: pack.lifecycles,
      policies: pack.policies,
      scripts: Object.fromEntries(
        Object.entries(pack.scripts).map(([k, v]) => [k, v.digest]),
      ),
    }))
  }`;
  return pack;
}

async function applyPack(
  db: PGlite,
  scriptDir: string,
  pack: Pack,
  files: UploadedFile[],
) {
  await db.exec("begin");
  try {
    await db.query(
      "update pack_revisions set active=false where namespace=$1 and name=$2",
      [pack.namespace, pack.name],
    );
    await db.query(
      "insert into pack_revisions values ($1,$2,$3,$4,true,$5,$6,now())",
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
      await db.query("insert into pack_files values ($1,$2,$3,$4,$5)", [
        pack.revision,
        file.path,
        digestText(file.text),
        file.kind,
        file.text,
      ]);
    }
    for (const [resource, spec] of Object.entries(pack.resources)) {
      await db.query("insert into resource_definitions values ($1,$2,$3,$4)", [
        pack.revision,
        resource,
        tableName(resource),
        spec as unknown as Json,
      ]);
      await db.exec(createResourceTableSql(resource, spec));
    }
    for (const [rel, spec] of Object.entries(pack.relationships)) {
      await db.query(
        "insert into relationship_definitions values ($1,$2,$3,$4)",
        [
          pack.revision,
          rel,
          relationshipTableName(rel),
          spec as unknown as Json,
        ],
      );
      await db.exec(createRelationshipTableSql(rel, spec));
    }
    for (const [name, spec] of Object.entries(pack.actions)) {
      await db.query("insert into action_definitions values ($1,$2,$3)", [
        pack.revision,
        name,
        spec,
      ]);
    }
    for (const [name, spec] of Object.entries(pack.lifecycles)) {
      await db.query("insert into lifecycle_definitions values ($1,$2,$3)", [
        pack.revision,
        name,
        spec,
      ]);
    }
    for (const [name, spec] of Object.entries(pack.policies)) {
      await db.query("insert into policy_definitions values ($1,$2,$3)", [
        pack.revision,
        name,
        spec,
      ]);
    }
    for (const [hookName, hook] of Object.entries(pack.hooks)) {
      const scriptPath = `hooks/${hook.script}`;
      const materialized = `${scriptDir}/${hookName}-${
        pack.scripts[scriptPath].digest
      }.ts`;
      await Deno.writeTextFile(materialized, pack.scripts[scriptPath].content);
      await db.query("insert into hook_definitions values ($1,$2,$3,$4,$5)", [
        pack.revision,
        hookName,
        materialized,
        pack.scripts[scriptPath].digest,
        hook as unknown as Json,
      ]);
    }
    for (const [seedName, seed] of Object.entries(pack.seeds)) {
      await db.query("insert into seed_definitions values ($1,$2,$3,$4,$5)", [
        pack.revision,
        seedName,
        seed.resource,
        seed.key,
        seed as unknown as Json,
      ]);
    }
    await db.exec("commit");
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
  const seedChangesets = [];
  for (const [seedName, seed] of Object.entries(pack.seeds)) {
    const operations = (seed.rows ?? []).map((row) => ({
      op: "create",
      resource: seed.resource,
      id: String(row[seed.key!]),
      fields: row,
    }));
    seedChangesets.push(
      await commitOperations(
        db,
        scriptDir,
        "system:seed",
        operations,
        `seed_${seedName}_${digestText(pack.revision).slice(0, 8)}`,
      ),
    );
  }
  return { seedChangesets };
}

async function previewChangeset(
  db: PGlite,
  scriptDir: string,
  actor: string,
  operations: Operation[],
) {
  const normalized = await runBeforePreviewHooks(db, scriptDir, operations);
  const validation = await validateOperations(
    db,
    scriptDir,
    normalized.operations,
  );
  return {
    ok: validation.errors.length === 0,
    actor_id: actor,
    operations: normalized.operations,
    validation,
    hooks: normalized.hooks,
  };
}

async function commitOperations(
  db: PGlite,
  scriptDir: string,
  actor: string,
  operations: Operation[],
  requestedId?: string,
) {
  const preview = await previewChangeset(db, scriptDir, actor, operations);
  if (!preview.ok) {
    return { ...preview, ok: false, status: "validation_failed" };
  }
  const changesetId = requestedId ??
    `cs_${
      digestText(`${actor}:${JSON.stringify(preview.operations)}:${Date.now()}`)
    }`;
  const aliases: Record<string, string> = {};
  await db.exec("begin");
  try {
    await db.query(
      "insert into changesets(id, actor_id, status, operations_json) values ($1,$2,'committing',$3)",
      [changesetId, actor, preview.operations as unknown as Json[]],
    );
    const versions = [];
    for (const op of preview.operations as Operation[]) {
      if (op.op === "create" && op.resource) {
        const id = op.id ??
          `${op.resource}_${
            digestText(JSON.stringify(op.fields ?? {}) + Date.now()).slice(
              0,
              10,
            )
          }`;
        if (op.as) aliases[`@${op.as}`] = id;
        const fields = resolveAliases(op.fields ?? {}, aliases);
        await insertResourceRow(db, op.resource, id, fields);
        versions.push(
          await recordVersion(
            db,
            changesetId,
            actor,
            op.resource,
            id,
            "create",
            Object.keys(fields),
          ),
        );
      } else if (
        (op.op === "update" || op.op === "transition") && op.resource && op.id
      ) {
        const fields = op.op === "transition"
          ? await transitionFields(db, op.resource, op.to!)
          : (op.fields ?? {});
        await updateResourceRow(db, op.resource, op.id, fields);
        versions.push(
          await recordVersion(
            db,
            changesetId,
            actor,
            op.resource,
            op.id,
            op.op,
            Object.keys(fields),
          ),
        );
      } else if (op.op === "link" && op.relationship) {
        await insertRelationshipRow(
          db,
          op.relationship,
          resolveRef(op.from!, aliases),
          resolveRef(op.to!, aliases),
          resolveAliases(op.fields ?? {}, aliases),
        );
      }
    }
    await db.query(
      "update changesets set status='committed', committed_at=now() where id=$1",
      [changesetId],
    );
    await db.exec("commit");
    return {
      ...preview,
      ok: true,
      changeset_id: changesetId,
      status: "committed",
      object_versions: versions,
    };
  } catch (e) {
    await db.exec("rollback");
    throw e;
  }
}

async function runAction(
  db: PGlite,
  scriptDir: string,
  name: string,
  input: Json,
  actor: string,
) {
  const action = (await db.query<Json>(
    "select spec from action_definitions where revision=(select revision from pack_revisions where active=true order by created_at desc limit 1) and name=$1",
    [name],
  )).rows[0];
  if (!action) throw new Error(`bad_request: unknown action ${name}`);
  const hookName = String((action.spec as Json).hook);
  const hook = await getHook(db, hookName);
  const enriched = { ...input };
  if (name === "convert_lead" && input.lead_id) {
    enriched.lead = await currentObject(db, "lead", String(input.lead_id));
  }
  const result = await runHook(hook, {
    actor_id: actor,
    input: enriched,
    phase: "action",
  });
  return {
    ok: true,
    action: name,
    hook: hookName,
    operations: (result.output.operations ?? []) as Operation[],
    hookResult: result,
  };
}

async function runBeforePreviewHooks(
  db: PGlite,
  scriptDir: string,
  operations: Operation[],
) {
  const hooks = [];
  const normalized: Operation[] = [];
  for (const op of operations) {
    let current = structuredClone(op) as Operation;
    if (
      op.resource === "lead" && op.op === "create" &&
      await hookExists(db, "normalize_lead")
    ) {
      const result = await runHook(await getHook(db, "normalize_lead"), {
        input: { operation: current },
        phase: "before_preview",
      });
      hooks.push({
        phase: "before_preview",
        name: "normalize_lead",
        result: result.output,
      });
      current = applyPatches(current, (result.output.patches ?? []) as Json[]);
    }
    normalized.push(current);
  }
  return { operations: normalized, hooks };
}

async function validateOperations(
  db: PGlite,
  _scriptDir: string,
  operations: Operation[],
) {
  const errors: Json[] = [];
  const warnings: Json[] = [];
  for (const op of operations) {
    if (
      op.resource === "lead" && op.op === "create" &&
      await hookExists(db, "validate_lead")
    ) {
      const result = await runHook(await getHook(db, "validate_lead"), {
        input: { operation: op },
        phase: "validate",
      });
      errors.push(...((result.output.errors as Json[] | undefined) ?? []));
      warnings.push(...((result.output.warnings as Json[] | undefined) ?? []));
    }
  }
  return { errors, warnings };
}

async function runHook(hook: Json, envelope: Json) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--no-prompt", hook.script_path as string],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });
  const child = command.spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(envelope)));
  await writer.close();
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout).trim();
  const stderr = new TextDecoder().decode(output.stderr).trim();
  if (!output.success) {
    throw new Error(`bad_request: hook ${hook.name} failed: ${stderr}`);
  }
  return { output: stdout ? JSON.parse(stdout) : {}, stderr };
}

async function recordVersion(
  db: PGlite,
  changesetId: string,
  actor: string,
  resource: string,
  id: string,
  operation: string,
  changedFields: string[],
) {
  const row = await currentObject(db, resource, id);
  const version = Number(row.version);
  const previous = version > 1
    ? (await db.query<Json>(
      "select id from object_versions where resource=$1 and object_id=$2 and version=$3",
      [resource, id, version - 1],
    )).rows[0]?.id as string | undefined
    : undefined;
  const ovId = `ov_${digestText(`${resource}:${id}:${version}`)}`;
  await db.query(
    "insert into object_versions values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())",
    [
      ovId,
      resource,
      id,
      version,
      previous ?? null,
      changesetId,
      operation,
      row,
      changedFields,
      actor,
    ],
  );
  await db.query(
    `update ${
      qi(tableName(resource))
    } set current_object_version_id=$1 where id=$2`,
    [ovId, id],
  );
  const auditId = `audit_${digestText(`audit:${ovId}`)}`;
  await db.query(
    "insert into audit_events(id,changeset_id,object_version_id,actor_id,event_type,resource,object_id,action,decision,details_json) values ($1,$2,$3,$4,$5,$6,$7,$8,'committed',$9)",
    [
      auditId,
      changesetId,
      ovId,
      actor,
      `object.${operation}`,
      resource,
      id,
      operation,
      { changed_fields: changedFields },
    ],
  );
  const eventId = `event_${digestText(`event:${ovId}`)}`;
  await db.query(
    "insert into events(id,changeset_id,object_version_id,event_type,resource,object_id,payload_json) values ($1,$2,$3,$4,$5,$6,$7)",
    [eventId, changesetId, ovId, `object.${operation}`, resource, id, {
      changed_fields: changedFields,
    }],
  );
  if (await hookExists(db, "notify_crm_change")) {
    await db.query(
      "insert into outbox(id,event_id,hook_name,envelope_json) values ($1,$2,'notify_crm_change',$3)",
      [`outbox_${digestText(eventId)}`, eventId, {
        input: {
          event_id: eventId,
          object_version_id: ovId,
          resource,
          object_id: id,
        },
      }],
    );
  }
  return ovId;
}

async function queryObjects(db: PGlite, body: Json) {
  const resource = String(body.resource);
  const fields = Array.isArray(body.fields)
    ? body.fields.map(String)
    : ["id", "version"];
  const limit = Math.min(Number(body.limit ?? 20), 100);
  const where = compileFilter(String(body.filter ?? "active()"));
  const rows = (await db.query(
    `select ${fields.map(qi).join(", ")} from ${
      qi(tableName(resource))
    } where ${where} order by id limit ${limit}`,
  )).rows;
  return {
    ok: true,
    resource,
    items: rows,
    page: { limit, has_more: rows.length === limit },
    fields: { selected: fields },
    policy: { pushed_down: true },
  };
}

async function history(db: PGlite, resource: string, id: string) {
  const versions = (await db.query(
    "select id, version, operation, changed_fields, actor_id, snapshot_json from object_versions where resource=$1 and object_id=$2 order by version desc",
    [resource, id],
  )).rows;
  const audit = (await db.query(
    "select event_type, object_version_id, actor_id, decision from audit_events where resource=$1 and object_id=$2 order by created_at",
    [resource, id],
  )).rows;
  const events = (await db.query(
    "select event_type, object_version_id, payload_json from events where resource=$1 and object_id=$2 order by occurred_at",
    [resource, id],
  )).rows;
  return { ok: true, resource, id, versions, audit, events };
}

async function processOutbox(db: PGlite, _scriptDir: string) {
  const row = (await db.query<Json>(
    "select * from outbox where status='pending' order by created_at limit 1",
  )).rows[0];
  if (!row) return { ok: true, processed: false };
  const hook = await getHook(db, row.hook_name as string);
  const result = await runHook(hook, row.envelope_json as Json);
  await db.query(
    "insert into hook_executions values ($1,$2,$3,'after_commit','succeeded',$4,$5,now())",
    [
      `hexec_${digestText(String(row.id))}`,
      row.hook_name,
      row.id,
      result.output,
      result.stderr,
    ],
  );
  await db.query(
    "update outbox set status='succeeded', attempts=attempts+1, updated_at=now() where id=$1",
    [row.id],
  );
  return { ok: true, processed: true, hook: row.hook_name };
}

async function insertResourceRow(
  db: PGlite,
  resource: string,
  id: string,
  fields: Json,
) {
  const table = tableName(resource);
  const keys = Object.keys(fields).filter((k) =>
    k !== "id" && k !== "version" && k !== "current_object_version_id"
  );
  const columns = ["id", ...keys];
  const values = [id, ...keys.map((k) => fields[k])];
  await db.query(
    `insert into ${qi(table)}(${columns.map(qi).join(",")}) values (${
      values.map((_, i) => `$${i + 1}`).join(",")
    })`,
    values,
  );
}

async function updateResourceRow(
  db: PGlite,
  resource: string,
  id: string,
  fields: Json,
) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  await db.query(
    `update ${qi(tableName(resource))} set ${
      keys.map((k, i) => `${qi(k)}=$${i + 1}`).join(",")
    }, version=version+1 where id=$${keys.length + 1}`,
    [...keys.map((k) => fields[k]), id],
  );
}

async function insertRelationshipRow(
  db: PGlite,
  relationship: string,
  fromId: string,
  toId: string,
  fields: Json,
) {
  const keys = Object.keys(fields);
  const columns = ["id", "from_id", "to_id", ...keys];
  const values = [
    `${relationship}_${digestText(`${fromId}:${toId}`)}`,
    fromId,
    toId,
    ...keys.map((k) => fields[k]),
  ];
  await db.query(
    `insert into ${qi(relationshipTableName(relationship))}(${
      columns.map(qi).join(",")
    }) values (${values.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
}

async function transitionFields(db: PGlite, resource: string, to: string) {
  const spec = (await db.query<Json>(
    "select spec from resource_definitions where name=$1 and revision=(select revision from pack_revisions where active=true order by created_at desc limit 1)",
    [resource],
  )).rows[0]?.spec as ResourceSpec;
  const field = spec?.lifecycle?.field ??
    (resource === "opportunity" ? "stage" : "status");
  return { [field]: to };
}

async function currentObject(
  db: PGlite,
  resource: string,
  id: string,
): Promise<Json> {
  const row = (await db.query<Json>(
    `select * from ${qi(tableName(resource))} where id=$1`,
    [id],
  )).rows[0];
  if (!row) throw new Error(`bad_request: ${resource} ${id} not found`);
  return row;
}

async function getHook(db: PGlite, name: string): Promise<Json> {
  const row = (await db.query<Json>(
    "select * from hook_definitions where name=$1 and revision=(select revision from pack_revisions where active=true order by created_at desc limit 1)",
    [name],
  )).rows[0];
  if (!row) throw new Error(`bad_request: hook ${name} not found`);
  return row;
}
async function hookExists(db: PGlite, name: string) {
  return (await db.query(
    "select 1 from hook_definitions where name=$1 limit 1",
    [name],
  )).rows.length > 0;
}

async function metadataHome(db: PGlite) {
  const pack = await activePack(db);
  const manifest = (pack?.manifest ?? {}) as Json;
  const manifestSpec = (isRecord(manifest.spec) ? manifest.spec : {}) as Json;
  const axi = isRecord(manifestSpec.axi) ? manifestSpec.axi as Json : {};
  const home = isRecord(axi.home) ? axi.home as Json : {};
  const resources = (await db.query<Json>(
    "select name, spec from resource_definitions where revision=$1 order by name",
    [pack?.revision],
  )).rows;
  const actions = (await db.query<Json>(
    "select name, spec from action_definitions where revision=$1 order by name",
    [pack?.revision],
  )).rows;
  const outbox = (await db.query<Json>(
    "select status, count(*)::int as count from outbox group by status order by status",
  )).rows;
  return {
    ok: true,
    system: {
      active_pack: pack
        ? `${pack.namespace}.${pack.name}@${pack.version}`
        : null,
    },
    resources: preferredNames(
      home.resources,
      resources.map((r) => `default.${r.name}`),
    ),
    actions: preferredNames(
      home.actions,
      actions.map((a) => `default.${a.name}`),
    ),
    status: { outbox },
    help: Array.isArray(home.help) ? home.help : [
      "optctl metadata resource default.lead",
      "optctl query default.lead --where 'active()'",
    ],
  };
}

async function metadataPacks(db: PGlite) {
  const rows = (await db.query(
    "select namespace, name, version, revision, active, manifest from pack_revisions order by created_at desc",
  )).rows;
  return { ok: true, packs: rows };
}

async function metadataObject(db: PGlite, kind: string, namespace: string, name: string) {
  const table = ({
    resources: "resource_definitions",
    actions: "action_definitions",
    hooks: "hook_definitions",
    policies: "policy_definitions",
  } as Record<string, string>)[kind];
  const columns = kind === "resources"
    ? "name, spec"
    : kind === "hooks"
    ? "name, spec, script_digest"
    : "name, spec";
  const row = (await db.query<Json>(
    `select ${columns} from ${table} where revision=(select revision from pack_revisions where active=true order by created_at desc limit 1) and name=$1`,
    [name],
  )).rows[0];
  if (!row) throw new Error(`bad_request: unknown metadata ${kind}.${name}`);
  const spec = isRecord(row.spec) ? row.spec as Json : {};
  return {
    ok: true,
    kind: kind.replace(/s$/, ""),
    name: `${namespace}.${row.name}`,
    schema: kind === "resources" ? { fields: spec.fields ?? {} } : undefined,
    axi: spec.axi ?? {},
    spec,
  };
}

async function activePack(db: PGlite): Promise<Json | undefined> {
  return (await db.query<Json>(
    "select revision, namespace, name, version, manifest from pack_revisions where active=true order by created_at desc limit 1",
  )).rows[0];
}

function preferredNames(preferred: unknown, fallback: string[]) {
  if (
    Array.isArray(preferred) &&
    preferred.every((item) => typeof item === "string")
  ) return preferred;
  return fallback.slice(0, 8);
}

async function inspectPlatform(db: PGlite) {
  return {
    revisions: (await db.query(
      "select revision, namespace, name, version, active from pack_revisions order by created_at",
    )).rows,
    resources: (await db.query(
      "select name, table_name from resource_definitions order by name",
    )).rows,
    relationships: (await db.query(
      "select name, table_name from relationship_definitions order by name",
    )).rows,
    actions:
      (await db.query("select name from action_definitions order by name"))
        .rows,
    hooks: (await db.query(
      "select name, script_digest from hook_definitions order by name",
    )).rows,
    seeds: (await db.query(
      "select name, resource, key_field from seed_definitions order by name",
    )).rows,
    changesets: (await db.query(
      "select id, actor_id, status from changesets order by created_at",
    )).rows,
    objectVersions: (await db.query(
      "select resource, object_id, version, operation from object_versions order by created_at",
    )).rows,
    outbox: (await db.query(
      "select hook_name, status from outbox order by created_at",
    )).rows,
    hookExecutions: (await db.query(
      "select hook_name, status from hook_executions order by created_at",
    )).rows,
  };
}

function createResourceTableSql(resource: string, spec: ResourceSpec) {
  const columns = [
    "id text primary key",
    "version integer not null default 1",
    "current_object_version_id text",
    "archived_at timestamptz",
    "archived_by text",
  ];
  for (const [name, field] of Object.entries(spec.fields ?? {})) {
    columns.push(
      `${qi(name)} ${sqlType(field.type)}${field.required ? " not null" : ""}`,
    );
  }
  return `create table ${qi(tableName(resource))} (${columns.join(",")});`;
}
function createRelationshipTableSql(name: string, spec: RelationshipSpec) {
  const columns = [
    "id text primary key",
    `from_id text not null references ${
      qi(tableName(spec.from!.resource!))
    }(id)`,
    `to_id text not null references ${qi(tableName(spec.to!.resource!))}(id)`,
  ];
  for (const [fieldName, field] of Object.entries(spec.fields ?? {})) {
    columns.push(
      `${qi(fieldName)} ${sqlType(field.type)}${
        field.required ? " not null" : ""
      }`,
    );
  }
  return `create table ${qi(relationshipTableName(name))} (${
    columns.join(",")
  });`;
}
function sqlType(type: string) {
  if (type === "integer") return "integer";
  if (type === "decimal") return "numeric";
  if (type === "boolean") return "boolean";
  if (type === "timestamp") return "timestamptz";
  return "text";
}
function compileFilter(filter: string) {
  if (filter === "active()" || filter.trim() === "") {
    return "archived_at is null";
  }
  const match = filter.match(
    /^([a-z_][a-z0-9_]*)\s*==\s*\"([^\"]*)\"(?:\s*&&\s*active\(\))?$/,
  );
  if (!match) throw new Error(`bad_request: unsupported filter ${filter}`);
  return `${qi(match[1])} = '${
    match[2].replaceAll("'", "''")
  }' and archived_at is null`;
}
function applyPatches(operation: Operation, patches: Json[]) {
  const next = structuredClone(operation) as Operation;
  next.fields ??= {};
  for (const patch of patches) {
    const path = String(patch.path ?? "");
    if (patch.op === "set" && path.startsWith("/fields/")) {
      next.fields[path.slice(8)] = patch.value;
    }
    if (patch.op === "unset" && path.startsWith("/fields/")) {
      delete next.fields[path.slice(8)];
    }
  }
  return next;
}
function resolveAliases(fields: Json, aliases: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields).map((
      [k, v],
    ) => [k, typeof v === "string" && aliases[v] ? aliases[v] : v]),
  );
}
function resolveRef(ref: string, aliases: Record<string, string>) {
  return aliases[ref] ?? ref;
}
function tableName(resource: string) {
  return `res_${resource}`;
}
function relationshipTableName(rel: string) {
  return `rel_${rel}`;
}
function qi(name: string) {
  return `"${name.replaceAll('"', '""')}"`;
}
function parseJsonYaml(text: string, path: string): any {
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
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, path: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`bad_request: ${path} must be object`);
  }
  return value as Json;
}
function stringField(record: Json, key: string, path: string) {
  if (typeof record[key] !== "string") {
    throw new Error(`bad_request: ${path} must be string`);
  }
  return record[key] as string;
}
function objectNameFromMetadata(doc: any, path: string) {
  const metadata = asRecord(doc.metadata, `${path}.metadata`);
  const name = stringField(metadata, "name", `${path}.metadata.name`);
  const basename = path.split("/").pop()!.replace(/\.yaml$/, "");
  if (name !== basename) {
    throw new Error(
      `bad_request: ${path} metadata.name must match file basename`,
    );
  }
  return name;
}
function digestText(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
function packSummary(pack: Pack) {
  return {
    namespace: pack.namespace,
    name: pack.name,
    version: pack.version,
    revision: pack.revision,
    resources: Object.keys(pack.resources),
    relationships: Object.keys(pack.relationships),
    actions: Object.keys(pack.actions),
    hooks: Object.keys(pack.hooks),
    seeds: Object.keys(pack.seeds),
  };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function error(code: string, message: string, status: number) {
  return json({ ok: false, error: { code, message } }, status);
}

if (import.meta.main) await startServer(Number(Deno.args[0] ?? 8789));
