import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  loadPackFromFiles,
  parseYamlJsonObject,
  type UploadedPackFile,
} from "../../src/adapters/outbound/yaml/pack_loader.ts";
import {
  type PackKind,
  validatePackDocument,
} from "../../src/schemas/packs/pack_schemas.ts";
import { compilePackDdl } from "../../src/adapters/outbound/postgres/resource_ddl.ts";

const root = `kind: Pack
apiVersion: optd.dev/v1
metadata: { publisher: optd, name: test, version: 0.1.0 }
spec:
  purpose: Strict test pack.
  axi:
    purpose: Strict test pack guidance.
    home:
      resources: [optd/test:lead]
      help: ["optctl resources"]
`;
const resource = `kind: Resource
apiVersion: optd.dev/v1
metadata: { name: lead }
spec:
  fields:
    name: { type: string, required: true }
  axi:
    purpose: Test leads.
    whenToUse: [Use test leads.]
    identity: { title: "\${name}", labelFields: [name] }
    list:
      defaultFields: [id, project, name]
      empty:
        message: No test leads found.
        help: ["optctl --project \${project} create optd/test:lead --input object.json --stage"]
    detail:
      help: ["optctl --project \${project} view optd/test:lead \${id}"]
    help:
      list: ["optctl --project \${project} query optd/test:lead"]
      view: ["optctl --project \${project} view optd/test:lead \${id}"]
      created: ["optctl --project \${project} view optd/test:lead \${id}"]
`;

Deno.test("strict pack loader rejects legacy identities and unknown fields", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: root.replace("publisher: optd", "namespace: default"),
      }]),
    Error,
    "additional properties",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("  axi:\n", "  lifecycle: {}\n  axi:\n"),
      }]),
    Error,
    "additional properties",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "type: string",
          "type: string, ref: default.company",
        ),
      }]),
    Error,
    "must match pattern",
  );
});

Deno.test("strict pack loader rejects paths, filenames, YAML tags and documents", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/contact.yaml",
        text: resource,
      }]),
    Error,
    "must match basename",
  );
  await assertRejects(
    () => loadPackFromFiles([{ path: "../pack.yaml", text: root }]),
    Error,
    "invalid pack path",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: `${root}\n---\nkind: Pack`,
      }]),
    Error,
    "exactly one YAML document",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{
        path: "pack.yaml",
        text: "!custom { kind: Pack }",
      }]),
    Error,
    "custom YAML tags",
  );
  await assertRejects(
    () => loadPackFromFiles([{ path: "pack.yaml", text: "1: value" }]),
    Error,
    "mapping keys must be strings",
  );
});

Deno.test("strict pack loader rejects numeric decimal seed values", async () => {
  const decimalResource = resource.replace(
    "name: { type: string, required: true }",
    "name: { type: string, required: true }\n    amount: { type: decimal, required: true }\n  constraints:\n    - { name: lead_active_name, kind: unique, fields: [name], where: 'active()' }",
  );
  const seed =
    `kind: Seed\napiVersion: optd.dev/v1\nmetadata: {name: leads}\nspec:\n  resource: lead\n  key: name\n  mode: changeset\n  rows: [{name: first, amount: 1.25}]\n  axi: {}\n`;
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/lead.yaml", text: decimalResource },
        { path: "seeds/leads.yaml", text: seed },
      ]),
    Error,
    "only JSON safe integers",
  );
});

