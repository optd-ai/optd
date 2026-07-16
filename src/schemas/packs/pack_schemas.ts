import * as AjvModule from "npm:ajv/dist/2020.js";
import type { ErrorObject } from "npm:ajv";
import { Type } from "npm:@sinclair/typebox@0.34.38";

const Name = Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}$" });
const Publisher = Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" });
const Identity = Type.String({
  pattern:
    "^(?:[a-z][a-z0-9-]{0,62}/[a-z][a-z0-9_]{0,62}:)?[a-z][a-z0-9_]{0,62}$",
});
const ApiVersion = Type.Literal("operant.dev/v1");
const ChildMetadata = Type.Object({ name: Name }, {
  additionalProperties: false,
});
const Axi = Type.Unknown();
const StringArray = Type.Array(Type.String({ minLength: 1 }), {
  uniqueItems: true,
});

const CommonField = {
  required: Type.Optional(Type.Boolean()),
  unique: Type.Optional(Type.Boolean()),
};
const Field = Type.Union([
  Type.Object({
    type: Type.Literal("string"),
    ...CommonField,
    enum: Type.Optional(
      Type.Array(Type.String(), { minItems: 1, uniqueItems: true }),
    ),
    minLength: Type.Optional(Type.Integer({ minimum: 0 })),
    maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
    format: Type.Optional(
      Type.Union([
        Type.Literal("email"),
        Type.Literal("uri"),
        Type.Literal("uuid"),
      ]),
    ),
    ref: Type.Optional(Identity),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("integer"),
    ...CommonField,
    minimum: Type.Optional(Type.Integer()),
    maximum: Type.Optional(Type.Integer()),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("decimal"),
    ...CommonField,
    minimum: Type.Optional(
      Type.String({ pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" }),
    ),
    maximum: Type.Optional(
      Type.String({ pattern: "^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]+)?$" }),
    ),
    precision: Type.Optional(Type.Integer({ minimum: 1 })),
    scale: Type.Optional(Type.Integer({ minimum: 0 })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("boolean"),
    required: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("date"),
    ...CommonField,
    minimum: Type.Optional(Type.String({ format: "date" })),
    maximum: Type.Optional(Type.String({ format: "date" })),
  }, { additionalProperties: false }),
  Type.Object({
    type: Type.Literal("timestamp"),
    ...CommonField,
    minimum: Type.Optional(Type.String({ format: "date-time" })),
    maximum: Type.Optional(Type.String({ format: "date-time" })),
  }, { additionalProperties: false }),
]);
const Fields = Type.Record(Name, Field);
const Base = { apiVersion: ApiVersion, metadata: ChildMetadata };

const Constraint = Type.Union([
  Type.Object({
    name: Name,
    kind: Type.Literal("unique"),
    fields: Type.Array(Name, { minItems: 1, uniqueItems: true }),
    where: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    name: Name,
    kind: Type.Literal("check"),
    expression: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    name: Name,
    kind: Type.Literal("foreign_key"),
    fields: Type.Array(Name, { minItems: 1, uniqueItems: true }),
    target: Type.Object({
      resource: Identity,
      fields: Type.Array(Name, { minItems: 1, uniqueItems: true }),
    }, { additionalProperties: false }),
    onDelete: Type.Literal("restrict"),
  }, { additionalProperties: false }),
]);

export const PackSchema = Type.Object({
  kind: Type.Literal("Pack"),
  apiVersion: ApiVersion,
  metadata: Type.Object({
    publisher: Publisher,
    name: Name,
    version: Type.String({
      pattern:
        "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    }),
  }, { additionalProperties: false }),
  spec: Type.Object({
    purpose: Type.String({ minLength: 1, maxLength: 4096 }),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const ResourceSchema = Type.Object({
  kind: Type.Literal("Resource"),
  ...Base,
  spec: Type.Object({
    fields: Type.Intersect([Fields, Type.Object({}, { minProperties: 1 })]),
    constraints: Type.Optional(Type.Array(Constraint)),
    indexes: Type.Optional(
      Type.Array(
        Type.Object({
          name: Name,
          fields: Type.Array(Name, { minItems: 1, uniqueItems: true }),
          where: Type.Optional(Type.String({ minLength: 1 })),
        }, { additionalProperties: false }),
      ),
    ),
    search: Type.Optional(
      Type.Object({
        fields: Type.Array(Name, { minItems: 1, uniqueItems: true }),
      }, { additionalProperties: false }),
    ),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const RelationshipSchema = Type.Object({
  kind: Type.Literal("Relationship"),
  ...Base,
  spec: Type.Object({
    from: Type.Object({
      resource: Type.Union([Identity, Type.Literal("system:principal")]),
    }, { additionalProperties: false }),
    to: Type.Object({
      resource: Type.Union([Identity, Type.Literal("system:principal")]),
    }, { additionalProperties: false }),
    fields: Type.Optional(Fields),
    unique: Type.Optional(
      Type.Array(
        Type.String({ pattern: "^(?:from|to|[a-z][a-z0-9_]{0,62})$" }),
        { minItems: 1, uniqueItems: true },
      ),
    ),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const State = Type.Object({
  name: Name,
  terminal: Type.Optional(Type.Boolean()),
  required_fields: Type.Optional(Type.Array(Name, { uniqueItems: true })),
}, { additionalProperties: false });
const Transition = Type.Object({
  name: Name,
  from: Type.Array(Name, { minItems: 1, uniqueItems: true }),
  to: Name,
  condition: Type.Optional(Type.String({ minLength: 1 })),
  set: Type.Optional(
    Type.Record(
      Name,
      Type.Union([Type.String(), Type.Number(), Type.Boolean()]),
    ),
  ),
  unset: Type.Optional(Type.Array(Name, { uniqueItems: true })),
}, { additionalProperties: false });
export const LifecycleSchema = Type.Object({
  kind: Type.Literal("Lifecycle"),
  ...Base,
  spec: Type.Object({
    resource: Identity,
    field: Name,
    initial: Name,
    states: Type.Array(State, { minItems: 2 }),
    transitions: Type.Array(Transition),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const Read = Type.Object({
  resource: Identity,
  id_from: Type.String({ pattern: "^input\\.[a-z][a-z0-9_]{0,62}$" }),
  required: Type.Boolean(),
}, { additionalProperties: false });
export const ActionSchema = Type.Object({
  kind: Type.Literal("Action"),
  ...Base,
  spec: Type.Object({
    input: Type.Optional(Fields),
    reads: Type.Optional(Type.Record(Name, Read)),
    availability: Type.Optional(
      Type.Object({
        resource: Identity,
        states: Type.Optional(
          Type.Array(Name, { minItems: 1, uniqueItems: true }),
        ),
        condition: Type.Optional(Type.String({ minLength: 1 })),
      }, { additionalProperties: false }),
    ),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const PermissionNames = Type.Array(
  Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
  { minItems: 1, uniqueItems: true },
);
const OperationEffect = Type.Object({
  resource: Identity,
  ops: Type.Array(
    Type.Union([
      Type.Literal("create"),
      Type.Literal("update"),
      Type.Literal("transition"),
      Type.Literal("archive"),
      Type.Literal("link"),
      Type.Literal("unlink"),
      Type.Literal("comment"),
    ]),
    { minItems: 1, uniqueItems: true },
  ),
}, { additionalProperties: false });
const Attachment = Type.Object({
  phase: Type.Union([
    Type.Literal("changeset.before_stage"),
    Type.Literal("action.stage"),
    Type.Literal("changeset.validate"),
    Type.Literal("event.after_commit"),
  ]),
  resource: Type.Optional(Identity),
  action: Type.Optional(Identity),
  event: Type.Optional(Type.String({ minLength: 1 })),
  order: Type.Optional(Type.Integer()),
  condition: Type.Optional(Type.String({ minLength: 1 })),
  input: Type.Record(Name, Type.Unknown()),
}, { additionalProperties: false });
export const HookSchema = Type.Object({
  kind: Type.Literal("Hook"),
  ...Base,
  spec: Type.Object({
    script: Type.String({ pattern: "^[a-z][a-z0-9_]{0,62}\\.ts$" }),
    timeout: Type.Optional(Type.String({ pattern: "^[1-9][0-9]*(?:ms|s|m)$" })),
    permissions: Type.Object({
      net: Type.Union([Type.Literal(false), StringArray]),
      env: Type.Union([Type.Literal(false), PermissionNames]),
      read: Type.Literal(false),
      write: Type.Literal(false),
      run: Type.Literal(false),
    }, { additionalProperties: false }),
    secrets: Type.Array(
      Type.Object({
        slot: Name,
        env: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
      }, { additionalProperties: false }),
    ),
    effects: Type.Object({ operations: Type.Array(OperationEffect) }, {
      additionalProperties: false,
    }),
    output: Type.Object({
      schema: Type.Union([
        Type.Literal("validation.v1"),
        Type.Literal("patch.v1"),
        Type.Literal("changeset.operations.v1"),
        Type.Literal("delivery.v1"),
      ]),
    }, { additionalProperties: false }),
    attachments: Type.Array(Attachment, { minItems: 1 }),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

const PolicyRule = Type.Object({
  name: Name,
  effect: Type.Literal("allow"),
  roles: Type.Array(Identity, { minItems: 1, uniqueItems: true }),
  actions: StringArray,
  resources: Type.Array(Identity, { minItems: 1, uniqueItems: true }),
  where: Type.Optional(Type.String({ minLength: 1 })),
  relation: Type.Optional(Type.Object({
    relationship: Identity,
    object_side: Type.Union([Type.Literal("from"), Type.Literal("to")]),
    subject_side: Type.Union([Type.Literal("from"), Type.Literal("to")]),
    subject: Type.Union([
      Type.Literal("actor.id"),
      Type.Literal("actor.human_user_id"),
    ]),
  }, { additionalProperties: false })),
  axi: Type.Optional(
    Type.Object({ summary: Type.String({ minLength: 1 }) }, {
      additionalProperties: false,
    }),
  ),
}, { additionalProperties: false });
export const PolicySchema = Type.Object({
  kind: Type.Literal("Policy"),
  ...Base,
  spec: Type.Object({
    default_assignment: Type.Union([
      Type.Literal("none"),
      Type.Literal("all_projects"),
    ]),
    rules: Type.Array(PolicyRule, { minItems: 1 }),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const RoleSchema = Type.Object({
  kind: Type.Literal("Role"),
  ...Base,
  spec: Type.Object({
    display_name: Type.String({ minLength: 1 }),
    description: Type.String({ minLength: 1 }),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const SeedSchema = Type.Object({
  kind: Type.Literal("Seed"),
  ...Base,
  spec: Type.Object({
    resource: Identity,
    key: Name,
    mode: Type.Literal("changeset"),
    rows: Type.Array(
      Type.Record(
        Name,
        Type.Union([Type.String(), Type.Integer(), Type.Boolean()]),
      ),
      { minItems: 1 },
    ),
    axi: Axi,
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export const schemaByKind = {
  Pack: PackSchema,
  Resource: ResourceSchema,
  Relationship: RelationshipSchema,
  Lifecycle: LifecycleSchema,
  Action: ActionSchema,
  Hook: HookSchema,
  Role: RoleSchema,
  Policy: PolicySchema,
  Seed: SeedSchema,
} as const;
export type PackKind = keyof typeof schemaByKind;
export type ValidationIssue = { path: string; message: string };
const AjvCtor = (AjvModule as unknown as {
  default?: new (
    opts: Record<string, unknown>,
  ) => { compile: (schema: unknown) => ValidateFn };
}).default ??
  (AjvModule as unknown as new (
    opts: Record<string, unknown>,
  ) => { compile: (schema: unknown) => ValidateFn });
type ValidateFn = ((value: unknown) => boolean) & {
  errors?: ErrorObject[] | null;
};
const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  validateFormats: false,
});
const validators = Object.fromEntries(
  Object.entries(schemaByKind).map((
    [kind, schema],
  ) => [kind, ajv.compile(schema)]),
) as Record<PackKind, ValidateFn>;
export function validatePackDocument(
  kind: PackKind,
  value: unknown,
): ValidationIssue[] {
  if (validators[kind](value)) return [];
  return (validators[kind].errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    message: error.message ?? "schema validation failed",
  }));
}
