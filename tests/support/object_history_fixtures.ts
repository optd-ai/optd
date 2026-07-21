import type { AuthContext } from "../../src/domain/auth/model.ts";
import type { CanonicalOperation } from "../../src/domain/changesets/operations.ts";
import { PostgresCommitRepository } from "../../src/adapters/outbound/postgres/commit_repository.ts";
import { PostgresStageRepository } from "../../src/adapters/outbound/postgres/stage_repository.ts";
import { PostgresHookSecretRepository } from "../../src/adapters/outbound/postgres/hook_secret_repository.ts";
import { EnvelopeCrypto } from "../../src/adapters/outbound/crypto/envelope.ts";
import { TrustedStageHookCoordinator } from "../../src/application/services/hooks/stage_hook_coordinator.ts";
import { makeCommitChangesetService } from "../../src/application/services/commit/commit_changeset.ts";
import { makeStageChangesetService } from "../../src/application/services/changesets/stage_changesets.ts";
import {
  query,
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
  const auth = await loadAuth(input.sql, input.authContextId);
  const normalized = (await query<{ normalized: unknown }>(
    input.sql,
    `select candidate.normalized from pack_active_revisions active
     join pack_candidate_revisions candidate on candidate.id=active.candidate_revision_id
     where active.publisher=$1 and active.pack_name=$2`,
    [input.publisher, input.pack],
  )).rows[0]?.normalized;
  const document = record(normalized);
  const resourceIdentity = `${input.publisher}/${input.pack}:${input.resource}`;
  const resourceDefinition = record(record(document.resources)[input.resource]);
  const declaredResourceFields = record(record(resourceDefinition.spec).fields);
  const resourceData = {
    ...input.resourceData,
    ...(Object.hasOwn(declaredResourceFields, "email") &&
        !Object.hasOwn(input.resourceData, "email") &&
        !Object.hasOwn(input.resourceData, "phone")
      ? { email: "fixture@example.test" }
      : {}),
  };
  const relationshipIdentity =
    `${input.publisher}/${input.pack}:${input.relationship}`;
  const relationship = record(
    record(document.relationships)[input.relationship],
  );
  const relationshipSpec = record(relationship.spec);
  const fromIdentity = String(record(relationshipSpec.from).resource);
  const toIdentity = String(record(relationshipSpec.to).resource);
  const historyData = uniqueFixtureData(resourceData, "history");
  const otherData = uniqueFixtureData(resourceData, "other");
  const projectTwoData = uniqueFixtureData(resourceData, "project-two");
  const temporaryData = temporaryVersion(historyData);
  const operations: Record<string, unknown>[] = [
    {
      op: "create",
      key: "history_object",
      project_id: input.projectIds[0],
      resource: resourceIdentity,
      fields: temporaryData,
    },
    {
      op: "create",
      key: "other_object",
      project_id: input.projectIds[0],
      resource: resourceIdentity,
      fields: otherData,
    },
    {
      op: "create",
      key: "project_two_object",
      project_id: input.projectIds[1],
      resource: resourceIdentity,
      fields: projectTwoData,
    },
  ];
  const endpointRefs = new Map<string, unknown>();
  for (
    const [side, identity] of [["from", fromIdentity], [
      "to",
      toIdentity,
    ]] as const
  ) {
    if (identity === "system:principal") {
      endpointRefs.set(side, auth.principalId);
      continue;
    }
    const key = `relationship_${side}`;
    operations.push({
      op: "create",
      key,
      project_id: input.projectIds[0],
      resource: identity,
      fields: minimalResourceData(document, identity),
    });
    endpointRefs.set(side, { $ref: `${key}.object_id` });
  }
  operations.push({
    op: "link",
    key: "history_relationship",
    project_id: input.projectIds[0],
    relationship: relationshipIdentity,
    from: endpointRefs.get("from"),
    to: endpointRefs.get("to"),
    fields: input.relationshipFields ?? {},
  });
  const first = await stageAndCommit(input.sql, auth, operations);
  const firstOperations = first.operations as CanonicalOperation[];
  const object = produced(firstOperations, "history_object", "object_id");
  const otherObject = produced(firstOperations, "other_object", "object_id");
  const projectTwoObject = produced(
    firstOperations,
    "project_two_object",
    "object_id",
  );
  const relationshipId = produced(
    firstOperations,
    "history_relationship",
    "relationship_id",
  );
  const from = endpointValue(firstOperations, endpointRefs.get("from"));
  const to = endpointValue(firstOperations, endpointRefs.get("to"));

  await stageAndCommit(input.sql, auth, [{
    op: "update",
    project_id: input.projectIds[0],
    resource: resourceIdentity,
    object_id: object,
    set: changedValues(temporaryData, historyData),
  }, {
    op: "unlink",
    project_id: input.projectIds[0],
    relationship: relationshipIdentity,
    relationship_id: relationshipId,
  }]);
  const final = await stageAndCommit(input.sql, auth, [{
    op: "comment",
    project_id: input.projectIds[0],
    resource: resourceIdentity,
    object_id: object,
    body: "fixture comment",
  }, {
    op: "link",
    key: "replacement_relationship",
    project_id: input.projectIds[0],
    relationship: relationshipIdentity,
    from,
    to,
    fields: replacementFields(input.relationshipFields ?? {}),
  }]);
  const replacement = produced(
    final.operations as CanonicalOperation[],
    "replacement_relationship",
    "relationship_id",
  );
  const versions = (await query<{
    id: string;
    object_id: string;
    version: number;
    definition_kind: string;
  }>(
    input.sql,
    `select id,object_id,version,definition_kind from object_versions
     where object_id=any($1::uuid[]) order by object_id,version`,
    [[object, projectTwoObject, relationshipId]],
  )).rows;
  const comment = (await query<{ id: string }>(
    input.sql,
    "select id from comments where project_id=$1 and object_id=$2 order by created_at desc,id desc limit 1",
    [input.projectIds[0], object],
  )).rows[0].id;
  return {
    object,
    otherObject,
    projectTwoObject,
    relationship: relationshipId,
    replacementRelationship: replacement,
    objectVersionOne: versionId(versions, object, 1),
    objectVersionTwo: versionId(versions, object, 2),
    projectTwoVersion: versionId(versions, projectTwoObject, 1),
    relationshipVersionOne: versionId(versions, relationshipId, 1),
    relationshipVersionTwo: versionId(versions, relationshipId, 2),
    comment,
    commit: final.commit.id,
  };
}