Deno.test("seed keys require exactly one named active-only uniqueness constraint", async () => {
  const seed =
    `kind: Seed\napiVersion: optd.dev/v1\nmetadata: {name: leads}\nspec:\n  resource: lead\n  key: name\n  mode: changeset\n  rows: [{name: first}]\n  axi: {}\n`;
  const withConstraint = (
    constraint: string,
    field = "name: { type: string, required: true }",
  ) =>
    resource.replace(
      "name: { type: string, required: true }",
      `${field}\n  constraints:\n${constraint}`,
    );
  const valid = withConstraint(
    "    - { name: lead_active_name, kind: unique, fields: [name], where: 'active()' }",
  );
  const loaded = await loadPackFromFiles([
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: valid },
    { path: "seeds/leads.yaml", text: seed },
  ]);
  const ddl =
    (await compilePackDdl(loaded)).find((item) => item.name === "lead")!.ddl;
  assert(ddl.includes('create unique index "lead_active_name"'));
  assert(ddl.includes('("project_id", "name")'));
  assert(ddl.includes('where "archived_at" is null'));

  const invalid = [
    resource,
    withConstraint(
      "    - { name: lead_full_name, kind: unique, fields: [name] }",
    ),
    withConstraint(
      "    - { name: lead_active_other, kind: unique, fields: [other], where: 'active()' }",
    ).replace(
      "name: { type: string, required: true }",
      "name: { type: string, required: true }\n    other: { type: string }",
    ),
    withConstraint(
      "    - { name: lead_active_composite, kind: unique, fields: [name, other], where: 'active()' }",
    ).replace(
      "name: { type: string, required: true }",
      "name: { type: string, required: true }\n    other: { type: string }",
    ),
    withConstraint(
      "    - { name: lead_wrong_predicate, kind: unique, fields: [name], where: 'archived_at == null' }",
    ),
    withConstraint(
      "    - { kind: unique, fields: [name], where: 'active()' }",
    ),
    withConstraint(
      "    - { name: lead_active_one, kind: unique, fields: [name], where: 'active()' }\n    - { name: lead_active_two, kind: unique, fields: [name], where: 'active()' }",
    ),
    withConstraint(
      "    - { name: duplicate_name, kind: unique, fields: [name], where: 'active()' }\n    - { name: duplicate_name, kind: check, expression: 'true' }",
    ),
    withConstraint(
      "    - { name: lead_active_name, kind: unique, fields: [name], where: 'active()' }",
      "name: { type: string, required: true, unique: true }",
    ),
    withConstraint(
      "    - { name: lead_active_name, kind: unique, fields: [name], where: 'active()' }",
      "name: { type: string }",
    ),
  ];
  for (const invalidResource of invalid) {
    await assertRejects(() =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/lead.yaml", text: invalidResource },
        { path: "seeds/leads.yaml", text: seed },
      ])
    );
  }
});

Deno.test("strict pack loader broadly rejects superseded schema and unsafe source forms", async () => {
  const cases: Array<{
    name: string;
    files: UploadedPackFile[];
    message: string;
  }> = [
    {
      name: "missing apiVersion",
      files: [{
        path: "pack.yaml",
        text: root.replace("apiVersion: optd.dev/v1\n", ""),
      }],
      message: "apiVersion",
    },
    {
      name: "child namespace alias",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "metadata: { name: lead }",
          "metadata: { name: lead, namespace: default }",
        ),
      }],
      message: "additional properties",
    },
    {
      name: "field defaults",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace(
          "required: true",
          "required: true, default: legacy",
        ),
      }],
      message: "additional properties",
    },
    {
      name: "extension bags",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("  axi:\n", "  extensions: {}\n  axi:\n"),
      }],
      message: "additional properties",
    },
    {
      name: "inline action hook and array input",
      files: [{ path: "pack.yaml", text: root }, {
        path: "actions/run.yaml",
        text:
          `kind: Action\napiVersion: optd.dev/v1\nmetadata: {name: run}\nspec: {hook: run, input: [id], axi: {}}\n`,
      }],
      message: "additional properties",
    },
    {
      name: "policy allow alias",
      files: [{ path: "pack.yaml", text: root }, {
        path: "policies/access.yaml",
        text:
          `kind: Policy\napiVersion: optd.dev/v1\nmetadata: {name: access}\nspec: {rules: [{role: admin, allow: ['*']}], axi: {}}\n`,
      }],
      message: "default_assignment",
    },
    {
      name: "relationship endpoint fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "relationships/link.yaml",
        text:
          `kind: Relationship\napiVersion: optd.dev/v1\nmetadata: {name: link}\nspec: {from: {resource: lead, field: id}, to: {resource: lead}, axi: {}}\n`,
      }],
      message: "additional properties",
    },
    {
      name: "binary fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("type: string", "type: binary"),
      }],
      message: "schema",
    },
    {
      name: "reserved platform fields",
      files: [{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("name: {", "project_id: {"),
      }],
      message: "reserved platform field",
    },
    {
      name: "unknown layout",
      files: [{ path: "pack.yaml", text: root }, {
        path: "docs/readme.yaml",
        text: "kind: Docs",
      }],
      message: "unexpected pack path",
    },
    {
      name: "hook imports",
      files: [{ path: "pack.yaml", text: root }, {
        path: "hooks/run.ts",
        kind: "script",
        text: `await import("npm:x");\n`,
      }],
      message: "imports are not supported",
    },
    {
      name: "duplicate mapping keys",
      files: [{
        path: "pack.yaml",
        text: root.replace("kind: Pack", "kind: Pack\nkind: Pack"),
      }],
      message: "Map keys must be unique",
    },
    {
      name: "non-finite YAML numbers",
      files: [{
        path: "pack.yaml",
        text: root.replace("version: 0.1.0", "version: .inf"),
      }],
      message: "only JSON safe integers",
    },
    {
      name: "duplicate uploaded paths",
      files: [{ path: "pack.yaml", text: root }, {
        path: "pack.yaml",
        text: root,
      }],
      message: "duplicate pack path",
    },
    {
      name: "backslash paths",
      files: [{ path: "resources\\lead.yaml", text: resource }],
      message: "invalid pack path",
    },
  ];
  for (const testCase of cases) {
    await assertRejects(
      () => loadPackFromFiles(testCase.files),
      Error,
      testCase.message,
      testCase.name,
    );
  }
});

