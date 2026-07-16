// TEST-ONLY PREREQUISITE DEBT (DAG Chunk 14): replace these synthetic current,
// commit, version, and comment facts with public changeset stage + commit calls.
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import {
  query,
  type Queryable,
  quoteIdentifier,
  type Sql,
} from "../../src/adapters/outbound/postgres/client.ts";

export type ObjectHistoryFixtureInput = {
  sql: Sql;
  publisher: string;
  pack: string;
  resource: string;
  relationship: string;
  projectIds: readonly [string, string];
  authContextId: string;
  resourceData: Record<string, unknown>;
  relationshipFields?: Record<string, unknown>;
};

export async function seedObjectHistoryFixture(
  input: ObjectHistoryFixtureInput,
) {
  const resource = await runtime(input, "resource", input.resource);
  const relationship = await runtime(input, "relationship", input.relationship);
  const revision = resource.revision;
  assertDeclaredFields(input.resourceData, resource.fields, "resourceData");
  assertDeclaredFields(
    input.relationshipFields ?? {},
    relationship.fields,
    "relationshipFields",
  );
  const ids = {
    object: uuidV7(),
    otherObject: uuidV7(),
    projectTwoObject: uuidV7(),
    relationship: uuidV7(),
    objectVersionOne: uuidV7(),
    objectVersionTwo: uuidV7(),
    projectTwoVersion: uuidV7(),
    relationshipVersionOne: uuidV7(),
    relationshipVersionTwo: uuidV7(),
    comment: uuidV7(),
    commit: uuidV7(),
  };
  const identity = `${input.publisher}/${input.pack}:${input.resource}`;
  const relationshipIdentity =
    `${input.publisher}/${input.pack}:${input.relationship}`;
  const now = new Date();
  const earlier = new Date(now.getTime() - 1000);
  return await input.sql.begin(async (sql) => {
    await query(
      sql,
      "insert into changeset_commits(id,committed_auth_context_id,committed_at) values($1,$2,$3)",
      [ids.commit, input.authContextId, earlier],
    );
    await insertCurrent(
      sql,
      resource.table,
      ids.object,
      input.projectIds[0],
      input.authContextId,
      input.resourceData,
    );
    await insertCurrent(
      sql,
      resource.table,
      ids.otherObject,
      input.projectIds[0],
      input.authContextId,
      input.resourceData,
    );
    await insertCurrent(
      sql,
      resource.table,
      ids.projectTwoObject,
      input.projectIds[1],
      input.authContextId,
      input.resourceData,
    );
    await version(sql, {
      id: ids.objectVersionOne,
      project: input.projectIds[0],
      kind: "resource",
      identity,
      object: ids.object,
      version: 1,
      previous: null,
      commit: ids.commit,
      operation: "create",
      revision,
      snapshot: { data: input.resourceData, archived_at: null },
      auth: input.authContextId,
      at: earlier,
    });
    await version(sql, {
      id: ids.objectVersionTwo,
      project: input.projectIds[0],
      kind: "resource",
      identity,
      object: ids.object,
      version: 2,
      previous: ids.objectVersionOne,
      commit: ids.commit,
      operation: "update",
      revision,
      snapshot: { data: input.resourceData, archived_at: null },
      auth: input.authContextId,
      at: now,
    });
    await version(sql, {
      id: ids.projectTwoVersion,
      project: input.projectIds[1],
      kind: "resource",
      identity,
      object: ids.projectTwoObject,
      version: 1,
      previous: null,
      commit: ids.commit,
      operation: "create",
      revision,
      snapshot: { data: input.resourceData, archived_at: null },
      auth: input.authContextId,
      at: earlier,
    });
    await query(
      sql,
      `update ${
        quoteIdentifier(resource.table)
      } set version=2,current_object_version_id=$1,updated_at=$2 where project_id=$3 and id=$4`,
      [ids.objectVersionTwo, now, input.projectIds[0], ids.object],
    );
    await query(
      sql,
      `update ${
        quoteIdentifier(resource.table)
      } set current_object_version_id=$1 where project_id=$2 and id=$3`,
      [ids.projectTwoVersion, input.projectIds[1], ids.projectTwoObject],
    );
    const relFields = input.relationshipFields ?? {};
    await insertRelationship(
      sql,
      relationship.table,
      ids.relationship,
      input.projectIds[0],
      ids.object,
      ids.otherObject,
      input.authContextId,
      relFields,
    );
    await version(sql, {
      id: ids.relationshipVersionOne,
      project: input.projectIds[0],
      kind: "relationship",
      identity: relationshipIdentity,
      object: ids.relationship,
      version: 1,
      previous: null,
      commit: ids.commit,
      operation: "link",
      revision,
      snapshot: {
        from: ids.object,
        to: ids.otherObject,
        fields: relFields,
        archived_at: null,
      },
      auth: input.authContextId,
      at: earlier,
    });
    await version(sql, {
      id: ids.relationshipVersionTwo,
      project: input.projectIds[0],
      kind: "relationship",
      identity: relationshipIdentity,
      object: ids.relationship,
      version: 2,
      previous: ids.relationshipVersionOne,
      commit: ids.commit,
      operation: "unlink",
      revision,
      snapshot: {
        from: ids.object,
        to: ids.otherObject,
        fields: relFields,
        archived_at: now.toISOString(),
      },
      auth: input.authContextId,
      at: now,
    });
    await query(
      sql,
      `update ${
        quoteIdentifier(relationship.table)
      } set version=2,current_object_version_id=$1,archived_at=$2,archived_by=$3,updated_at=$2 where project_id=$4 and id=$5`,
      [
        ids.relationshipVersionTwo,
        now,
        input.authContextId,
        input.projectIds[0],
        ids.relationship,
      ],
    );
    await query(
      sql,
      `insert into comments(id,project_id,definition_kind,resource_identity,object_id,target_object_version_id,changeset_commit_id,auth_context_id,body,created_at) values($1,$2,'resource',$3,$4,$5,$6,$7,$8,$9)`,
      [
        ids.comment,
        input.projectIds[0],
        identity,
        ids.object,
        ids.objectVersionTwo,
        ids.commit,
        input.authContextId,
        "fixture comment",
        new Date(now.getTime() + 1),
      ],
    );
    return ids;
  });
}

