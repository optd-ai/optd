import { assertEquals, assertMatch } from "@std/assert";
import { loadPackFromFiles } from "../../src/adapters/outbound/yaml/pack_loader.ts";
import { buildMigrationPlan } from "../../src/domain/migrations/pack_migration.ts";
import { uuidV7 } from "../../src/domain/ids/uuid_v7.ts";
import { compileMigrationPreview } from "../../src/adapters/outbound/postgres/resource_ddl.ts";

const root = `kind: Pack
apiVersion: optd.dev/v1
metadata: { publisher: optd, name: test, version: 0.2.0 }
spec:
  purpose: Migration test.
  axi:
    purpose: Validate migration planning.
    home:
      resources: [optd/test:lead]
      help: [optctl metadata pack optd/test]
`;
const resource = `kind: Resource
apiVersion: optd.dev/v1
metadata: { name: lead }
spec:
  fields:
    name: { type: string, required: true }
    email: { type: string }
    status: { type: string }
  axi:
    purpose: Validate migration resources.
    whenToUse: [Use optd/test:lead for migration tests.]
    identity: { title: "\${name}" }
    list:
      defaultFields: [name, email, status]
      empty:
        message: No test resources found.
        help: [optctl query optd/test:lead]
    detail:
      help: ['optctl view optd/test:lead \${id}']
    help:
      list: [optctl query optd/test:lead]
      view: ['optctl view optd/test:lead \${id}']
      created: ['optctl view optd/test:lead \${id}']
`;

Deno.test("migration plans use frozen durable shape for first install", async () => {
  const candidate = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: resource },
  ]);
  const { plan } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: uuidV7(),
    authContextId: uuidV7(),
    active: null,
    candidate,
    liveFacts: { resourceRows: {}, fieldPresentValues: {} },
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
  assertEquals(plan.schema_version, "migration.plan.v1");
  assertEquals(plan.publisher, "optd");
  assertEquals(plan.pack, "test");
  assertEquals(plan.from_pack_revision_id, null);
  assertEquals(plan.class, "safe");
  assertEquals(plan.status, "ready");
  assertEquals(plan.summary.safe, 1);
  const compiled = await compileMigrationPreview(candidate, plan);
  assertEquals(compiled.statements.length, 3);
  assertMatch(
    compiled.statements[0],
    /^create table "res_optd_test_lead_[0-9a-f]{16}"/,
  );
  assertMatch(compiled.statements[1], /^insert into pack_runtime_tables/);
  assertMatch(compiled.statements[2], /^insert into pack_active_revisions/);
  assertEquals(
    compiled.statements.some((statement) =>
      statement.trimStart().startsWith("--")
    ),
    false,
  );
  assertEquals(compiled.steps.length, 2);
  assertEquals(
    compiled.dependency_graph.topological_order,
    compiled.steps.map((step) => step.id),
  );
  assertEquals(compiled.dependency_graph.edges.length, 1);
  assertMatch(plan.plan_digest, /^sha256:[0-9a-f]{64}$/);
  assertMatch(plan.live_facts_digest, /^sha256:[0-9a-f]{64}$/);
});

Deno.test("relationship replacements are destructive reviewed DDL with activation dependencies", async () => {
  const relationship = (withWeight: boolean) =>
    `kind: Relationship\napiVersion: optd.dev/v1\nmetadata: {name: lead_company}\nspec:\n  from: {resource: lead}\n  to: {resource: company}\n  fields:\n    role: {type: string}\n${
      withWeight ? "    weight: {type: integer}\n" : ""
    }  unique: [from, to]\n  axi: {}\n`;
  const company = resource.replace("name: lead", "name: company");
  const active = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: resource },
    { path: "resources/company.yaml", text: company },
    { path: "relationships/lead_company.yaml", text: relationship(false) },
  ]);
  const candidate = await loadPackFromFiles([
    { path: "pack.yaml", text: root.replace("0.2.0", "0.3.0") },
    { path: "resources/lead.yaml", text: resource },
    { path: "resources/company.yaml", text: company },
    { path: "relationships/lead_company.yaml", text: relationship(true) },
  ]);
  const { plan } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: uuidV7(),
    authContextId: uuidV7(),
    active: { revisionId: uuidV7(), normalized: active.normalized },
    candidate,
    liveFacts: { resourceRows: {}, fieldPresentValues: {} },
  });
  const change = plan.changes.find((item) =>
    item.kind === "change_relationship"
  )!;
  assertEquals(change.class, "destructive");
  assertEquals(change.status, "blocked");
  assertEquals(change.hazard_codes, [
    "DATA_LOSS",
    "API_BREAK",
    "TABLE_REWRITE",
    "EXCLUSIVE_LOCK",
  ]);
  const compiled = await compileMigrationPreview(candidate, plan);
  assertMatch(compiled.statements[0], /^drop table \"rel_/);
  assertMatch(compiled.statements[1], /^create table \"rel_/);
  assertEquals(compiled.dependency_graph.edges.length, 1);
});