Deno.test("relationship policy targets resolve canonically with strict vocabulary", async () => {
  const role = `kind: Role
apiVersion: optd.dev/v1
metadata: {name: manager}
spec:
  display_name: Manager
  description: Manages lead relationships.
  axi: {}
`;
  const relationship = `kind: Relationship
apiVersion: optd.dev/v1
metadata: {name: lead_link}
spec:
  from: {resource: lead}
  to: {resource: lead}
  axi: {}
`;
  const policy = (
    target: string,
    actions = "link, unlink",
    clause = "",
  ) =>
    `kind: Policy
apiVersion: optd.dev/v1
metadata: {name: access}
spec:
  default_assignment: all_projects
  rules:
    - name: manage_links
      effect: allow
      roles: [manager]
      actions: [${actions}]
      resources: [${target}]
${clause}
  axi: {}
`;
  const files = (
    target: string,
    actions?: string,
    clause?: string,
  ): UploadedPackFile[] => [
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: resource },
    { path: "relationships/lead_link.yaml", text: relationship },
    { path: "roles/manager.yaml", text: role },
    { path: "policies/access.yaml", text: policy(target, actions, clause) },
  ];

  for (const target of ["lead_link", "optd/test:lead_link"]) {
    const loaded = await loadPackFromFiles(files(target));
    const rule = (loaded.policies.access.spec.rules as Array<{
      actions: string[];
      resources: string[];
    }>)[0];
    assertEquals(rule.actions, ["link", "unlink"]);
    assertEquals(rule.resources, ["optd/test:lead_link"]);
    assertEquals(
      ((loaded.normalized.policies as Record<string, Record<string, unknown>>)
        .access.spec as { rules: Array<{ resources: string[] }> }).rules[0]
        .resources,
      ["optd/test:lead_link"],
    );
  }

  for (
    const target of [
      "missing_link",
      "optd/test:missing_link",
      "other/pack:lead_link",
    ]
  ) {
    await assertRejects(
      () => loadPackFromFiles(files(target)),
      Error,
      "policy target",
      target,
    );
  }

  for (
    const action of [
      "read",
      "read_archived",
      "history.read",
      "create",
      "update",
      "archive",
      "transition",
      "comment",
    ]
  ) {
    await assertRejects(
      () => loadPackFromFiles(files("lead_link", action)),
      Error,
      "relationship policy targets support only link and unlink",
      action,
    );
  }
  await assertRejects(
    () =>
      loadPackFromFiles(files("lead_link", "link", "      where: name == 'x'")),
    Error,
    "do not support where or relation clauses",
  );
  await assertRejects(
    () =>
      loadPackFromFiles(
        files(
          "lead_link",
          "unlink",
          "      relation: {relationship: lead_link, object_side: from, subject_side: to, subject: actor.id}",
        ),
      ),
    Error,
    "do not support where or relation clauses",
  );

  const canonical = parseYamlJsonObject(policy("lead_link"), "policy");
  assertEquals(validatePackDocument("Policy", canonical), []);
});

