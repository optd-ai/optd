import { query, type Queryable, quoteIdentifier } from "./client.ts";
import type { LoadedPack, NormalizedDefinition } from "../yaml/pack_loader.ts";
import type {
  MigrationChange,
  MigrationPlan,
} from "../../../domain/migrations/pack_migration.ts";
import { uuidV7 } from "../../../domain/ids/uuid_v7.ts";

export type GeneratedSqlObject = {
  kind: "resource_table" | "relationship_table";
  publisher: string;
  pack: string;
  name: string;
  tableName: string;
  ddl: string;
};
export type MigrationSqlStep = {
  id: string;
  kind: string;
  change_ids: string[];
  statement_indexes: number[];
};
export type MigrationDependencyGraph = {
  edges: Array<{ from_step_id: string; to_step_id: string; reason: string }>;
  topological_order: string[];
};
export type CompiledMigrationPreview = {
  statements: string[];
  steps: MigrationSqlStep[];
  dependency_graph: MigrationDependencyGraph;
};

const platformColumns = new Set([
  "id",
  "project_id",
  "version",
  "archived_at",
  "archived_by",
  "created_at",
  "created_by",
  "updated_at",
  "updated_by",
  "current_object_version_id",
]);
const relationshipColumns = new Set([
  ...platformColumns,
  "from_object_id",
  "to_object_id",
]);

export async function compilePackDdl(
  pack: LoadedPack,
): Promise<GeneratedSqlObject[]> {
  const objects: GeneratedSqlObject[] = [];
  const tableNames = new Set<string>();
  for (const resource of Object.values(pack.resources).sort(byName)) {
    const tableName = await physicalTableName(
      "res",
      pack.publisher,
      pack.name,
      resource.name,
    );
    assertUniqueTableName(tableNames, tableName, resource.path);
    objects.push({
      kind: "resource_table",
      publisher: pack.publisher,
      pack: pack.name,
      name: resource.name,
      tableName,
      ddl: compileResourceTable(resource, tableName),
    });
  }
  for (const relationship of Object.values(pack.relationships).sort(byName)) {
    const tableName = await physicalTableName(
      "rel",
      pack.publisher,
      pack.name,
      relationship.name,
    );
    assertUniqueTableName(tableNames, tableName, relationship.path);
    objects.push({
      kind: "relationship_table",
      publisher: pack.publisher,
      pack: pack.name,
      name: relationship.name,
      tableName,
      ddl: compileRelationshipTable(relationship, tableName),
    });
  }
  return objects;
}

