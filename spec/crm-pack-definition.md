# CRM Pack Definition Prototype

## Status

This document is historical design research for the CRM domain model. For MVP
implementation, the canonical CRM fixture is `prototypes/crm-default-pack/` with
pack identity `default.crm@0.1.0`. If this document conflicts with the fixture,
`spec/mvp-acceptance-criteria.md`, or `spec/pack-structure.md`, use those newer
sources and update this research document later.

## Purpose

This spec explores the configuration primitives needed to define a default CRM
pack as ordinary user-hackable configuration. The CRM pack should create
tables/resources, relationships, constraints, lifecycles, actions, validations,
hooks, indexes, search settings, and seed data without special platform code.

## Design Direction

Use **bundled/app-managed local Postgres** as the default runtime. This means
the configuration model can target real Postgres semantics first:

- Foreign keys
- Unique indexes
- Partial indexes
- Check constraints
- Transactions
- Row locks
- JSONB
- Generated columns later if useful

The platform should still preserve a high-level resource model so users are not
hand-writing migrations as the primary workflow.

## Key Configuration Primitives

A pack likely needs these primitive document kinds:

1. `Pack`: metadata, version, dependencies, included files/resources.
2. `Resource`: defines an object type and its backing table shape.
3. `Relationship`: defines references or first-class link tables between
   resources.
4. `Lifecycle`: defines states and transitions. Could be inline in `Resource` or
   separate.
5. `Action`: defines named intentions such as `convert_lead` or `close_won`.
6. `Hook`: defines executable behavior attached to resources, transitions, or
   actions.
7. `Policy`: defines who/what can perform actions. Optional for initial
   single-user prototype.
8. `Index`: defines query/search indexes. Usually inline in `Resource` unless
   reused or backend-specific.
9. `Seed`: defines initial reference data such as default pipeline stages and
   lost reasons.
10. `View` / `Query`: optional saved query or CLI display hints.

Constraints do not need to be a primary top-level kind at first. Most
constraints should live inline on fields or resources. A separate `Constraint`
kind may be useful later for reusable, cross-resource, or operationally managed
constraints.

## Primitive: Pack

A pack groups resources and scripts. It is ordinary configuration, not a plugin
with hidden code.

Behavior scripts should be included as files inside the pack directory and
referenced by relative paths. At apply time, the platform should snapshot
scripts into the config revision by digest so future audit records can explain
exactly which script version ran even if the pack files are later edited.

Recommended pack layout:

```text
packs/crm/
  pack.yaml
  resources/
    company.yaml
    contact.yaml
    lead.yaml
    opportunity.yaml
    activity.yaml
  actions/
    convert-lead.yaml
  hooks/
    validate-lead.ts
    normalize-email.nu
    convert-lead.ts
    notify-lead-change.sh
  seeds/
    pipeline-stages.yaml
    lost-reasons.yaml
```

The source-of-truth during development is the file tree. The source-of-truth
after apply is the stored config revision containing resource definitions plus
content-addressed script digests.

```yaml
kind: Pack
apiVersion: operant.dev/v1
metadata:
  name: crm
  version: 0.1.0
spec:
  description: Minimal headless CRM resources and behavior
  includes:
    resources:
      - resources/company.yaml
      - resources/contact.yaml
      - resources/lead.yaml
      - resources/opportunity.yaml
      - resources/activity.yaml
      - resources/note.yaml
      - resources/pipeline-stage.yaml
      - resources/lost-reason.yaml
    actions:
      - actions/convert-lead.yaml
    hooks:
      - hooks/validate-lead.ts
      - hooks/normalize-email.ts
      - hooks/convert-lead.ts
      - hooks/notify-lead-change.ts
    seeds:
      - seeds/pipeline-stages.yaml
      - seeds/lost-reasons.yaml
```

Pack apply flow:

1. Load pack manifest.
2. Resolve referenced files relative to the pack root.
3. Validate syntax and names.
4. Validate hook metadata and Deno-compatible script text.
5. Hash script contents and record digests.
6. Store normalized config and script contents in the database as an immutable
   config revision.
7. Build config graph.
8. Preview database migrations, hooks, seeds, and destructive changes.
9. Apply as one config revision where possible.

Script inclusion options:

- **Referenced file path:** preferred for local packs under source control.
- **Multipart file upload:** preferred for API/agent upload workflows.
- **Inline script:** allowed only for tiny tests/examples; not the primary path
  because multiline JSON strings are awkward to edit, escape, diff, and review.
- **Content-addressed database artifact:** internal representation after apply;
  good for execution, audit, backup, and reproducibility.