Deno.test("full seed uniqueness converts to a named active index before activation", async () => {
  const candidateResource = resource.replace(
    "  axi:\n",
    "  constraints:\n    - { name: lead_active_name, kind: unique, fields: [name], where: 'active()' }\n  axi:\n",
  );
  const candidate = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: candidateResource },
  ]);
  const activeDocument = structuredClone(
    candidate.resources.lead.document,
  ) as Record<string, unknown>;
  const activeSpec = activeDocument.spec as Record<string, unknown>;
  delete activeSpec.constraints;
  ((activeSpec.fields as Record<string, unknown>).name as Record<
    string,
    unknown
  >).unique = true;
  const { plan } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: uuidV7(),
    authContextId: uuidV7(),
    active: {
      revisionId: uuidV7(),
      normalized: { resources: { lead: activeDocument } },
    },
    candidate,
    liveFacts: {
      resourceRows: { lead: 4 },
      fieldPresentValues: { "lead.name": 4 },
    },
  });
  assertEquals(
    plan.changes.map((change) => change.kind),
    ["add_resource_constraint", "change_field"],
  );
  const constraintChange = plan.changes[0];
  assertEquals(constraintChange.facts.fields, ["name"]);
  assertEquals(constraintChange.facts.predicate, "active()");
  assertEquals(constraintChange.hazard_codes, [
    "VALIDATION_SCAN",
    "EXCLUSIVE_LOCK",
  ]);
  const compiled = await compileMigrationPreview(candidate, plan);
  assertMatch(
    compiled.statements[0],
    /^create unique index "lead_active_name" on "res_.*" \("project_id", "name"\) where "archived_at" is null$/,
  );
  assertMatch(compiled.statements[1], /alter column "name" set not null/);
  assertMatch(compiled.statements[3], /drop constraint if exists "uq_/);
  assertMatch(
    compiled.statements.at(-1)!,
    /^insert into pack_active_revisions/,
  );
  const indexStep = compiled.steps.find((step) =>
    step.kind === "add_resource_constraint"
  )!;
  const fieldStep = compiled.steps.find((step) =>
    step.kind === "change_field"
  )!;
  assertEquals(
    compiled.dependency_graph.edges.some((edge) =>
      edge.from_step_id === indexStep.id && edge.to_step_id === fieldStep.id
    ),
    true,
  );
  assertEquals(
    compiled.dependency_graph.topological_order.at(-1),
    compiled.steps.find((step) => step.kind === "activate_pack_revision")?.id,
  );
});

Deno.test("migration plans block destructive field removal against refreshed facts", async () => {
  const candidate = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: resource },
  ]);
  const activeDocument = structuredClone(
    candidate.resources.lead.document,
  ) as Record<string, unknown>;
  ((activeDocument.spec as Record<string, unknown>).fields as Record<
    string,
    unknown
  >).legacy = { type: "string" };
  const { plan } = await buildMigrationPlan({
    id: uuidV7(),
    candidateRevisionId: uuidV7(),
    authContextId: uuidV7(),
    active: {
      revisionId: uuidV7(),
      normalized: { resources: { lead: activeDocument } },
    },
    candidate,
    liveFacts: {
      resourceRows: { lead: 2 },
      fieldPresentValues: { "lead.legacy": 1 },
    },
  });
  assertEquals(plan.class, "destructive");
  assertEquals(plan.status, "blocked");
  assertEquals(plan.blockers[0].code, "PRESENT_VALUES");
  assertEquals(
    plan.changes.find((change) => change.kind === "remove_field")?.target
      .resource,
    "optd/test:lead",
  );
});