export async function compileMigrationPreview(
  candidate: LoadedPack,
  plan: MigrationPlan,
): Promise<CompiledMigrationPreview> {
  const objects = await compilePackDdl(candidate);
  const objectByKey = new Map(
    objects.map((object) => [`${object.kind}:${object.name}`, object]),
  );
  const statements: string[] = [];
  const steps: MigrationSqlStep[] = [];
  const resourceSteps: string[] = [];
  const relationshipSteps: string[] = [];

  const addStep = (kind: string, changeIds: string[], sql: string[]) => {
    const indexes = sql.map((statement) => {
      if (!statement.trim() || statement.trimStart().startsWith("--")) {
        throw new Error(
          `migration preview produced non-executable SQL for ${kind}`,
        );
      }
      statements.push(statement);
      return statements.length - 1;
    });
    const step = {
      id: uuidV7(),
      kind,
      change_ids: changeIds,
      statement_indexes: indexes,
    };
    steps.push(step);
    return step.id;
  };

  for (
    const change of [...plan.changes].sort((a, b) =>
      migrationChangeRank(a) - migrationChangeRank(b) ||
      a.id.localeCompare(b.id)
    )
  ) {
    const resourceName = localName(change.target.resource);
    const relationshipName = localName(change.target.relationship);
    if (change.kind === "add_resource" && resourceName) {
      const object = objectByKey.get(`resource_table:${resourceName}`);
      if (!object) throw new Error(`missing compiled resource ${resourceName}`);
      const id = addStep(change.kind, [change.id], [
        object.ddl,
        runtimeTableUpsert(
          candidate,
          "resource",
          resourceName,
          object.tableName,
        ),
      ]);
      resourceSteps.push(id);
    } else if (change.kind === "remove_resource" && resourceName) {
      const table = await physicalTableName(
        "res",
        candidate.publisher,
        candidate.name,
        resourceName,
      );
      const id = addStep(change.kind, [change.id], [
        `drop table ${qi(table)}`,
        runtimeTableDelete(candidate, "resource", resourceName),
      ]);
      resourceSteps.push(id);
    } else if (
      change.kind === "add_field" && resourceName && change.target.field
    ) {
      const table = await physicalTableName(
        "res",
        candidate.publisher,
        candidate.name,
        resourceName,
      );
      const definition = candidate.resources[resourceName];
      const descriptor = record(
        record(definition?.spec.fields)[change.target.field],
      );
      const fieldSql = [
        `alter table ${qi(table)} add column ${
          compileColumn(change.target.field, descriptor, table)
        }`,
        ...descriptor.unique === true
          ? [
            `alter table ${qi(table)} add constraint ${
              qi(constraintName("uq", table, change.target.field))
            } unique (${qi("project_id")}, ${qi(change.target.field)})`,
          ]
          : [],
      ];
      const id = addStep(change.kind, [change.id], fieldSql);
      resourceSteps.push(id);
    } else if (
      change.kind === "remove_field" && resourceName && change.target.field
    ) {
      const table = await physicalTableName(
        "res",
        candidate.publisher,
        candidate.name,
        resourceName,
      );
      const id = addStep(change.kind, [change.id], [
        `alter table ${qi(table)} drop column ${qi(change.target.field)}`,
      ]);
      resourceSteps.push(id);
    } else if (
      change.kind === "change_field" && resourceName && change.target.field
    ) {
      if (change.status === "blocked") continue;
      const table = await physicalTableName(
        "res",
        candidate.publisher,
        candidate.name,
        resourceName,
      );
      const descriptor = record(
        record(
          candidate.resources[resourceName]?.spec.fields,
        )[change.target.field],
      );
      const requiredSql = descriptor.required === true
        ? "set not null"
        : "drop not null";
      const checkName = constraintName("ck", table, change.target.field);
      const uniqueName = constraintName("uq", table, change.target.field);
      const checks = compileChecks(change.target.field, descriptor);
      const fieldSql = [
        `alter table ${qi(table)} alter column ${
          qi(change.target.field)
        } ${requiredSql}`,
        `alter table ${qi(table)} drop constraint if exists ${qi(checkName)}`,
        ...checks.length
          ? [
            `alter table ${qi(table)} add constraint ${qi(checkName)} check (${
              checks.join(" and ")
            })`,
          ]
          : [],
        `alter table ${qi(table)} drop constraint if exists ${qi(uniqueName)}`,
        ...descriptor.unique === true
          ? [
            `alter table ${qi(table)} add constraint ${
              qi(uniqueName)
            } unique (${qi("project_id")}, ${qi(change.target.field)})`,
          ]
          : [],
      ];
      const id = addStep(change.kind, [change.id], fieldSql);
      resourceSteps.push(id);
    } else if (change.kind === "add_relationship" && relationshipName) {
      const object = objectByKey.get(`relationship_table:${relationshipName}`);
      if (!object) {
        throw new Error(`missing compiled relationship ${relationshipName}`);
      }
      const id = addStep(change.kind, [change.id], [
        object.ddl,
        runtimeTableUpsert(
          candidate,
          "relationship",
          relationshipName,
          object.tableName,
        ),
      ]);
      relationshipSteps.push(id);
    } else if (change.kind === "remove_relationship" && relationshipName) {
      const table = await physicalTableName(
        "rel",
        candidate.publisher,
        candidate.name,
        relationshipName,
      );
      const id = addStep(change.kind, [change.id], [
        `drop table ${qi(table)}`,
        runtimeTableDelete(candidate, "relationship", relationshipName),
      ]);
      relationshipSteps.push(id);
    } else if (change.kind === "change_relationship" && relationshipName) {
      const object = objectByKey.get(`relationship_table:${relationshipName}`);
      if (!object) {
        throw new Error(`missing compiled relationship ${relationshipName}`);
      }
      const id = addStep(change.kind, [change.id], [
        `drop table ${qi(object.tableName)}`,
        object.ddl,
        runtimeTableUpsert(
          candidate,
          "relationship",
          relationshipName,
          object.tableName,
        ),
      ]);
      relationshipSteps.push(id);
    }
  }

  const activationId = addStep(
    "activate_pack_revision",
    plan.changes.map((change) => change.id),
    [
      `insert into pack_active_revisions(publisher,pack_name,candidate_revision_id,activated_at) values (${
        literal(candidate.publisher)
      },${literal(candidate.name)},${
        literal(plan.to_pack_revision_id)
      }::uuid,now()) on conflict (publisher,pack_name) do update set candidate_revision_id=excluded.candidate_revision_id,activated_at=excluded.activated_at`,
    ],
  );
  const edges: MigrationDependencyGraph["edges"] = [];
  for (const resourceStep of resourceSteps) {
    for (const relationshipStep of relationshipSteps) {
      edges.push({
        from_step_id: resourceStep,
        to_step_id: relationshipStep,
        reason: "relationship tables depend on resource definitions",
      });
    }
  }
  for (const step of [...resourceSteps, ...relationshipSteps]) {
    edges.push({
      from_step_id: step,
      to_step_id: activationId,
      reason: "global activation follows all physical schema changes",
    });
  }
  return {
    statements,
    steps,
    dependency_graph: {
      edges: edges.sort((a, b) =>
        a.from_step_id.localeCompare(b.from_step_id) ||
        a.to_step_id.localeCompare(b.to_step_id)
      ),
      topological_order: steps.map((step) => step.id),
    },
  };
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
      `insert into generated_sql_objects(revision,kind,namespace,name,table_name,ddl) values ($1,$2,$3,$4,$5,$6) on conflict (revision,kind,namespace,name) do update set table_name=excluded.table_name,ddl=excluded.ddl`,
      [
        revision,
        object.kind,
        object.publisher,
        object.name,
        object.tableName,
        object.ddl,
      ],
    );
  }
}