async function stageAndCommit(
  sql: Sql,
  auth: AuthContext,
  operations: Record<string, unknown>[],
) {
  const stage = await makeStageChangesetService(
    new PostgresStageRepository(sql),
    new TrustedStageHookCoordinator(
      new PostgresHookSecretRepository(sql, new EnvelopeCrypto()),
    ),
  ).stage({ operations }, auth);
  if (!stage.ok) {
    throw new Error(
      `canonical fixture stage failed: ${JSON.stringify(stage.error)}`,
    );
  }
  const commit = await makeCommitChangesetService(
    new PostgresCommitRepository(sql),
  ).commit(stage.value.id, {}, auth);
  if (!commit.ok) {
    throw new Error(`canonical fixture commit failed: ${commit.error.code}`);
  }
  return { ...stage.value, commit: commit.value };
}

async function loadAuth(sql: Sql, id: string): Promise<AuthContext> {
  const row = (await query<{
    id: string;
    principal_id: string;
    principal_type: "human_user" | "agent_user";
    human_user_id: string;
    session_id: string;
    authorization_id: string | null;
    credential_kind: AuthContext["credentialKind"];
    roles: string[];
    created_at: Date | string;
  }>(
    sql,
    `select context.id,context.principal_id,principal.type principal_type,
            context.human_user_id,context.session_id,context.authorization_id,
            context.credential_kind,context.roles,context.created_at
       from auth_contexts context join principals principal on principal.id=context.principal_id
      where context.id=$1`,
    [id],
  )).rows[0];
  if (!row) throw new Error("fixture auth context is unavailable");
  return {
    id: row.id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    humanUserId: row.human_user_id,
    sessionId: row.session_id,
    ...(row.authorization_id ? { authorizationId: row.authorization_id } : {}),
    credentialKind: row.credential_kind,
    roles: row.roles,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString(),
  };
}

function minimalResourceData(
  document: Record<string, unknown>,
  identity: string,
) {
  const name = identity.split(":")[1];
  const definition = record(record(document.resources)[name]);
  const fields = record(record(definition.spec).fields);
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) =>
      record(value).required === true
    )
      .map(([field, value]) => [field, fixtureValue(field, record(value))]),
  );
}
function fixtureValue(field: string, spec: Record<string, unknown>): unknown {
  if (Array.isArray(spec.enum) && spec.enum.length) return spec.enum[0];
  switch (spec.type) {
    case "integer":
      return 1;
    case "decimal":
      return 1;
    case "boolean":
      return false;
    case "date":
      return "2026-01-01";
    case "timestamp":
      return "2026-01-01T00:00:00.000Z";
    default:
      return `Fixture ${field}`;
  }
}
function uniqueFixtureData(value: Record<string, unknown>, suffix: string) {
  return typeof value.email === "string"
    ? { ...value, email: `fixture-${suffix}@example.test` }
    : { ...value };
}
function temporaryVersion(value: Record<string, unknown>) {
  const key = Object.keys(value).find((field) =>
    typeof value[field] === "string"
  );
  if (!key) {
    throw new Error("fixture resource requires one mutable string field");
  }
  return { ...value, [key]: `${String(value[key])} temporary` };
}
function changedValues(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  return Object.fromEntries(
    Object.entries(after).filter(([field, value]) => before[field] !== value),
  );
}
function replacementFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([field, value]) =>
      typeof value === "boolean"
        ? [field, !value]
        : typeof value === "string"
        ? [field, "replacement"]
        : [field, value]
    ),
  );
}
function produced(
  operations: CanonicalOperation[],
  key: string,
  property: string,
) {
  const value = operations.find((operation) => operation.key === key)
    ?.[property];
  if (typeof value !== "string") {
    throw new Error(`missing generated ${property}`);
  }
  return value;
}
function endpointValue(operations: CanonicalOperation[], authored: unknown) {
  if (typeof authored === "string") return authored;
  const reference = String(record(authored).$ref);
  return produced(operations, reference.split(".")[0], "object_id");
}
function versionId(
  versions: Array<{ id: string; object_id: string; version: number }>,
  object: string,
  version: number,
) {
  const found = versions.find((row) =>
    row.object_id === object && Number(row.version) === version
  );
  if (!found) throw new Error("canonical fixture version is unavailable");
  return found.id;
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") value = JSON.parse(value);
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