Avoid remote script URLs in initial versions. Remote code introduces
supply-chain, reproducibility, and audit problems.

## Primitive: Resource

A resource defines the logical object and backing storage.

Resource kind names are always lowercase. Use lowercase snake case for
multi-word resource kinds, e.g. `pipeline_stage`, `lost_reason`,
`contact_company`. Display labels can be capitalized, but API/config identifiers
cannot.

```yaml
kind: Resource
apiVersion: operant.dev/v1
metadata:
  name: lead
  plural: leads
  pack: crm
spec:
  storage:
    table: crm_leads
    primaryKey:
      field: id
      type: uuid
      default: generated
  display:
    title: name
    subtitle: [company_name, email]
  fields:
    id:
      type: uuid
      system: true
    name:
      type: string
      required: true
      maxLength: 240
    email:
      type: string
      format: email
    phone:
      type: string
    company_name:
      type: string
    source:
      type: string
    score:
      type: integer
      default: 0
      constraints:
        - type: min
          value: 0
    status:
      type: string
      default: new
    owner_id:
      type: ref
      ref: user
    lost_reason_id:
      type: ref
      ref: lost_reason
    created_at:
      type: timestamp
      system: true
    updated_at:
      type: timestamp
      system: true
    version:
      type: integer
      system: true
      default: 1
  constraints:
    - name: lead_contact_method_required
      type: check
      expression: "present(email) OR present(phone)"
    - name: lead_email_unique_when_present
      type: unique
      fields: [email]
      where: "present(email)"
  indexes:
    - name: lead_status_idx
      fields: [status]
    - name: lead_owner_status_idx
      fields: [owner_id, status]
    - name: lead_search_idx
      type: fulltext
      fields: [name, email, company_name]
  lifecycle:
    field: status
    states:
      - new
      - contacted
      - qualified
      - disqualified
      - converted
    transitions:
      - from: new
        to: contacted
      - from: contacted
        to: qualified
        requires:
          fields: [email]
      - from: contacted
        to: disqualified
        requires:
          fields: [lost_reason_id]
      - from: qualified
        to: converted
        action: convert_lead
  hooks:
    validate:
      - ref:
          namespace: crm
          name: validate_lead
    before_commit:
      - ref:
          namespace: crm
          name: normalize_lead
    after_commit:
      - ref:
          namespace: crm
          name: notify_lead_change
```

### Field Types

Initial field types should stay small:

- `string`
- `text`
- `integer`
- `decimal`
- `boolean`
- `date`
- `timestamp`
- `uuid`
- `json`
- `enum`
- `ref`
- `list` later

### System Fields

The platform can inject system fields into every resource unless explicitly
disabled:

- `id`
- `created_at`
- `updated_at`
- `deleted_at`
- `created_by`
- `updated_by`
- `version`

The pack should not need to repeat these unless it wants to customize
storage/display names.

## Primitive: Relationship

Relationships come in two forms.

### Field Reference

Use field references for hard constraints and ordinary foreign keys:

```yaml
field: company_id
type: ref
ref: company
onDelete: restrict
```

This compiles to a database foreign key where possible.

### First-Class Relationship

Use relationship resources when the link has metadata, history, policy, or
many-to-many shape.

```yaml
kind: Relationship
apiVersion: operant.dev/v1
metadata:
  name: contactCompany
  pack: crm
spec:
  storage:
    table: crm_contact_companies
  from:
    resource: contact
    field: contact_id
  to:
    resource: company
    field: company_id
  cardinality: many-to-many
  fields:
    role:
      type: string
    is_primary:
      type: boolean
      default: false
  constraints:
    - name: one_contact_company_role
      type: unique
      fields: [contact_id, company_id, role]
  indexes:
    - fields: [contact_id]
    - fields: [company_id]
```

## Primitive: Lifecycle

Lifecycle can be inline for simple resources or split out when shared.

```yaml
kind: Lifecycle
apiVersion: operant.dev/v1
metadata:
  name: opportunityPipeline
  pack: crm
spec:
  field: stage
  states:
    - new
    - qualified
    - discovery
    - proposal
    - negotiation
    - won
    - lost
  transitions:
    - from: new
      to: qualified
    - from: qualified
      to: discovery
    - from: discovery
      to: proposal
      requires:
        fields: [amount, expected_close_date]
    - from: proposal
      to: negotiation
      hooks:
        validate:
          - ref:
              namespace: crm
              name: validate_discount_approval
    - from: negotiation
      to: won
      requires:
        relationships:
          - company
          - primary_contact
    - from: [qualified, discovery, proposal, negotiation]
      to: lost
      requires:
        fields: [lost_reason_id]
```