function compileResourceTable(
  definition: NormalizedDefinition,
  tableName: string,
): string {
  const fields = record(definition.spec.fields);
  const columns = [
    `${qi("id")} uuid primary key`,
    `${qi("project_id")} uuid not null references ${qi("projects")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("version")} bigint not null default 1`,
    `${qi("created_at")} timestamptz not null default now()`,
    `${qi("created_by")} uuid not null references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("updated_at")} timestamptz not null default now()`,
    `${qi("updated_by")} uuid not null references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("archived_at")} timestamptz`,
    `${qi("archived_by")} uuid references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("current_object_version_id")} uuid`,
    `foreign key (${qi("project_id")},${qi("id")},${
      qi("current_object_version_id")
    }) references ${qi("object_versions")}(${qi("project_id")},${
      qi("object_id")
    },${qi("id")}) deferrable initially deferred`,
    ...compileFields(definition, platformColumns, tableName),
    ...Object.entries(fields).filter(([, descriptor]) =>
      record(descriptor).unique === true
    ).map(([field]) =>
      `constraint ${qi(constraintName("uq", tableName, field))} unique (${
        qi("project_id")
      }, ${qi(field)})`
    ),
  ];
  return createTableSql(tableName, columns);
}

function compileRelationshipTable(
  definition: NormalizedDefinition,
  tableName: string,
): string {
  assertRelationshipEndpoint(definition, "from");
  assertRelationshipEndpoint(definition, "to");
  const columns = [
    `${qi("id")} uuid primary key`,
    `${qi("project_id")} uuid not null references ${qi("projects")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("from_object_id")} uuid not null`,
    `${qi("to_object_id")} uuid not null`,
    `${qi("version")} bigint not null default 1`,
    `${qi("created_at")} timestamptz not null default now()`,
    `${qi("created_by")} uuid not null references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("updated_at")} timestamptz not null default now()`,
    `${qi("updated_by")} uuid not null references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("archived_at")} timestamptz`,
    `${qi("archived_by")} uuid references ${qi("auth_contexts")}(${
      qi("id")
    }) deferrable initially deferred`,
    `${qi("current_object_version_id")} uuid`,
    `foreign key (${qi("project_id")},${qi("id")},${
      qi("current_object_version_id")
    }) references ${qi("object_versions")}(${qi("project_id")},${
      qi("object_id")
    },${qi("id")}) deferrable initially deferred`,
    ...compileFields(definition, relationshipColumns, tableName),
  ];
  const unique = Array.isArray(definition.spec.unique)
    ? definition.spec.unique.map(String)
    : [];
  const create = createTableSql(tableName, columns);
  if (!unique.length) return create;
  const mapped = unique.map((field) =>
    field === "from"
      ? "from_object_id"
      : field === "to"
      ? "to_object_id"
      : field
  );
  const name = constraintName("uq", tableName, mapped.join("_"));
  return `${create}; create unique index ${qi(name)} on ${qi(tableName)} (${
    ["project_id", ...mapped].map(qi).join(", ")
  }) where ${qi("archived_at")} is null`;
}

function compileFields(
  definition: NormalizedDefinition,
  reservedColumns: Set<string>,
  tableName: string,
): string[] {
  const rawFields = definition.spec.fields;
  if (rawFields === undefined) return [];
  if (!isRecord(rawFields)) {
    throw new Error(`${definition.path}: spec.fields must be an object`);
  }
  return Object.entries(rawFields).sort(([a], [b]) => a.localeCompare(b)).map(
    ([name, descriptor]) => {
      assertIdentifier(name, `${definition.path}: field name`);
      if (reservedColumns.has(name)) {
        throw new Error(
          `${definition.path}: field '${name}' conflicts with generated column`,
        );
      }
      return compileColumn(name, record(descriptor), tableName);
    },
  );
}

