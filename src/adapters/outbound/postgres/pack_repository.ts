import { query, type Queryable } from "./client.ts";
import type { LoadedPack } from "../yaml/pack_loader.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";
import { canonicalSha256 } from "../../../domain/ids/canonical_json.ts";

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
  if (existing.rows[0]) {
    await projectComponentRevisions(sql, pack, existing.rows[0].id);
    return { id: existing.rows[0].id, reused: true };
  }
  const id = uuidV7();
  const inserted = await query<{ id: string }>(
    sql,
    `insert into pack_candidate_revisions(id,publisher,pack_name,version,source_digest,content_digest,manifest,normalized,source_files) values ($1,$2,$3,$4,$5,$6,$7::text::jsonb,$8::text::jsonb,$9::text::jsonb) on conflict (publisher,pack_name,source_digest) do nothing returning id`,
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
  if (inserted.rows[0]) {
    await projectComponentRevisions(sql, pack, inserted.rows[0].id);
    return { id: inserted.rows[0].id, reused: false };
  }
  const raced = await query<{ id: string }>(
    sql,
    "select id from pack_candidate_revisions where publisher=$1 and pack_name=$2 and source_digest=$3",
    [pack.publisher, pack.name, pack.sourceDigest],
  );
  if (!raced.rows[0]) {
    throw new Error("candidate revision conflict could not be resolved");
  }
  await projectComponentRevisions(sql, pack, raced.rows[0].id);
  return { id: raced.rows[0].id, reused: true };
}

async function projectComponentRevisions(
  sql: Queryable,
  pack: LoadedPack,
  candidateRevisionId: string,
): Promise<void> {
  const sections = [
    ["resource", pack.resources],
    ["relationship", pack.relationships],
    ["lifecycle", pack.lifecycles],
    ["action", pack.actions],
    ["hook", pack.hooks],
    ["role", pack.roles],
    ["policy", pack.policies],
    ["seed", pack.seeds],
  ] as const;
  for (const [kind, definitions] of sections) {
    for (
      const [name, definition] of Object.entries(definitions).sort(([a], [b]) =>
        a.localeCompare(b)
      )
    ) {
      const canonicalDefinition = "document" in definition
        ? definition.document
        : definition;
      const definitionDigest = `sha256:${await canonicalSha256(
        canonicalDefinition,
      )}`;
      await query(
        sql,
        `insert into pack_component_revisions(id,candidate_revision_id,definition_kind,definition_name,definition_digest)
         values($1,$2,$3,$4,$5) on conflict(candidate_revision_id,definition_kind,definition_name) do nothing`,
        [uuidV7(), candidateRevisionId, kind, name, definitionDigest],
      );
      const stored = (await query<{ definition_digest: string }>(
        sql,
        `select definition_digest from pack_component_revisions
         where candidate_revision_id=$1 and definition_kind=$2 and definition_name=$3`,
        [candidateRevisionId, kind, name],
      )).rows[0];
      if (!stored || stored.definition_digest !== definitionDigest) {
        throw new Error("pack component revision digest conflict");
      }
    }
  }
  await projectHookAttachmentRevisions(sql, pack, candidateRevisionId);
}

async function projectHookAttachmentRevisions(
  sql: Queryable,
  pack: LoadedPack,
  candidateRevisionId: string,
): Promise<void> {
  for (
    const [hookName, hook] of Object.entries(pack.hooks).sort(([a], [b]) =>
      a.localeCompare(b)
    )
  ) {
    const hookComponent = (await query<{ id: string }>(
      sql,
      `select id from pack_component_revisions
       where candidate_revision_id=$1 and definition_kind='hook' and definition_name=$2`,
      [candidateRevisionId, hookName],
    )).rows[0];
    if (!hookComponent) {
      throw new Error("hook component revision is unavailable");
    }
    const attachments = Array.isArray(hook.spec.attachments)
      ? hook.spec.attachments
      : [];
    for (const value of attachments) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const attachment = value as Record<string, unknown>;
      const phase = String(attachment.phase);
      if (
        ![
          "changeset.before_stage",
          "action.stage",
          "changeset.validate",
          "event.after_commit",
        ].includes(phase)
      ) throw new Error("hook attachment phase is invalid");
      const resource = typeof attachment.resource === "string"
        ? attachment.resource
        : null;
      const action = typeof attachment.action === "string"
        ? attachment.action
        : null;
      let componentRevisionId: string | null = null;
      if (resource !== null || action !== null) {
        const componentIdentity = resource ?? action!;
        const componentKind = resource !== null ? "resource" : "action";
        const componentName = componentIdentity.split(":")[1];
        const component = (await query<{ id: string }>(
          sql,
          `select id from pack_component_revisions
           where candidate_revision_id=$1 and definition_kind=$2 and definition_name=$3`,
          [candidateRevisionId, componentKind, componentName],
        )).rows[0];
        if (!component) {
          throw new Error("hook attachment component revision is unavailable");
        }
        componentRevisionId = component.id;
      }
      const declarationSpec = {
        hook: `${pack.publisher}/${pack.name}:${hookName}`,
        phase,
        resource,
        action,
        event: typeof attachment.event === "string" ? attachment.event : null,
        order: typeof attachment.order === "number" ? attachment.order : 0,
        condition: typeof attachment.condition === "string"
          ? attachment.condition
          : null,
        input: attachment.input,
      };
      const declarationDigest = `sha256:${await canonicalSha256(
        declarationSpec,
      )}`;
      await query(
        sql,
        `insert into pack_hook_attachment_revisions(
           id,candidate_revision_id,hook_revision_id,hook_identity,component_revision_id,
           phase,ordinal,declaration_digest,declaration_spec
         ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::text::jsonb)
         on conflict(candidate_revision_id,hook_revision_id,declaration_digest) do nothing`,
        [
          uuidV7(),
          candidateRevisionId,
          hookComponent.id,
          declarationSpec.hook,
          componentRevisionId,
          declarationSpec.phase,
          declarationSpec.order,
          declarationDigest,
          JSON.stringify(declarationSpec),
        ],
      );
      const stored = (await query<{ declaration_digest: string }>(
        sql,
        `select declaration_digest from pack_hook_attachment_revisions
         where candidate_revision_id=$1 and hook_revision_id=$2 and declaration_digest=$3`,
        [candidateRevisionId, hookComponent.id, declarationDigest],
      )).rows[0];
      if (!stored || stored.declaration_digest !== declarationDigest) {
        throw new Error("hook attachment revision digest conflict");
      }
    }
  }
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
  section: string,
  publisher: string,
  pack: string,
  name: string,
) {
  const allowed = new Set([
    "resources",
    "relationships",
    "lifecycles",
    "actions",
    "hooks",
    "roles",
    "policies",
    "seeds",
  ]);
  if (!allowed.has(section)) throw new Error("unknown definition kind");
  const result = await query<{ document: Record<string, unknown> | string }>(
    sql,
    `select jsonb_extract_path(cr.normalized,$4::text,$3::text) as document
       from pack_active_revisions ar
       join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
      where ar.publisher=$1 and ar.pack_name=$2
      order by ar.activated_at desc limit 1`,
    [publisher, pack, name, section],
  );
  const value = result.rows[0]?.document;
  if (!value) return null;
  const document = typeof value === "string" ? JSON.parse(value) : value;
  return {
    document,
    spec: document.spec ?? {},
    script_digest: section === "hooks"
      ? (document.spec as Record<string, unknown> | undefined)?.script_digest
      : undefined,
  };
}
