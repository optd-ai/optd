import { query, type Queryable } from "./client.ts";
import { applyPackDdl, compilePackDdl } from "./resource_ddl.ts";
import type { LoadedPack, NormalizedDefinition } from "../yaml/pack_loader.ts";

export type PackSummary = {
  namespace: string;
  name: string;
  version: string;
  revision: string;
  resources: string[];
  relationships: string[];
  lifecycles: string[];
  actions: string[];
  hooks: Array<{ name: string; script_digest: string }>;
  policies: string[];
  seeds: string[];
};

export function summarizePack(pack: LoadedPack): PackSummary {
  return {
    namespace: pack.namespace,
    name: pack.name,
    version: pack.version,
    revision: pack.revision,
    resources: Object.keys(pack.resources).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
    relationships: Object.keys(pack.relationships).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
    lifecycles: Object.keys(pack.lifecycles).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
    actions: Object.keys(pack.actions).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
    hooks: Object.entries(pack.hooks).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hook]) => ({
        name: `${pack.namespace}.${name}`,
        script_digest: hook.scriptDigest,
      })),
    policies: Object.keys(pack.policies).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
    seeds: Object.keys(pack.seeds).sort().map((name) =>
      `${pack.namespace}.${name}`
    ),
  };
}

export async function countPackRevisions(sql: Queryable): Promise<number> {
  const result = await query<{ count: string }>(
    sql,
    "select count(*)::text as count from pack_revisions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function applyLoadedPack(
  sql: Queryable,
  pack: LoadedPack,
): Promise<PackSummary> {
  const ddlObjects = compilePackDdl(pack);
  await query(
    sql,
    "update pack_revisions set active=false where namespace=$1 and name=$2",
    [pack.namespace, pack.name],
  );
  await query(
    sql,
    `insert into pack_revisions(revision, namespace, name, version, active, manifest, normalized)
    values ($1,$2,$3,$4,true,$5::jsonb,$6::jsonb)
    on conflict (revision) do update set active=true, manifest=excluded.manifest, normalized=excluded.normalized`,
    [
      pack.revision,
      pack.namespace,
      pack.name,
      pack.version,
      JSON.stringify(pack.manifest),
      JSON.stringify(pack.normalized),
    ],
  );
  for (const file of pack.sourceFiles) {
    await query(
      sql,
      "insert into pack_source_files(revision,path,digest,kind,content) values ($1,$2,$3,$4,$5) on conflict (revision,path) do update set digest=excluded.digest, kind=excluded.kind, content=excluded.content",
      [pack.revision, file.path, file.digest, file.kind, file.content],
    );
  }
  await insertDefinitions(
    sql,
    "resource_definitions",
    pack.revision,
    pack.resources,
  );
  await insertDefinitions(
    sql,
    "relationship_definitions",
    pack.revision,
    pack.relationships,
  );
  await insertDefinitions(
    sql,
    "lifecycle_definitions",
    pack.revision,
    pack.lifecycles,
  );
  await insertDefinitions(
    sql,
    "action_definitions",
    pack.revision,
    pack.actions,
  );
  await insertDefinitions(
    sql,
    "policy_definitions",
    pack.revision,
    pack.policies,
  );
  for (const hook of Object.values(pack.hooks)) {
    await query(
      sql,
      `insert into hook_definitions(revision,namespace,name,script_path,script_digest,spec,document)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
      on conflict (revision,namespace,name) do update set script_path=excluded.script_path, script_digest=excluded.script_digest, spec=excluded.spec, document=excluded.document`,
      [
        pack.revision,
        hook.namespace,
        hook.name,
        `hooks/${hook.script}`,
        hook.scriptDigest,
        JSON.stringify(hook.spec),
        JSON.stringify(hook.document),
      ],
    );
  }
  for (const seed of Object.values(pack.seeds)) {
    await query(
      sql,
      `insert into seed_definitions(revision,namespace,name,resource,key_field,spec,document)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
      on conflict (revision,namespace,name) do update set resource=excluded.resource, key_field=excluded.key_field, spec=excluded.spec, document=excluded.document`,
      [
        pack.revision,
        seed.namespace,
        seed.name,
        String(seed.spec.resource),
        String(seed.spec.key),
        JSON.stringify(seed.spec),
        JSON.stringify(seed.document),
      ],
    );
  }
  await applyPackDdl(sql, pack.revision, ddlObjects);
  return summarizePack(pack);
}

async function insertDefinitions(
  sql: Queryable,
  table: string,
  revision: string,
  defs: Record<string, NormalizedDefinition>,
) {
  for (const def of Object.values(defs)) {
    await query(
      sql,
      `insert into ${table}(revision,namespace,name,spec,document) values ($1,$2,$3,$4::jsonb,$5::jsonb)
       on conflict (revision,namespace,name) do update set spec=excluded.spec, document=excluded.document`,
      [
        revision,
        def.namespace,
        def.name,
        JSON.stringify(def.spec),
        JSON.stringify(def.document),
      ],
    );
  }
}

export async function listPacks(sql: Queryable) {
  const result = await query(
    sql,
    "select namespace, name, version, revision, active, manifest from pack_revisions order by created_at desc",
  );
  return result.rows;
}

export async function getPack(sql: Queryable, namespace: string, name: string) {
  const result = await query(
    sql,
    "select namespace, name, version, revision, active, manifest, normalized from pack_revisions where namespace=$1 and name=$2 and active=true order by created_at desc limit 1",
    [namespace, name],
  );
  return result.rows[0] ?? null;
}

export async function getActivePack(sql: Queryable) {
  const result = await query(
    sql,
    "select namespace, name, version, revision, manifest from pack_revisions where active=true order by created_at desc limit 1",
  );
  return result.rows[0] ?? null;
}

export async function getDefinition(
  sql: Queryable,
  table: string,
  namespace: string,
  name: string,
) {
  const result = await query(
    sql,
    `select * from ${table} where revision=(select revision from pack_revisions where namespace=$1 and active=true order by created_at desc limit 1) and namespace=$1 and name=$2`,
    [namespace, name],
  );
  return result.rows[0] ?? null;
}