function compileColumn(
  name: string,
  descriptor: Record<string, unknown>,
  tableName: string,
): string {
  const type = String(descriptor.type ?? "");
  const sqlType = type === "string" && descriptor.ref
    ? "uuid"
    : compileFieldType(type, name, descriptor);
  const checks = compileChecks(name, descriptor);
  return `${qi(name)} ${sqlType}${
    descriptor.required === true ? " not null" : ""
  }${
    checks.length
      ? ` constraint ${qi(constraintName("ck", tableName, name))} check (${
        checks.join(" and ")
      })`
      : ""
  }`;
}

function compileChecks(
  name: string,
  descriptor: Record<string, unknown>,
): string[] {
  const column = qi(name);
  const checks: string[] = [];
  if (Array.isArray(descriptor.enum)) {
    checks.push(
      `${column} in (${
        descriptor.enum.map((value) => literal(String(value))).join(",")
      })`,
    );
  }
  if (typeof descriptor.minLength === "number") {
    checks.push(`char_length(${column}) >= ${descriptor.minLength}`);
  }
  if (typeof descriptor.maxLength === "number") {
    checks.push(`char_length(${column}) <= ${descriptor.maxLength}`);
  }
  if (typeof descriptor.minimum === "number") {
    checks.push(`${column} >= ${descriptor.minimum}`);
  }
  if (typeof descriptor.maximum === "number") {
    checks.push(`${column} <= ${descriptor.maximum}`);
  }
  if (typeof descriptor.minimum === "string") {
    checks.push(`${column} >= ${literal(descriptor.minimum)}`);
  }
  if (typeof descriptor.maximum === "string") {
    checks.push(`${column} <= ${literal(descriptor.maximum)}`);
  }
  return checks;
}

function constraintName(
  prefix: "ck" | "uq",
  table: string,
  field: string,
): string {
  const readable = `${table}_${field}`.slice(0, 48);
  let hash = 2166136261;
  for (const byte of new TextEncoder().encode(`${table}:${field}`)) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `${prefix}_${readable}_${hash.toString(16).padStart(8, "0")}`;
}

function compileFieldType(
  type: string,
  context: string,
  descriptor: Record<string, unknown>,
): string {
  switch (type) {
    case "string":
      return "text";
    case "integer":
      return "bigint";
    case "decimal": {
      const precision = descriptor.precision;
      const scale = descriptor.scale;
      return typeof precision === "number"
        ? `numeric(${precision},${typeof scale === "number" ? scale : 0})`
        : "numeric";
    }
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

export async function physicalTableName(
  prefix: "res" | "rel",
  publisher: string,
  pack: string,
  name: string,
): Promise<string> {
  const readable = `${prefix}_${publisher}_${pack}_${name}`.replaceAll(
    "-",
    "_",
  );
  const digest = await sha256(`${prefix}:${publisher}/${pack}:${name}`);
  const tableName = `${readable.slice(0, 46)}_${digest.slice(0, 16)}`;
  assertIdentifier(tableName, "generated table name");
  return tableName;
}

function runtimeTableUpsert(
  pack: LoadedPack,
  kind: string,
  name: string,
  table: string,
): string {
  return `insert into pack_runtime_tables(publisher,pack_name,definition_kind,definition_name,table_name) values (${
    literal(pack.publisher)
  },${literal(pack.name)},${literal(kind)},${literal(name)},${
    literal(table)
  }) on conflict (publisher,pack_name,definition_kind,definition_name) do update set table_name=excluded.table_name`;
}
function runtimeTableDelete(
  pack: LoadedPack,
  kind: string,
  name: string,
): string {
  return `delete from pack_runtime_tables where publisher=${
    literal(pack.publisher)
  } and pack_name=${literal(pack.name)} and definition_kind=${
    literal(kind)
  } and definition_name=${literal(name)}`;
}
function migrationChangeRank(change: MigrationChange): number {
  if (change.target.resource) return 0;
  if (change.target.relationship) return 1;
  return 2;
}
function localName(value: string | undefined): string | null {
  return value?.split(":").pop() ?? null;
}
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function qi(identifier: string): string {
  return quoteIdentifier(identifier);
}
function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
function assertRelationshipEndpoint(
  definition: NormalizedDefinition,
  side: "from" | "to",
) {
  const endpoint = record(definition.spec[side]);
  if (typeof endpoint.resource !== "string") {
    throw new Error(
      `${definition.path}: spec.${side}.resource must be an identity`,
    );
  }
}
function assertUniqueTableName(names: Set<string>, name: string, path: string) {
  if (names.has(name)) {
    throw new Error(`${path}: duplicate generated table ${name}`);
  }
  names.add(name);
}
function assertIdentifier(identifier: string, context: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`${context}: invalid SQL identifier '${identifier}'`);
  }
}
function createTableSql(name: string, columns: string[]) {
  return `create table ${qi(name)} (\n  ${columns.join(",\n  ")}\n)`;
}
function byName(a: NormalizedDefinition, b: NormalizedDefinition) {
  return a.name.localeCompare(b.name);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function sha256(value: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(hash)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}
