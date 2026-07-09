import { assertEquals } from "jsr:@std/assert";
import {
  ChangesetCommitRequestSchema,
  ChangesetOperationsOutputSchema,
  ChangesetPreviewRequestSchema,
  createTypeBoxHonoApp,
  HookEnvelopeSchema,
  makeOpenApiSketch,
  metadataForResource,
  PatchOutputSchema,
  ResourceSchema,
  validatePackFile,
  validateWithSchema,
  ValidationOutputSchema,
} from "./typebox-spike.ts";

Deno.test("pack schema validates resources and returns stable file/path errors", () => {
  const good = {
    kind: "Resource",
    metadata: { name: "lead" },
    spec: {
      fields: {
        name: { type: "string", required: true },
        score: { type: "integer" },
      },
    },
  };
  const result = validatePackFile("resources/lead.yaml", good);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));

  const bad = {
    kind: "Resource",
    metadata: { name: "lead" },
    spec: { fields: { email: { type: "email" } }, extra: true },
  };
  const invalid = validatePackFile("resources/contact.yaml", bad);
  if (invalid.ok) throw new Error("expected invalid resource");
  if (!invalid.errors.some((e) => e.path.includes("/spec/fields/email/type"))) {
    throw new Error(JSON.stringify(invalid.errors));
  }
});

Deno.test("pack schema catches metadata filename mismatches", () => {
  const result = validatePackFile("resources/contact.yaml", {
    kind: "Resource",
    metadata: { name: "lead" },
    spec: { fields: { name: { type: "string" } } },
  });
  if (result.ok) throw new Error("expected mismatch failure");
  assertEquals(result.errors[0].code, "metadata_name_mismatch");
});

Deno.test("changeset schema validates discriminated v0 operation shapes", () => {
  const good = {
    apiVersion: "operant.dev/v1",
    actor: { id: "agent", roles: ["sales_rep"] },
    operations: [
      {
        op: "create",
        resource: "default.lead",
        as: "lead",
        fields: { name: "Ada" },
      },
      {
        op: "transition",
        resource: "default.lead",
        id: "lead_1",
        expectedVersion: 1,
        to: "qualified",
      },
      {
        op: "link",
        relationship: "default.contact_company",
        from: "@contact",
        to: "@company",
      },
      {
        op: "comment",
        resource: "default.lead",
        id: "lead_1",
        body: "Called customer",
      },
    ],
  };
  if (!validateWithSchema(ChangesetPreviewRequestSchema, good).ok) {
    throw new Error("expected good changeset");
  }

  const bad = {
    ...good,
    operations: [{ op: "update", resource: "default.lead", id: "lead_1" }],
  };
  const invalid = validateWithSchema(
    ChangesetPreviewRequestSchema,
    bad,
    "body",
  );
  if (invalid.ok) throw new Error("expected invalid changeset");
  if (!invalid.errors.some((e) => e.message.includes("must match a schema"))) {
    throw new Error(JSON.stringify(invalid.errors));
  }
});

Deno.test("commit schema supports persisted preview or direct operations with idempotency", () => {
  const byPreview = {
    apiVersion: "operant.dev/v1",
    actor: { id: "agent", roles: [] },
    idempotencyKey: "k1",
    previewId: "csp_1",
  };
  const direct = {
    apiVersion: "operant.dev/v1",
    actor: { id: "agent", roles: [] },
    idempotencyKey: "k2",
    operations: [{
      op: "archive",
      resource: "default.lead",
      id: "lead_1",
      expectedVersion: 1,
    }],
  };
  if (!validateWithSchema(ChangesetCommitRequestSchema, byPreview).ok) {
    throw new Error("preview commit invalid");
  }
  if (!validateWithSchema(ChangesetCommitRequestSchema, direct).ok) {
    throw new Error("direct commit invalid");
  }
});

Deno.test("hook envelope and output schemas validate versioned hook contracts", () => {
  if (
    !validateWithSchema(HookEnvelopeSchema, {
      hook: "validate_lead",
      phase: "changeset.validate",
      input: {},
    }).ok
  ) throw new Error("bad envelope");
  if (
    !validateWithSchema(ValidationOutputSchema, {
      allow: false,
      errors: [{ path: "/email", code: "format", message: "bad" }],
    }).ok
  ) throw new Error("bad validation output");
  if (
    !validateWithSchema(PatchOutputSchema, {
      patches: [{ op: "set", path: "/fields/email", value: "a@example.com" }],
    }).ok
  ) throw new Error("bad patch output");
  if (
    !validateWithSchema(ChangesetOperationsOutputSchema, {
      operations: [{ op: "create", resource: "default.lead", fields: {} }],
    }).ok
  ) throw new Error("bad operations output");

  const bad = validateWithSchema(PatchOutputSchema, {
    patches: [{ op: "replace", path: "/x" }],
  });
  if (bad.ok) throw new Error("expected invalid patch op");
});

Deno.test("metadata can be derived from TypeBox-backed resource schemas", () => {
  const resource = {
    kind: "Resource",
    metadata: { name: "lead" },
    spec: {
      fields: {
        name: { type: "string", required: true },
        email: { type: "string" },
      },
      axi: { list: { fields: ["id", "name"] } },
    },
  };
  const validation = validateWithSchema(ResourceSchema, resource);
  if (!validation.ok) throw new Error(JSON.stringify(validation.errors));
  const metadata = metadataForResource(resource as any);
  assertEquals(metadata.fields.name.required, true);
  assertEquals(metadata.fields.email.type, "string");
  assertEquals((metadata.axi as any).list.fields[1], "name");
});

Deno.test("Hono boundary validates request body and returns stable errors", async () => {
  const app = createTypeBoxHonoApp();
  const bad = await app.request("/changesets/preview", {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "operant.dev/v1",
      actor: { id: "a", roles: [] },
      operations: [],
    }),
  });
  assertEquals(bad.status, 400);
  const badJson = await bad.json();
  assertEquals(badJson.error.code, "schema_validation_failed");

  const good = await app.request("/changesets/preview", {
    method: "POST",
    body: JSON.stringify({
      apiVersion: "operant.dev/v1",
      actor: { id: "a", roles: [] },
      operations: [{ op: "create", resource: "default.lead", fields: {} }],
    }),
  });
  assertEquals(good.status, 200);
  assertEquals((await good.json()).operationCount, 1);
});

Deno.test("OpenAPI sketch can reuse TypeBox JSON schemas later", () => {
  const doc = makeOpenApiSketch();
  assertEquals(doc.openapi, "3.1.0");
  if (!doc.components.schemas.ChangesetPreviewRequest.properties.operations) {
    throw new Error("missing operations schema");
  }
});
