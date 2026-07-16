import { query, type Queryable, quoteIdentifier } from "./client.ts";
import type { LoadedPack, NormalizedDefinition } from "../yaml/pack_loader.ts";

export type GeneratedSqlObject = {
  kind: "resource_table" | "relationship_table";
  namespace: string;
  name: string;
  tableName: string;
  ddl: string;
};

const identifierPattern = /^[a-z_][a-z0-9_]*$/;
const platformColumns = new Set([
  "id",
  "version",
  "archived_at",
  "archived_by",
  "created_at",
  "updated_at",
  "current_object_version_id",
]);
const relationshipColumns = new Set([
  ...platformColumns,
  "from_object_id",
  "to_object_id",
]);

export function compilePackDdl(pack: LoadedPack): GeneratedSqlObject[] {
  const objects: GeneratedSqlObject[] = [];
  const tableNames = new Set<string>();

  for (const resource of Object.values(pack.resources).sort(byName)) {
    const tableName = generatedTableName("res", resource.name);
    assertUniqueTableName(tableNames, tableName, resource.path);
    const fields = compileFields(resource, platformColumns);
    objects.push({
      kind: "resource_table",
      namespace: resource.publisher,
      name: resource.name,
      tableName,
      ddl: createTableSql(tableName, [
        `${qi("id")} text primary key`,
        `${qi("version")} integer not null default 1`,
        `${qi("created_at")} timestamptz not null default now()`,
        `${qi("updated_at")} timestamptz not null default now()`,
        `${qi("archived_at")} timestamptz`,
        `${qi("archived_by")} text`,
        `${qi("current_object_version_id")} text`,
        ...fields,
      ]),
    });
  }

  for (const relationship of Object.values(pack.relationships).sort(byName)) {
    const tableName = generatedTableName("rel", relationship.name);
    assertUniqueTableName(tableNames, tableName, relationship.path);
    assertRelationshipEndpoint(relationship, "from");
    assertRelationshipEndpoint(relationship, "to");
    const fields = compileFields(relationship, relationshipColumns);
    objects.push({
      kind: "relationship_table",
      namespace: relationship.publisher,
      name: relationship.name,
      tableName,
      ddl: createTableSql(tableName, [
        `${qi("id")} text primary key`,
        `${qi("from_object_id")} text not null`,
        `${qi("to_object_id")} text not null`,
        `${qi("version")} integer not null default 1`,
        `${qi("created_at")} timestamptz not null default now()`,
        `${qi("updated_at")} timestamptz not null default now()`,
        `${qi("archived_at")} timestamptz`,
        `${qi("archived_by")} text`,
        `${qi("current_object_version_id")} text`,
        ...fields,
      ]),
    });
  }

  return objects;
}

export async function applyPackDdl(
  sql: Queryable,
  revision: string,
  objects: GeneratedSqlObject[],
): Promise<void> {
  for (const object of objects) {
    await query(sql, object.ddl);
    await query(
      sql,
      `insert into generated_sql_objects(revision,kind,namespace,name,table_name,ddl)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (revision, kind, namespace, name) do update set
         table_name=excluded.table_name,
         ddl=excluded.ddl`,
      [
        revision,
        object.kind,
        object.namespace,
        object.name,
        object.tableName,
        object.ddl,
      ],
    );
  }
}

function compileFields(
  definition: NormalizedDefinition,
  reservedColumns: Set<string>,
): string[] {
  const rawFields = definition.spec.fields;
  if (rawFields === undefined) return [];
  if (!isRecord(rawFields)) {
    throw new Error(`${definition.path}: spec.fields must be an object`);
  }
  const seen = new Set<string>();
  const compiled: string[] = [];
  for (const [fieldName, fieldConfig] of Object.entries(rawFields).sort()) {
    assertIdentifier(fieldName, `${definition.path}: field name`);
    if (reservedColumns.has(fieldName)) {
      throw new Error(
        `${definition.path}: field '${fieldName}' conflicts with generated column`,
      );
    }
    if (seen.has(fieldName)) {
      throw new Error(`${definition.path}: duplicate SQL column ${fieldName}`);
    }
    seen.add(fieldName);
    if (!isRecord(fieldConfig)) {
      throw new Error(
        `${definition.path}: field '${fieldName}' must be an object`,
      );
    }
    const type = fieldConfig.type;
    if (typeof type !== "string") {
      throw new Error(
        `${definition.path}: field '${fieldName}' missing string type`,
      );
    }
    const sqlType = compileFieldType(
      type,
      `${definition.path}: field '${fieldName}'`,
    );
    const notNull = fieldConfig.required === true ? " not null" : "";
    compiled.push(`${qi(fieldName)} ${sqlType}${notNull}`);
  }
  return compiled;
}

function compileFieldType(type: string, context: string): string {
  switch (type) {
    case "string":
      return "text";
    case "integer":
      return "integer";
    case "decimal":
      return "numeric";
    case "boolean":
      return "boolean";
    case "timestamp":
      return "timestamptz";
    case "date":
      return "date";
    default:
      throw new Error(`${context}: unsupported field type '${type}'`);
  }
}

function assertRelationshipEndpoint(
  relationship: NormalizedDefinition,
  side: "from" | "to",
): void {
  const endpoint = relationship.spec[side];
  if (!isRecord(endpoint)) {
    throw new Error(`${relationship.path}: spec.${side} must be an object`);
  }
  const resource = endpoint.resource;
  const field = endpoint.field;
  if (typeof resource !== "string" || !identifierPattern.test(resource)) {
    throw new Error(
      `${relationship.path}: spec.${side}.resource must be an identifier`,
    );
  }
  if (
    field !== undefined &&
    (typeof field !== "string" || !identifierPattern.test(field))
  ) {
    throw new Error(
      `${relationship.path}: spec.${side}.field must be an identifier`,
    );
  }
}

function generatedTableName(prefix: "res" | "rel", name: string): string {
  assertIdentifier(name, `${prefix} source name`);
  const tableName = `${prefix}_${name}`;
  assertIdentifier(tableName, "generated table name");
  return tableName;
}

function assertUniqueTableName(
  tableNames: Set<string>,
  tableName: string,
  path: string,
): void {
  if (tableNames.has(tableName)) {
    throw new Error(`${path}: duplicate generated table ${tableName}`);
  }
  tableNames.add(tableName);
}

function assertIdentifier(identifier: string, context: string): void {
  if (!identifierPattern.test(identifier) || identifier.length > 55) {
    throw new Error(`${context}: invalid SQL identifier '${identifier}'`);
  }
}

function createTableSql(tableName: string, columns: string[]): string {
  return `create table if not exists ${qi(tableName)} (\n  ${
    columns.join(",\n  ")
  }\n)`;
}

function qi(identifier: string): string {
  return quoteIdentifier(identifier);
}

function byName(a: NormalizedDefinition, b: NormalizedDefinition): number {
  return a.name.localeCompare(b.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
