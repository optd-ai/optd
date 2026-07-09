import * as AjvModule from "npm:ajv/dist/2020.js";
import type { ErrorObject } from "npm:ajv";
import { type Static, type TSchema, Type } from "npm:@sinclair/typebox";
import { Value } from "npm:@sinclair/typebox/value";
import { Hono } from "npm:hono";

const Identifier = Type.String({ pattern: "^[a-z_][a-z0-9_]*$" });
const DottedIdentifier = Type.String({
  pattern: "^[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)?$",
});
const Alias = Type.String({ pattern: "^@[a-z_][a-z0-9_]*$" });
const Metadata = Type.Object({ name: Identifier }, {
  additionalProperties: false,
});
const FieldType = Type.Union([
  Type.Literal("string"),
  Type.Literal("integer"),
  Type.Literal("decimal"),
  Type.Literal("boolean"),
  Type.Literal("timestamp"),
]);
const FieldSpec = Type.Object({
  type: FieldType,
  required: Type.Optional(Type.Boolean()),
  ref: Type.Optional(Identifier),
}, { additionalProperties: false });
const Axi = Type.Object({}, { additionalProperties: true });

export const ResourceSchema = Type.Object({
  kind: Type.Literal("Resource"),
  apiVersion: Type.Optional(Type.String()),
  metadata: Metadata,
  spec: Type.Object({
    fields: Type.Record(Identifier, FieldSpec),
    lifecycle: Type.Optional(Type.Object({
      field: Identifier,
      states: Type.Array(Identifier),
    }, { additionalProperties: false })),
    axi: Type.Optional(Axi),
  }, { additionalProperties: false }),
}, { additionalProperties: false, $id: "Resource" });

export const HookSchema = Type.Object({
  kind: Type.Literal("Hook"),
  apiVersion: Type.Optional(Type.String()),
  metadata: Metadata,
  spec: Type.Object({
    script: Type.String({ pattern: "^[a-z_][a-z0-9_]*\\.ts$" }),
    timeout: Type.Optional(Type.String()),
    permissions: Type.Optional(Type.Object({
      net: Type.Optional(Type.Boolean()),
      read: Type.Optional(Type.Boolean()),
      write: Type.Optional(Type.Boolean()),
      env: Type.Optional(Type.Boolean()),
      run: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false })),
    secrets: Type.Optional(Type.Array(Type.Object({
      name: Identifier,
      env: Type.String({ pattern: "^[A-Z_][A-Z0-9_]*$" }),
    }, { additionalProperties: false }))),
    output: Type.Object({
      schema: Type.Union([
        Type.Literal("validation.v1"),
        Type.Literal("patch.v1"),
        Type.Literal("changeset.operations.v1"),
      ]),
    }, { additionalProperties: false }),
    attachments: Type.Optional(Type.Array(Type.Object({
      phase: Type.Union([
        Type.Literal("changeset.before_preview"),
        Type.Literal("changeset.validate"),
        Type.Literal("action.preview"),
        Type.Literal("action.commit"),
        Type.Literal("event.after_commit"),
      ]),
      resource: Type.Optional(DottedIdentifier),
      action: Type.Optional(DottedIdentifier),
      event: Type.Optional(Type.String()),
      order: Type.Optional(Type.Integer()),
      condition: Type.Optional(Type.String()),
      input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }, { additionalProperties: false }))),
    axi: Type.Optional(Axi),
  }, { additionalProperties: false }),
}, { additionalProperties: false, $id: "Hook" });

export const PolicySchema = Type.Object({
  kind: Type.Literal("Policy"),
  apiVersion: Type.Optional(Type.String()),
  metadata: Metadata,
  spec: Type.Object({
    rules: Type.Array(Type.Object({
      name: Identifier,
      effect: Type.Literal("allow"),
      roles: Type.Array(Type.String()),
      actions: Type.Array(Type.String()),
      resources: Type.Array(Type.String()),
      where: Type.Optional(Type.String()),
      relation: Type.Optional(Type.Object({
        relationship: DottedIdentifier,
        objectSide: Type.Union([Type.Literal("from"), Type.Literal("to")]),
        subjectResource: DottedIdentifier,
        subjectIdsFromActor: Identifier,
      }, { additionalProperties: false })),
    }, { additionalProperties: false })),
  }, { additionalProperties: false }),
}, { additionalProperties: false, $id: "Policy" });