## Primitive: Action

Actions are named intentions. They are how agents perform domain operations
without raw table updates.

The line between `Action` and `Hook`:

- **Action = product/API contract / invocable operation.** It is named,
  discoverable, permissioned, documented, has input schema, appears in
  CLI/API/MCP, and returns a changeset preview/commit result.
- **Hook = implementation function / lifecycle callback.** It is executable code
  attached to an action/resource/transition/event. It receives structured
  context and returns a typed result.

An agent should know about actions. An agent usually should not need to know
which scripts implement them.

If users invoke it directly as business behavior, it is probably an `Action`. If
the platform invokes it automatically at a lifecycle point, it is probably a
`Hook`.

Actions are closest to a headless “button” an agent can click in the context of
an object or collection:

- `lead.convert`
- `lead.disqualify`
- `opportunity.close_won`
- `opportunity.close_lost`
- `contact.merge`
- `activity.mark_done`

Actions may be available only in certain states or contexts. For example,
`lead.convert` is available when a lead is `qualified`; `opportunity.close_won`
is available when required fields and relationships exist.

Transitions can be triggered in two ways:

1. **Direct transition intention:** agent requests
   `transition opportunity -> proposal`; lifecycle config validates allowed
   transition and runs transition hooks.
2. **Action-triggered transition:** agent invokes `lead.convert`; action
   behavior emits changeset operations including a lifecycle transition plus
   related creates/links.

Hooks do not define when they run by themselves. The attachment point defines
that:

- Resource hook: runs during create/update/delete for that resource.
- Transition hook: runs before/after a specific lifecycle transition.
- Action hook: runs as preview/commit implementation of an invocable action.
- Event hook: runs after a committed event.
- Scheduled hook: runs on a schedule.

An action definition should describe:

- Input schema.
- Required reads/context.
- Validation hooks.
- Preview behavior.
- Commit behavior.
- Changeset operations it may emit.
- Events it emits after commit.
- Approval requirements, if any.

Action behavior can be defined in two ways:

1. **Declarative operations:** simple actions can be configured as a sequence of
   built-in changeset operations.
2. **Hook-backed behavior:** complex actions call scripts that return proposed
   changeset operations.

The important rule is that actions and hooks do **not** directly mutate tables.
They produce changeset operations, validation results, approval requirements, or
after-commit side effects. The changeset engine remains the only writer.

```yaml
kind: Action
apiVersion: operant.dev/v1
metadata:
  name: convert_lead
  pack: crm
spec:
  input:
    lead_id:
      type: ref
      ref: lead
      required: true
    create_company:
      type: boolean
      default: true
    create_contact:
      type: boolean
      default: true
    create_opportunity:
      type: boolean
      default: true
  reads:
    - resource: lead
      as: lead
      by: input.lead_id
    - resource: company
      as: matching_company
      where:
        domain: derived.lead_email_domain
      optional: true
  validate:
    hooks:
      - namespace: crm
        name: validate_convert_lead
  availability:
    resource: lead
    states: [qualified]
  behavior:
    mode: hook
    preview: crm.preview_convert_lead
    commit: crm.commit_convert_lead
    returns: changeset.operations.v1
  emits:
    - crm.lead_converted
```

Actions should return changeset operations, not directly mutate the database.

Example operations emitted by `convert_lead`:

- Create `company` if needed.
- Create `contact` if needed.
- Create `opportunity`.
- Link `contact` to `company`.
- Link `opportunity` to `company` and `contact`.
- Transition `lead.status` to `converted`.
- Create initial follow-up `activity`.

## Namespacing

Use explicit metadata fields for identity, while allowing dotted names as
ergonomic config/CLI shorthand.

Canonical identity:

```yaml
metadata:
  namespace: crm
  name: commit_convert_lead
```

Ergonomic reference shorthand:

```yaml
ref: crm.commit_convert_lead
```

Structured references should also be accepted when clarity is useful:

```yaml
ref:
  namespace: crm
  name: commit_convert_lead
```

Internally, dotted names parse to `(namespace, name)`. The persisted identity
should still be structured. This preserves readability while avoiding ambiguity
in storage, validation, and refactoring.

Namespace guidance:

- Pack-provided resources/hooks/actions use the pack namespace, e.g. `crm`.
- User-local customizations can use a namespace such as `local`, `custom`, or an
  org/project-defined namespace.
- Core platform resources use a reserved namespace such as `core` or `operant`.
- Name uniqueness is scoped by `(kind, namespace, name)`.

## Primitive: Hook

Hooks define executable behavior separately from hook attachment points. This
makes hooks reusable and versionable.