Deno.test("approval policy vocabulary is exact, paired, and canonically preserved", async () => {
  const role = `kind: Role
apiVersion: optd.dev/v1
metadata: {name: manager}
spec:
  display_name: Manager
  description: Approves reviewed changesets.
  axi: {}
`;
  const policy = (action: string, policyResource: string) =>
    `kind: Policy
apiVersion: optd.dev/v1
metadata: {name: approval}
spec:
  default_assignment: all_projects
  rules:
    - name: decide
      effect: allow
      roles: [manager]
      actions: [${action}]
      resources: [${policyResource}]
  axi: {}
`;
  const files = (
    action: string,
    policyResource: string,
  ): UploadedPackFile[] => [
    { path: "pack.yaml", text: root },
    { path: "resources/lead.yaml", text: resource },
    { path: "roles/manager.yaml", text: role },
    {
      path: "policies/approval.yaml",
      text: policy(action, policyResource),
    },
  ];

  const loaded = await loadPackFromFiles(
    files("changeset.approval.decide", "system:changeset-approval"),
  );
  const rule = (loaded.policies.approval.spec.rules as Array<{
    roles: string[];
    actions: string[];
    resources: string[];
  }>)[0];
  assertEquals(rule.roles, ["optd/test:manager"]);
  assertEquals(rule.actions, ["changeset.approval.decide"]);
  assertEquals(rule.resources, ["system:changeset-approval"]);
  assertEquals(
    ((loaded.normalized.policies as Record<string, Record<string, unknown>>)
      .approval.spec as { rules: Array<{ resources: string[] }> }).rules[0]
      .resources,
    ["system:changeset-approval"],
  );

  for (
    const [action, policyResource] of [
      ["changeset.approval.decide", "lead"],
      ["read", "system:changeset-approval"],
      ["changeset.approval.deside", "system:changeset-approval"],
      ["changeset.approval.decide", "system:changeset-approvals"],
      ["changeset.approval.decide", "system:anything"],
    ]
  ) {
    await assertRejects(
      () => loadPackFromFiles(files(action, policyResource)),
      Error,
      undefined,
      `${action} / ${policyResource}`,
    );
  }

  const invalidIdentityDocuments: Array<[PackKind, unknown]> = [
    [
      "Resource",
      parseYamlJsonObject(
        resource.replace(
          "type: string, required: true",
          "type: string, required: true, ref: system:changeset-approval",
        ),
        "resource",
      ),
    ],
    [
      "Relationship",
      parseYamlJsonObject(
        `kind: Relationship\napiVersion: optd.dev/v1\nmetadata: {name: bad}\nspec: {from: {resource: system:changeset-approval}, to: {resource: lead}, axi: {}}\n`,
        "relationship",
      ),
    ],
  ];
  for (const [kind, document] of invalidIdentityDocuments) {
    assert(validatePackDocument(kind, document).length > 0, kind);
  }
});