export const PackSchema = Type.Object({
  kind: Type.Literal("Pack"),
  apiVersion: Type.Optional(Type.String()),
  metadata: Type.Object({
    namespace: Identifier,
    name: Identifier,
    version: Type.String(),
  }, { additionalProperties: false }),
  spec: Type.Object({
    purpose: Type.Optional(Type.String()),
    axi: Type.Optional(Axi),
  }, { additionalProperties: false }),
}, { additionalProperties: false, $id: "Pack" });

const ActorSchema = Type.Object({
  id: Type.String(),
  roles: Type.Array(Type.String()),
  sales_team_ids: Type.Optional(Type.Array(Type.String())),
  company_ids: Type.Optional(Type.Array(Type.String())),
}, { additionalProperties: false });
const BaseOperation = {
  as: Type.Optional(Identifier),
};
const CreateOperation = Type.Object({
  ...BaseOperation,
  op: Type.Literal("create"),
  resource: DottedIdentifier,
  id: Type.Optional(Type.String()),
  fields: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
const UpdateOperation = Type.Object({
  op: Type.Literal("update"),
  resource: DottedIdentifier,
  id: Type.String(),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  fields: Type.Record(Type.String(), Type.Unknown()),
}, { additionalProperties: false });
const ArchiveOperation = Type.Object({
  op: Type.Literal("archive"),
  resource: DottedIdentifier,
  id: Type.String(),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const TransitionOperation = Type.Object({
  op: Type.Literal("transition"),
  resource: DottedIdentifier,
  id: Type.String(),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  to: Identifier,
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
const LinkOperation = Type.Object({
  ...BaseOperation,
  op: Type.Literal("link"),
  relationship: DottedIdentifier,
  from: Type.Union([Type.String(), Alias]),
  to: Type.Union([Type.String(), Alias]),
  fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false });
const UnlinkOperation = Type.Object({
  op: Type.Literal("unlink"),
  relationship: DottedIdentifier,
  id: Type.String(),
  expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
const CommentOperation = Type.Object({
  op: Type.Literal("comment"),
  resource: DottedIdentifier,
  id: Type.String(),
  body: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const OperationSchema = Type.Union([
  CreateOperation,
  UpdateOperation,
  ArchiveOperation,
  TransitionOperation,
  LinkOperation,
  UnlinkOperation,
  CommentOperation,
], { $id: "ChangesetOperation" });
export const ChangesetPreviewRequestSchema = Type.Object({
  apiVersion: Type.Literal("operant.dev/v1"),
  actor: ActorSchema,
  idempotencyKey: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  operations: Type.Array(OperationSchema, { minItems: 1 }),
}, { additionalProperties: false, $id: "ChangesetPreviewRequest" });
export const ChangesetCommitRequestSchema = Type.Union([
  Type.Object({
    apiVersion: Type.Literal("operant.dev/v1"),
    actor: ActorSchema,
    idempotencyKey: Type.String(),
    previewId: Type.String(),
  }, { additionalProperties: false }),
  Type.Object({
    apiVersion: Type.Literal("operant.dev/v1"),
    actor: ActorSchema,
    idempotencyKey: Type.String(),
    reason: Type.Optional(Type.String()),
    operations: Type.Array(OperationSchema, { minItems: 1 }),
  }, { additionalProperties: false }),
], { $id: "ChangesetCommitRequest" });

export const HookEnvelopeSchema = Type.Object({
  hook: Identifier,
  phase: Type.String(),
  input: Type.Record(Type.String(), Type.Unknown()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
}, { additionalProperties: false, $id: "HookEnvelope" });
export const ValidationOutputSchema = Type.Object({
  allow: Type.Optional(Type.Boolean()),
  errors: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    code: Type.String(),
    message: Type.String(),
  }, { additionalProperties: false }))),
  warnings: Type.Optional(Type.Array(Type.Object({
    path: Type.String(),
    code: Type.String(),
    message: Type.String(),
  }, { additionalProperties: false }))),
}, { additionalProperties: false, $id: "ValidationOutput" });
export const PatchOutputSchema = Type.Object({
  patches: Type.Array(Type.Object({
    op: Type.Union([Type.Literal("set"), Type.Literal("unset")]),
    path: Type.String(),
    value: Type.Optional(Type.Unknown()),
  }, { additionalProperties: false })),
}, { additionalProperties: false, $id: "PatchOutput" });
export const ChangesetOperationsOutputSchema = Type.Object({
  summary: Type.Optional(Type.String()),
  operations: Type.Array(OperationSchema),
}, { additionalProperties: false, $id: "ChangesetOperationsOutput" });

export type ChangesetPreviewRequest = Static<
  typeof ChangesetPreviewRequestSchema
>;

const AjvCtor = (AjvModule as any).default ?? AjvModule;
const ajv = new AjvCtor({
  allErrors: true,
  strict: true,
  allowUnionTypes: true,
});

export function validateWithSchema(
  schema: TSchema,
  value: unknown,
  source = "body",
) {
  const validate = ajv.compile(schema);
  if (validate(value)) return { ok: true as const, value };
  return {
    ok: false as const,
    errors: normalizeAjvErrors(validate.errors ?? [], source),
  };
}

export function validatePackFile(path: string, value: unknown) {
  const schema = path === "pack.yaml"
    ? PackSchema
    : path.startsWith("resources/")
    ? ResourceSchema
    : path.startsWith("hooks/")
    ? HookSchema
    : path.startsWith("policies/")
    ? PolicySchema
    : undefined;
  if (!schema) {
    return {
      ok: false as const,
      errors: [{
        code: "unknown_pack_file",
        path,
        message: "unsupported pack file for spike",
      }],
    };
  }
  const result = validateWithSchema(schema, value, path);
  if (!result.ok) return result;
  const metadataName = (value as any).metadata?.name;
  const basename = path.split("/").pop()!.replace(/\.yaml$/, "");
  if (path !== "pack.yaml" && metadataName !== basename) {
    return {
      ok: false as const,
      errors: [{
        code: "metadata_name_mismatch",
        path: `${path}/metadata/name`,
        message: `metadata.name must match file basename ${basename}`,
      }],
    };
  }
  return result;
}

export function metadataForResource(resource: Static<typeof ResourceSchema>) {
  return {
    name: resource.metadata.name,
    fields: Object.fromEntries(
      Object.entries(resource.spec.fields).map(([name, field]) => [name, {
        type: field.type,
        required: Boolean(field.required),
        ref: field.ref,
      }]),
    ),
    axi: resource.spec.axi ?? {},
  };
}

export function makeOpenApiSketch() {
  return {
    openapi: "3.1.0",
    info: { title: "Operant TypeBox Spike", version: "0.0.0" },
    paths: {
      "/changesets/preview": {
        post: {
          requestBody: {
            content: {
              "application/json": { schema: ChangesetPreviewRequestSchema },
            },
          },
          responses: { "200": { description: "preview" } },
        },
      },
    },
    components: {
      schemas: {
        ChangesetPreviewRequest: ChangesetPreviewRequestSchema,
        ChangesetOperation: OperationSchema,
        Resource: ResourceSchema,
      },
    },
  };
}

export function createTypeBoxHonoApp() {
  const app = new Hono();
  app.post("/changesets/preview", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({
        ok: false,
        error: {
          code: "invalid_json",
          message: "request body must be JSON",
          details: {},
        },
      }, 400);
    }
    const validation = validateWithSchema(
      ChangesetPreviewRequestSchema,
      body,
      "body",
    );
    if (!validation.ok) {
      return c.json({
        ok: false,
        error: {
          code: "schema_validation_failed",
          message: "request failed schema validation",
          details: { errors: validation.errors },
        },
      }, 400);
    }
    return c.json({
      ok: true,
      operationCount: (body as ChangesetPreviewRequest).operations.length,
    });
  });
  app.get("/metadata/resources/:name", (c) => {
    const sample = Value.Create(ResourceSchema) as Static<
      typeof ResourceSchema
    >;
    sample.metadata.name = c.req.param("name");
    sample.spec.fields = {
      name: { type: "string", required: true },
      email: { type: "string" },
    };
    return c.json({ ok: true, resource: metadataForResource(sample) });
  });
  return app;
}

function normalizeAjvErrors(errors: ErrorObject[], source: string) {
  return errors.map((error) => ({
    code: "schema_validation_failed",
    path: `${source}${error.instancePath}`,
    message: humanMessage(error),
    details: { keyword: error.keyword, params: error.params },
  }));
}

function humanMessage(error: ErrorObject) {
  if (error.keyword === "additionalProperties") {
    return `unexpected property ${(error.params as any).additionalProperty}`;
  }
  if (error.keyword === "required") {
    return `missing required property ${(error.params as any).missingProperty}`;
  }
  return error.message ?? "schema validation failed";
}