A hook definition answers:

- Which script/code runs?
- Which Deno script/code runs?
- What input schema does it require?
- What output schema must it return?
- What permissions does it have?
- What timeout/resource limits apply?
- What happens on failure?

Hooks should be reusable functions with a strict input/output contract.
Attachment points decide when they run and map available context into the hook's
declared inputs.

Hooks are always run by the platform hook runner using Deno. Shebangs are not
required and runtime metadata is not part of normal hook configuration.

```yaml
kind: Hook
apiVersion: operant.dev/v1
metadata:
  namespace: crm
  name: validate_lead
spec:
  path: hooks/crm/validate-lead.ts
  timeout: 2s
  permissions:
    net: false
    read: false
    write: false
    env: false
    run: false
  input:
    schema:
      lead:
        type: object
        resource: lead
        required: true
      proposed:
        type: object
        resource: lead
        required: true
  output:
    schema: hook.validation.v1
  failureMode: fail-closed
```

Hook language and parameter transport:

- Hooks are Deno/TypeScript scripts by default.
- The platform writes one JSON envelope to stdin.
- The hook writes one JSON result to stdout.
- Logs/debug output go to stderr.
- Env vars are reserved for true environment values and secrets.
- CLI args are not used for structured hook parameters.
- Magic/input files are only referenced from the JSON envelope for large
  artifacts.
- Hook-level permissions declare requested Deno capabilities.
- Global policy may disable classes of permissions regardless of hook request.

Hook output types:

- `validation.v1`: errors, warnings, allow/deny.
- `patch.v1`: safe patches to the proposed object.
- `changeset.operations.v1`: additional create/update/link/transition
  operations.
- `approval.v1`: required approvers and reasons.
- `side_effect.v1`: after-commit work such as notifications or external calls.

Hook attachment points:

- Resource `validate`
- Resource `before_commit`
- Resource `after_commit`
- Lifecycle transition `validate`
- Lifecycle transition `after_commit`
- Action `preview`
- Action `commit`
- Event subscription `on_event`
- Scheduled task `scheduled`

For example, `convert_lead` can be an action whose commit hook returns changeset
operations to create/link `company`, `contact`, `opportunity`, and `activity`.
The hook does not insert rows itself.

When attaching a hook, the attachment point wires context into the hook's
declared input schema:

```yaml
validate:
  hooks:
    - ref: crm.validate_lead
      with:
        lead: current
        proposed: proposed
```

```yaml
behavior:
  mode: hook
  commit:
    ref: crm.commit_convert_lead
    with:
      lead: reads.lead
      matching_company: reads.matching_company
      options: input
```

This means hook inputs are explicit, but they are satisfied by mappings from the
action/resource/transition context.

## Primitive: Constraint

Constraints mostly live in two places:

1. **Field-level constraints** for rules that involve one field.
2. **Resource-level constraints** for rules involving multiple fields, indexes,
   foreign keys, partial uniqueness, checks, or named database objects.

A separate top-level `Constraint` kind is not required for the first CRM pack.
It may be useful later for constraints that are shared, generated, independently
versioned, or managed across resources.

Field-level examples:

```yaml
fields:
  email:
    type: string
    format: email
    unique:
      where: "present(email)"
  amount:
    type: decimal
    min: 0
  company_id:
    type: ref
    ref: company
    required: true
    onDelete: restrict
```

Resource-level constraints need stable names because they become DB objects and
appear in preview/errors.

Supported resource-level constraints:

```yaml
constraints:
  - name: unique_contact_email
    type: unique
    fields: [email]
    where: "present(email)"
  - name: activity_due_date_required_for_open
    type: check
    expression: "status != 'open' OR present(due_at)"
  - name: opportunity_amount_non_negative
    type: check
    expression: "amount >= 0"
  - name: opportunity_company_fk
    type: foreignKey
    field: company_id
    references:
      resource: company
      field: id
    onDelete: restrict
```

Important: constraint expressions are powerful and can become unsafe if
arbitrary SQL is accepted. Early versions may use a structured expression DSL
that compiles to SQL rather than raw SQL.

## Primitive: Seed Data

CRM needs default reference data.

```yaml
kind: Seed
apiVersion: operant.dev/v1
metadata:
  name: crm-default-pipeline-stages
spec:
  resource: pipeline_stage
  mode: upsert
  key: name
  records:
    - name: New
      order: 10
      maps_to_state: new
    - name: Qualified
      order: 20
      maps_to_state: qualified
    - name: Proposal
      order: 30
      maps_to_state: proposal
    - name: Won
      order: 90
      maps_to_state: won
    - name: Lost
      order: 100
      maps_to_state: lost
```

