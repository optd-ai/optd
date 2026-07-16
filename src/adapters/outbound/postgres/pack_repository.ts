import { query, type Queryable } from "./client.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type PackSummary = {
  publisher: string;
  name: string;
  version: string;
  candidate_revision_id: string;
  source_digest: string;
  active: false;
  resources: string[];
  relationships: string[];
  lifecycles: string[];
  actions: string[];
  hooks: Array<{ name: string; script_digest: string }>;
  roles: string[];
  policies: string[];
  seeds: string[];
};

export function summarizePack(
  pack: LoadedPack,
  candidateRevisionId: string,
): PackSummary {
  const names = (definitions: Record<string, unknown>) =>
    Object.keys(definitions).sort().map((name) =>
      `${pack.publisher}/${pack.name}:${name}`
    );
  return {
    publisher: pack.publisher,
    name: pack.name,
    version: pack.version,
    candidate_revision_id: candidateRevisionId,
    source_digest: pack.sourceDigest,
    active: false,
    resources: names(pack.resources),
    relationships: names(pack.relationships),
    lifecycles: names(pack.lifecycles),
    actions: names(pack.actions),
    hooks: Object.entries(pack.hooks).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, hook]) => ({
        name: `${pack.publisher}/${pack.name}:${name}`,
        script_digest: hook.scriptDigest,
      })),
    roles: names(pack.roles),
    policies: names(pack.policies),
    seeds: names(pack.seeds),
  };
}

export async function storeOrReuseCandidate(
  sql: Queryable,
  pack: LoadedPack,
): Promise<{ id: string; reused: boolean }> {
  const existing = await query<{ id: string }>(
    sql,
    "select id from pack_candidate_revisions where publisher=$1 and pack_name=$2 and source_digest=$3",
    [pack.publisher, pack.name, pack.sourceDigest],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, reused: true };
  const id = uuidV7();
  const inserted = await query<{ id: string }>(
    sql,
    `insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb) on conflict (publisher,pack_name,source_digest) do nothing returning id`,
    [
      id,
      pack.publisher,
      pack.name,
      pack.version,
      pack.sourceDigest,
      pack.revision.split(":").slice(1).join(":"),
      JSON.stringify(pack.manifest),
      JSON.stringify(pack.normalized),
      JSON.stringify(pack.sourceFiles),
    ],
  );
  if (inserted.rows[0]) return { id: inserted.rows[0].id, reused: false };
  const raced = await query<{ id: string }>(
    sql,
    "select id from pack_candidate_revisions where publisher=$1 and pack_name=$2 and source_digest=$3",
    [pack.publisher, pack.name, pack.sourceDigest],
  );
  if (!raced.rows[0]) {
    throw new Error("candidate revision conflict could not be resolved");
  }
  return { id: raced.rows[0].id, reused: true };
}

export async function countPackRevisions(sql: Queryable): Promise<number> {
  const result = await query<{ count: string }>(
    sql,
    "select count(*)::text as count from pack_candidate_revisions",
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function getActivePack(
  sql: Queryable,
  publisher?: string,
  name?: string,
): Promise<Record<string, unknown> | null> {
  const filtered = publisher !== undefined && name !== undefined;
  const result = await query<Record<string, unknown>>(
    sql,
    `select ar.candidate_revision_id as id,
            ar.candidate_revision_id as revision,
            ar.publisher, ar.pack_name as name, cr.version, cr.manifest,
            cr.normalized
       from pack_active_revisions ar
       join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
      ${filtered ? "where ar.publisher=$1 and ar.pack_name=$2" : ""}
      order by ar.activated_at desc limit 1`,
    filtered ? [publisher, name] : [],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...row,
    normalized: typeof row.normalized === "string"
      ? JSON.parse(row.normalized)
      : row.normalized,
    manifest: typeof row.manifest === "string"
      ? JSON.parse(row.manifest)
      : row.manifest,
  };
}

export async function listPacks(sql: Queryable) {
  const result = await query(
    sql,
    `select ar.publisher, ar.pack_name as name, cr.version, cr.id as revision_id, cr.source_digest from pack_active_revisions ar join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id order by ar.publisher, ar.pack_name`,
  );
  return result.rows;
}

export async function getPack(sql: Queryable, publisher: string, name: string) {
  return await getActivePack(sql, publisher, name);
}

export async function getDefinition(
  sql: Queryable,
  table: string,
  publisher: string,
  name: string,
) {
  const allowed = new Set([
    "resource_definitions",
    "relationship_definitions",
    "lifecycle_definitions",
    "action_definitions",
    "hook_definitions",
    "role_definitions",
    "policy_definitions",
    "seed_definitions",
  ]);
  if (!allowed.has(table)) throw new Error("unknown definition table");
  const section = table === "policy_definitions"
    ? "policies"
    : table.replace("_definitions", "s");
  const result = await query<{ document: Record<string, unknown> | string }>(
    sql,
    `select cr.normalized->$3->$2 as document
       from pack_active_revisions ar
       join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
      where ar.publisher=$1 and cr.normalized->$3 ? $2
      order by ar.activated_at desc limit 1`,
    [publisher, name, section],
  );
  const value = result.rows[0]?.document;
  if (!value) return null;
  const document = typeof value === "string" ? JSON.parse(value) : value;
  return {
    document,
    spec: document.spec ?? {},
    script_digest: table === "hook_definitions"
      ? (document.spec as Record<string, unknown> | undefined)?.script_digest
      : undefined,
  };
}