Deno.test("lifecycle cross-invariants reject every invalid graph and mutation", async () => {
  const lifecycleResource =
    `kind: Resource\napiVersion: optd.dev/v1\nmetadata: {name: ticket}\nspec:\n  fields:\n    state: {type: string, required: true, enum: [open, closed]}\n    title: {type: string, required: true, maxLength: 8}\n    count: {type: integer, minimum: 0, maximum: 10}\n    amount: {type: decimal, precision: 4, scale: 2}\n    note: {type: string}\n  axi:\n    purpose: Test tickets.\n    whenToUse: [Use test tickets.]\n    identity: {title: "\${title}", labelFields: [title]}\n    list:\n      defaultFields: [id, state, title]\n      empty: {message: No tickets found., help: ["optctl --project \${project} create optd/test:ticket --input object.json --stage"]}\n    detail: {help: ["optctl --project \${project} view optd/test:ticket \${id}"]}\n    help:\n      list: ["optctl --project \${project} query optd/test:ticket"]\n      view: ["optctl --project \${project} view optd/test:ticket \${id}"]\n      created: ["optctl --project \${project} view optd/test:ticket \${id}"]\n`;
  const lifecycle = (
    states: string,
    transitions: string,
    initial = "open",
    field = "state",
  ) =>
    `kind: Lifecycle\napiVersion: optd.dev/v1\nmetadata: {name: ticket_flow}\nspec:\n  resource: ticket\n  field: ${field}\n  initial: ${initial}\n  states: ${states}\n  transitions: ${transitions}\n  axi: {}\n`;
  const invalid: Array<[string, string, string, string?]> = [
    [
      "terminal initial",
      lifecycle(
        "[{name: open, terminal: true}, {name: closed, terminal: true}]",
        "[]",
      ),
      "initial lifecycle state must be nonterminal",
    ],
    [
      "duplicate states",
      lifecycle(
        "[{name: open}, {name: open, terminal: true}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}]",
      ),
      "duplicate state name open",
    ],
    [
      "duplicate transitions",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: move, from: [open], to: closed}, {name: move, from: [open], to: closed, condition: 'true'}]",
      ),
      "duplicate transition name move",
    ],
    [
      "unknown required field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true, required_fields: [missing]}]",
        "[{name: close, from: [open], to: closed}]",
      ),
      "undeclared resource field missing",
    ],
    [
      "unknown set field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {missing: x}}]",
      ),
      "set.missing: undeclared resource field",
    ],
    [
      "invalid set type",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {count: nope}}]",
      ),
      "expected integer",
    ],
    [
      "invalid set bounds",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {count: 11}}]",
      ),
      "exceeds maximum",
    ],
    [
      "invalid decimal set",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {amount: '1.234'}}]",
      ),
      "decimal scale exceeds",
    ],
    [
      "unknown unset field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, unset: [missing]}]",
      ),
      "undeclared resource field missing",
    ],
    [
      "required unset field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, unset: [title]}]",
      ),
      "required field title cannot be unset",
    ],
    [
      "overlapping mutation",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {note: x}, unset: [note]}]",
      ),
      "set and unset mutations overlap",
    ],
    [
      "lifecycle field mutation",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed, set: {state: closed}}]",
      ),
      "lifecycle field is mutated by transition.to",
    ],
    [
      "unknown from",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [missing], to: closed}]",
      ),
      "unknown lifecycle state missing",
    ],
    [
      "unknown to",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: missing}]",
      ),
      "unknown lifecycle state missing",
    ],
    [
      "unreachable",
      lifecycle(
        "[{name: open}, {name: waiting}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}]",
      ),
      "unreachable lifecycle states waiting",
      lifecycleResource.replace(
        "enum: [open, closed]",
        "enum: [open, waiting, closed]",
      ),
    ],
    [
      "terminal outgoing",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}, {name: reopen, from: [closed], to: open}]",
      ),
      "terminal state closed cannot have outgoing transitions",
    ],
    [
      "undeclared lifecycle field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}]",
        "open",
        "missing",
      ),
      "lifecycle field must be a required string field",
    ],
    [
      "optional lifecycle field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}]",
      ),
      "lifecycle field must be a required string field",
      lifecycleResource.replace(
        "state: {type: string, required: true, enum",
        "state: {type: string, enum",
      ),
    ],
    [
      "non-string lifecycle field",
      lifecycle(
        "[{name: open}, {name: closed, terminal: true}]",
        "[{name: close, from: [open], to: closed}]",
      ),
      "lifecycle field must be a required string field",
      lifecycleResource.replace(
        "state: {type: string, required: true, enum: [open, closed]}",
        "state: {type: integer, required: true}",
      ),
    ],
    [
      "field enum mismatch",
      lifecycle(
        "[{name: open}, {name: waiting}, {name: closed, terminal: true}]",
        "[{name: wait, from: [open], to: waiting}, {name: close, from: [waiting], to: closed}]",
      ),
      "exactly match the lifecycle field enum",
    ],
  ];
  for (
    const [name, document, message, resourceDocument = lifecycleResource]
      of invalid
  ) {
    await assertRejects(
      () =>
        loadPackFromFiles([
          { path: "pack.yaml", text: root },
          { path: "resources/ticket.yaml", text: resourceDocument },
          { path: "lifecycles/ticket_flow.yaml", text: document },
        ]),
      Error,
      message,
      name,
    );
  }
  const valid = lifecycle(
    "[{name: open}, {name: closed, terminal: true, required_fields: [title]}]",
    "[{name: close, from: [open], to: closed, set: {count: 5, amount: '1.25'}, unset: [note]}]",
  );
  const duplicate = valid.replace(
    "metadata: {name: ticket_flow}",
    "metadata: {name: second_flow}",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/ticket.yaml", text: lifecycleResource },
        { path: "lifecycles/ticket_flow.yaml", text: valid },
        { path: "lifecycles/second_flow.yaml", text: duplicate },
      ]),
    Error,
    "more than one lifecycle",
  );
});

