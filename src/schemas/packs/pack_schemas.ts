import * as AjvModule from "npm:ajv/dist/2020.js";
import type { ErrorObject } from "npm:ajv";
import { Type } from "npm:@sinclair/typebox@0.34.38";

const Identifier = Type.String({ pattern: "^[a-z_][a-z0-9_]*$" });
const DottedIdentifier = Type.String({
  pattern: "^[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)?$",
});
const ApiVersion = Type.Literal("operant.dev/v1");
const Metadata = Type.Object({
  namespace: Type.Optional(Identifier),
  name: Identifier,
  version: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
const Axi = Type.Optional(Type.Record(Type.String(), Type.Unknown()));

const Field = Type.Object({
  type: Type.String({ minLength: 1 }),
  required: Type.Optional(Type.Boolean()),
  ref: Type.Optional(DottedIdentifier),
  enum: Type.Optional(Type.Array(Type.String())),
  default: Type.Optional(Type.Unknown()),
  unique: Type.Optional(Type.Boolean()),
  indexed: Type.Optional(Type.Boolean()),
  description: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const PackSchema = Type.Object({
  kind: Type.Literal("Pack"),
  apiVersion: ApiVersion,
  metadata: Type.Object({
    namespace: Identifier,
    name: Identifier,
    version: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  spec: Type.Object({
    purpose: Type.Optional(Type.String()),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const ResourceSchema = Type.Object({
  kind: Type.Literal("Resource"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    label: Type.Optional(Type.String()),
    fields: Type.Record(Identifier, Field),
    lifecycle: Type.Optional(Type.Unknown()),
    hooks: Type.Optional(Type.Unknown()),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const RelationshipSchema = Type.Object({
  kind: Type.Literal("Relationship"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    from: Type.Unknown(),
    to: Type.Unknown(),
    cardinality: Type.Optional(Type.String()),
    fields: Type.Optional(Type.Record(Identifier, Field)),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const LifecycleSchema = Type.Object({
  kind: Type.Literal("Lifecycle"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    states: Type.Array(Type.Unknown()),
    transitions: Type.Optional(Type.Array(Type.Unknown())),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const ActionSchema = Type.Object({
  kind: Type.Literal("Action"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    description: Type.Optional(Type.String()),
    input: Type.Optional(Type.Unknown()),
    hook: Type.Optional(DottedIdentifier),
    hooks: Type.Optional(Type.Unknown()),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const HookSchema = Type.Object({
  kind: Type.Literal("Hook"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    script: Type.String({ pattern: "^[a-z_][a-z0-9_]*\\.ts$" }),
    timeout: Type.Optional(Type.String()),
    permissions: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    input: Type.Optional(Type.Unknown()),
    output: Type.Optional(Type.Unknown()),
    secrets: Type.Optional(Type.Array(Type.Unknown())),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const PolicySchema = Type.Object({
  kind: Type.Literal("Policy"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    rules: Type.Array(Type.Unknown()),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const SeedSchema = Type.Object({
  kind: Type.Literal("Seed"),
  apiVersion: ApiVersion,
  metadata: Metadata,
  spec: Type.Object({
    resource: DottedIdentifier,
    key: Identifier,
    rows: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    axi: Axi,
  }, { additionalProperties: true }),
}, { additionalProperties: false });

export const schemaByKind = {
  Pack: PackSchema,
  Resource: ResourceSchema,
  Relationship: RelationshipSchema,
  Lifecycle: LifecycleSchema,
  Action: ActionSchema,
  Hook: HookSchema,
  Policy: PolicySchema,
  Seed: SeedSchema,
} as const;

export type PackKind = keyof typeof schemaByKind;

export type ValidationIssue = {
  path: string;
  message: string;
};

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
const ajv = new AjvCtor({ allErrors: true, strict: false });

const validators = Object.fromEntries(
  Object.entries(schemaByKind).map((
    [kind, schema],
  ) => [kind, ajv.compile(schema)]),
) as Record<PackKind, ValidateFn>;

export function validatePackDocument(
  kind: PackKind,
  value: unknown,
): ValidationIssue[] {
  const valid = validators[kind](value);
  if (valid) return [];
  return (validators[kind].errors ?? []).map((error: ErrorObject) => ({
    path: error.instancePath || "/",
    message: error.message ?? "schema validation failed",
  }));
}
