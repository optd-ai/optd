import type {
  HistoryPage,
  ObjectReader,
  ReadAddress,
} from "../../../application/ports/object_reader.ts";
import { qualifiedIdentity } from "../../../domain/objects/read.ts";
import {
  type HistoryEntry,
  historyEntryContract,
  type ObjectDto,
  objectDtoContract,
  type RelationshipDto,
  relationshipDtoContract,
} from "../../../schemas/api/objects.ts";
import { query, type Queryable, quoteIdentifier } from "./client.ts";

type Definition = { revisionId: string; table: string; fields: string[] };

export class PostgresObjectReader implements ObjectReader {
  constructor(private readonly sql: Queryable) {}

  async read(
    address: ReadAddress,
  ): Promise<ObjectDto | RelationshipDto | null> {
    const definition = await this.definition(address);
    if (!definition) return null;
    const relationship = address.definition.kind === "relationship";
    const platform = [
      "id",
      "project_id",
      "version",
      "current_object_version_id",
      "archived_at",
      "created_at",
      "updated_at",
    ];
    if (relationship) platform.push("from_object_id", "to_object_id");
    const columns = [...platform, ...definition.fields].map(quoteIdentifier)
      .join(",");
    const result = await query<Record<string, unknown>>(
      this.sql,
      `select ${columns} from ${
        quoteIdentifier(definition.table)
      } where project_id=$1 and id=$2 for share`,
      [address.projectId, address.objectId],
    );
    const row = result.rows[0];
    if (!row || typeof row.current_object_version_id !== "string") return null;
    const values = Object.fromEntries(
      definition.fields.map((field) => [field, jsonValue(row[field])]),
    );
    const identity = {
      publisher: address.definition.publisher,
      pack: address.definition.pack,
      name: address.definition.name,
      revision_id: definition.revisionId,
    };
    const common = {
      id: String(row.id),
      project_id: String(row.project_id),
      version: Number(row.version),
      object_version_id: row.current_object_version_id,
      archived_at: timestamp(row.archived_at),
      created_at: timestamp(row.created_at)!,
      updated_at: timestamp(row.updated_at)!,
    };
    const dto = relationship
      ? {
        kind: "relationship",
        ...common,
        relationship: identity,
        from: String(row.from_object_id),
        to: String(row.to_object_id),
        fields: values,
      } as RelationshipDto
      : {
        kind: "object",
        ...common,
        resource: identity,
        data: values,
      } as ObjectDto;
    if (
      relationship
        ? !relationshipDtoContract.check(dto)
        : !objectDtoContract.check(dto)
    ) {
      throw new Error(
        "stored current object does not satisfy the public read contract",
      );
    }
    return dto;
  }

  async history(
    address: ReadAddress,
    limit: number,
    before?: { createdAt: string; id: string },
  ): Promise<HistoryPage | null> {
    const definition = await this.definition(address);
    if (!definition) return null;
    const identity = qualifiedIdentity(address.definition);
    const params: unknown[] = [
      address.projectId,
      address.definition.kind,
      identity,
      address.objectId,
    ];
    const keyset = before
      ? (params.push(before.createdAt, before.id),
        "and (created_at,id)<($5::timestamptz,$6::uuid)")
      : "";
    params.push(limit + 1);
    const timeline = await query<Record<string, unknown>>(
      this.sql,
      `select * from (
        select created_at,id,'object_version' entry_kind,version,operation,changeset_commit_id,auth_context_id,
          changed_fields,snapshot_json,null::text body,null::uuid target_object_version_id
        from object_versions where project_id=$1 and definition_kind=$2 and resource_identity=$3 and object_id=$4 ${keyset}
        union all
        select created_at,id,'comment' entry_kind,null::integer,null::text,changeset_commit_id,auth_context_id,
          null::text[],null::jsonb,body,target_object_version_id
        from comments where project_id=$1 and definition_kind=$2 and resource_identity=$3 and object_id=$4 ${keyset}
      ) timeline order by created_at desc,id desc limit $${params.length}`,
      params,
    );
    if (!timeline.rows.length) {
      const exists = await this.read(address);
      return exists ? { items: [], hasMore: false, nextPosition: null } : null;
    }
    const rows = timeline.rows.slice(0, limit);
    const items = rows.map((row) => this.entry(address, definition, row));
    if (items.some((item) => !historyEntryContract.check(item))) {
      throw new Error(
        "stored history does not satisfy the public timeline contract",
      );
    }
    const last = rows.at(-1);
    return {
      items,
      hasMore: timeline.rows.length > limit,
      nextPosition: timeline.rows.length > limit && last
        ? { createdAt: timestamp(last.created_at)!, id: String(last.id) }
        : null,
    };
  }

  private entry(
    address: ReadAddress,
    definition: Definition,
    row: Record<string, unknown>,
  ): HistoryEntry {
    const provenance = {
      changeset_commit_id: String(row.changeset_commit_id),
      auth_context_id: String(row.auth_context_id),
    };
    if (row.entry_kind === "comment") {
      return {
        kind: "comment",
        comment_id: String(row.id),
        body: String(row.body),
        target_object_version_id: String(row.target_object_version_id),
        provenance,
        created_at: timestamp(row.created_at)!,
      };
    }
    const snapshot = record(row.snapshot_json);
    const base = {
      kind: "object_version" as const,
      object_version_id: String(row.id),
      version: Number(row.version),
      operation: String(row.operation) as "create",
      provenance,
      changed_fields: Array.isArray(row.changed_fields)
        ? row.changed_fields.map(String)
        : [],
      archived_at: timestamp(snapshot.archived_at),
      created_at: timestamp(row.created_at)!,
    };
    if (address.definition.kind === "relationship") {
      const fields = declared(record(snapshot.fields), definition.fields);
      return {
        ...base,
        from: String(snapshot.from),
        to: String(snapshot.to),
        fields,
      };
    }
    return {
      ...base,
      data: declared(record(snapshot.data), definition.fields),
    };
  }

  private async definition(address: ReadAddress): Promise<Definition | null> {
    const result = await query<
      { revision_id: string; table_name: string; document: unknown }
    >(
      this.sql,
      `select ar.candidate_revision_id revision_id,rt.table_name,
              jsonb_extract_path(cr.normalized,$4::text,$5::text) document
         from pack_active_revisions ar
         join pack_candidate_revisions cr on cr.id=ar.candidate_revision_id
         join pack_runtime_tables rt on rt.publisher=ar.publisher and rt.pack_name=ar.pack_name
          and rt.definition_kind=$3 and rt.definition_name=$5
        where ar.publisher=$1 and ar.pack_name=$2`,
      [
        address.definition.publisher,
        address.definition.pack,
        address.definition.kind,
        address.definition.kind === "resource" ? "resources" : "relationships",
        address.definition.name,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const spec = record(record(row.document).spec);
    return {
      revisionId: row.revision_id,
      table: row.table_name,
      fields: Object.keys(record(spec.fields)).sort(),
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function declared(value: Record<string, unknown>, fields: string[]) {
  return Object.fromEntries(
    fields.map((field) => [field, jsonValue(value[field])]),
  );
}
function jsonValue(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}
function timestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(String(value)).toISOString();
}