Deno.test("strict pack loader canonicalizes bounded YAML aliases", async () => {
  const merged = resource.replace(
    "name: { type: string, required: true }",
    "name: &field { type: string, required: true }\n    code:\n      <<: *field",
  );
  const pack = await loadPackFromFiles([{ path: "pack.yaml", text: root }, {
    path: "resources/lead.yaml",
    text: merged,
  }]);
  assertEquals(pack.resources.lead.spec.fields, {
    code: { required: true, type: "string" },
    name: { required: true, type: "string" },
  });
  assert(pack.revision.startsWith("optd/test@0.1.0:sha256:"));
});

Deno.test("every AXI kind accepts only exact empty or complete guidance", async () => {
  const documents = new Map<PackKind, Record<string, unknown>>();
  async function collect(path: string) {
    for await (const entry of Deno.readDir(path)) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory) await collect(child);
      else if (entry.name.endsWith(".yaml")) {
        const document = parseYamlJsonObject(
          await Deno.readTextFile(child),
          child,
        );
        const kind = document.kind as PackKind;
        if (!documents.has(kind)) documents.set(kind, document);
      }
    }
  }
  await collect("prototypes/crm-default-pack");
  assertEquals(documents.size, 9);
  for (const [kind, source] of documents) {
    const empty = structuredClone(source);
    (empty.spec as Record<string, unknown>).axi = {};
    assertEquals(validatePackDocument(kind, empty), [], `${kind} empty AXI`);

    const partial = structuredClone(source);
    (partial.spec as Record<string, unknown>).axi = {
      purpose: "Incomplete guidance must fail.",
    };
    assert(
      validatePackDocument(kind, partial).length > 0,
      `${kind} accepted partial AXI guidance`,
    );
  }
});

Deno.test("strict AXI readiness and safe placeholders fail pack preview", async () => {
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("    whenToUse: [Use test leads.]\n", ""),
      }]),
    Error,
    "whenToUse",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("${name}", "${name.value}"),
      }]),
    Error,
    "unsafe AXI placeholder 'name.value'",
  );
  await assertRejects(
    () =>
      loadPackFromFiles([{ path: "pack.yaml", text: root }, {
        path: "resources/lead.yaml",
        text: resource.replace("${name}", "${missing}"),
      }]),
    Error,
    "unknown AXI placeholder 'missing'",
  );
  const action =
    `kind: Action\napiVersion: optd.dev/v1\nmetadata: {name: run}\nspec:\n  input: {value: {type: string, required: true}}\n  axi:\n    purpose: Run the test action.\n    successHelp: ["optctl changeset inspect \${stage_id}"]\n`;
  await assertRejects(
    () =>
      loadPackFromFiles([
        { path: "pack.yaml", text: root },
        { path: "resources/lead.yaml", text: resource },
        { path: "actions/run.yaml", text: action },
      ]),
    Error,
    "examples",
  );
});

Deno.test("strict pack loader accepts both publisher-qualified proof packs", async () => {
  for (
    const [dir, expected] of [["prototypes/crm-default-pack", "optd/crm"], [
      "prototypes/project-management-pack",
      "optd/projects",
    ]] as const
  ) {
    const files: UploadedPackFile[] = [];
    const collect = async (path: string, prefix = "") => {
      for await (const entry of Deno.readDir(path)) {
        const child = `${path}/${entry.name}`;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory) await collect(child, relative);
        else if (/\.(?:yaml|ts)$/.test(relative)) {
          files.push({ path: relative, text: await Deno.readTextFile(child) });
        }
      }
    };
    await collect(dir);
    const pack = await loadPackFromFiles(files);
    assertEquals(`${pack.publisher}/${pack.name}`, expected);
    assert(Object.keys(pack.roles).length > 0);
    assert(
      Object.values(pack.resources).every((definition) =>
        definition.identity.startsWith(`${expected}:`)
      ),
    );
    const ddl = await compilePackDdl(pack);
    const activeSeedIndexes = ddl.filter((object) =>
      object.ddl.includes('where "archived_at" is null') &&
      object.ddl.includes("_active_name")
    );
    assertEquals(activeSeedIndexes.length, expected === "optd/crm" ? 5 : 2);
    if (expected === "optd/projects") {
      const member = ddl.find((object) => object.name === "project_member")!;
      assert(
        member.ddl.includes(
          'constraint "project_principal_membership" unique ("project_id", "work_project_id", "principal_id")',
        ),
      );
      assertEquals(
        member.ddl.includes(
          '"project_principal_membership"',
        ) &&
          member.ddl.includes('where "archived_at" is null'),
        false,
      );
    }
  }
});