## Minimal CRM Resource Set

### Company

Fields:

- `name` required
- `domain` unique when present
- `industry`
- `size`
- `website`
- `owner_id`

Constraints:

- unique `domain` where present

Hooks:

- normalize domain

### Contact

Fields:

- `first_name`
- `last_name`
- `email` unique when present
- `phone`
- `title`
- `owner_id`

Relationships:

- many-to-many with `company` through `contact_company`

Hooks:

- normalize email
- dedupe warning by email

### Lead

Fields:

- `name` required
- `email`
- `phone`
- `company_name`
- `source`
- `score`
- `owner_id`
- `status`
- `lost_reason_id`

Lifecycle:

- `new -> contacted -> qualified -> converted`
- `contacted -> disqualified`

Hooks:

- validate contact method
- normalize email/phone
- score lead

Actions:

- `convert_lead`

### Opportunity

Fields:

- `name` required
- `company_id` ref Company
- `primary_contact_id` ref Contact
- `amount`
- `currency`
- `expected_close_date`
- `probability`
- `stage`
- `owner_id`
- `lost_reason_id`

Lifecycle:

- `new -> qualified -> discovery -> proposal -> negotiation -> won/lost`

Hooks:

- validate required fields by stage
- require approval above discount threshold later
- create follow-up activity after stage changes

### Activity

Fields:

- `subject` required
- `body`
- `kind`: call/email/meeting/task
- `due_at`
- `status`: open/done/canceled
- `assigned_to`
- `related_resource`
- `related_id`

Potential issue: polymorphic references are convenient but weak at DB-level FK
enforcement. Alternative: first-class relationship table from Activity to target
object.

### Note

Fields:

- `body` required
- `related_resource`
- `related_id`

Same polymorphic-reference tension as Activity.

### PipelineStage

Fields:

- `name`
- `order`
- `maps_to_state`
- `is_terminal`

Question: Do stages live as data records, while lifecycle states live as config?
Likely yes. Stages are user-editable labels/order; lifecycle states are
enforceable machine semantics.

### LostReason

Fields:

- `name`
- `active`
- `applies_to`: lead/opportunity/both

## Table Strategy

Two plausible strategies:

### Strategy A: Table Per Resource

Each resource compiles to a physical table, e.g. `crm_leads`, `crm_companies`.

Pros:

- Natural Postgres constraints and FKs.
- Easy to understand for users.
- Good query performance and introspection.
- Fits “define tables/relationships” mental model.

Cons:

- Dynamic migrations are central complexity.
- Generic object APIs need metadata-driven query building.
- Cross-resource features like comments/audit need generic tables.

### Strategy B: Universal Object Table + JSONB

All resources share `objects` with `type` and JSONB payload.

Pros:

- Simple dynamic resource creation.
- Fewer migrations.
- Universal changeset engine is straightforward.

Cons:

- Harder DB-level constraints/FKs.
- Less transparent for users.
- More runtime validation.
- Weaker fit with the user's desire to expose DB constraints.

### Recommendation

Use **table per resource** for this prototype, plus universal platform tables
for audit, changesets, hooks, events, comments, attachments, and generic
relationships.

This best matches bundled Postgres and the desire to expose foreign keys and
database-level constraints as configuration.

## Applying the CRM Pack

CLI sketch:

```text
optctl pack preview packs/crm
optctl pack apply packs/crm
optctl resource describe lead
optctl db plan packs/crm
```

Preview should show:

- Tables to create.
- Columns to add.
- Constraints to create.
- Indexes to create.
- Hooks to register.
- Lifecycles/actions to register.
- Seed records to upsert.
- Warnings about destructive or unsupported changes.

## Removing From the Pack

Removing a field/resource is a config migration and must be safe by default.

Field removal:

1. Mark deprecated.
2. Stop writes.
3. Hide from default views.
4. Optional backfill/export.
5. Drop only with destructive confirmation.

Resource removal:

1. Mark resource deprecated.
2. Block creates.
3. Preserve read/query/audit.
4. Ensure no FK dependencies or live records, or require explicit
   cascade/archive plan.
5. Drop table only with destructive confirmation.

## Questions to Resolve Later

- Should resource config be YAML, CUE, or TypeScript-authored and compiled to
  JSON/YAML?
- How expressive can constraint expressions be without exposing unsafe raw SQL?
- How should polymorphic relationships like Activity target be represented while
  preserving FK constraints?
- Should scripts be embedded in packs, referenced by path, or bundled as
  content-addressed artifacts?
- How do we version resources and hooks so old audit records remain explainable?