async function runtime(
  input: ObjectHistoryFixtureInput,
  kind: string,
  name: string,
) {
  const result = await query<
    { table_name: string; revision: string; fields: unknown }
  >(
    input.sql,
    `select rt.table_name,ar.candidate_revision_id revision,
            jsonb_extract_path(cr.normalized,$5,$4,'spec','fields') fields
       from pack_runtime_tables rt
       join pack_active_revisions ar on ar.publisher=rt.publisher and ar.pack_name=rt.pack_name
       join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
      where rt.publisher=$1 and rt.pack_name=$2 and rt.definition_kind=$3 and rt.definition_name=$4`,
    [
      input.publisher,
      input.pack,
      kind,
      name,
      kind === "resource" ? "resources" : "relationships",
    ],
  );
  if (result.rows.length !== 1) {
    throw new Error(`fixture requires exactly one active ${kind} definition`);
  }
  const raw = result.rows[0].fields;
  const fields = raw && typeof raw === "object" && !Array.isArray(raw)
    ? new Set(Object.keys(raw as Record<string, unknown>))
    : new Set<string>();
  return {
    table: result.rows[0].table_name,
    revision: result.rows[0].revision,
    fields,
  };
}
function assertDeclaredFields(
  value: Record<string, unknown>,
  declared: Set<string>,
  label: string,
) {
  const unknown = Object.keys(value).filter((field) => !declared.has(field));
  if (unknown.length) {
    throw new Error(`${label} contains undeclared field ${unknown[0]}`);
  }
}
async function insertCurrent(
  sql: Queryable,
  table: string,
  id: string,
  project: string,
  auth: string,
  data: Record<string, unknown>,
) {
  const fields = Object.keys(data).sort();
  await query(
    sql,
    `insert into ${quoteIdentifier(table)}(id,project_id,created_by,updated_by${
      fields.map((f) => `,${quoteIdentifier(f)}`).join("")
    }) values($1,$2,$3,$3${fields.map((_, i) => `,$${i + 4}`).join("")})`,
    [
      id,
      project,
      auth,
      ...fields.map((field) => data[field]),
    ],
  );
}
async function insertRelationship(
  sql: Queryable,
  table: string,
  id: string,
  project: string,
  from: string,
  to: string,
  auth: string,
  fieldsValue: Record<string, unknown>,
) {
  const fields = Object.keys(fieldsValue).sort();
  await query(
    sql,
    `insert into ${
      quoteIdentifier(table)
    }(id,project_id,from_object_id,to_object_id,created_by,updated_by${
      fields.map((f) => `,${quoteIdentifier(f)}`).join("")
    }) values($1,$2,$3,$4,$5,$5${fields.map((_, i) => `,$${i + 6}`).join("")})`,
    [id, project, from, to, auth, ...fields.map((field) => fieldsValue[field])],
  );
}
async function version(
  sql: Queryable,
  value: {
    id: string;
    project: string;
    kind: string;
    identity: string;
    object: string;
    version: number;
    previous: string | null;
    commit: string;
    operation: string;
    revision: string;
    snapshot: unknown;
    auth: string;
    at: Date;
  },
) {
  await query(
    sql,
    `insert into object_versions(id,project_id,definition_kind,resource_identity,object_id,version,previous_version_id,changeset_commit_id,operation,resource_revision,snapshot_json,changed_fields,auth_context_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,'{}',$12,$13)`,
    [
      value.id,
      value.project,
      value.kind,
      value.identity,
      value.object,
      value.version,
      value.previous,
      value.commit,
      value.operation,
      value.revision,
      JSON.stringify(value.snapshot),
      value.auth,
      value.at,
    ],
  );
}
