# Historical CRM Prototype Flow

> **Status:** prototype walkthrough retained as evidence. Its preview commands,
> hook packaging questions, and identity examples are not normative.

## Decision

Use **bundled local Postgres** as the default simple deployment model. This
keeps the system straightforward to reason about because the platform can depend
on real Postgres semantics while still offering one-container/one-volume
ergonomics.

PGlite remains interesting for dev/demo/sandbox usage, but it is not the primary
design target.

## Prototype Goal

Demonstrate how a user or AI agent can build a fully headless CRM by applying
resource configuration and scripts rather than changing platform code.

The prototype should cover:

1. Add a new object/resource type.
2. Add schema constraints.
3. Add database-level constraints.
4. Add lifecycle states.
5. Add runtime validation scripts.
6. Add behavior hooks.
7. Preview and apply config changes.
8. Create and transition CRM objects through changesets.
9. Remove/deprecate resources safely.

## Example CRM Pack

See [CRM Pack Definition](crm-pack-definition.md) for the detailed configuration
primitive sketch.

A minimal CRM pack should include:

- `company`
- `contact`
- `lead`
- `opportunity`
- `activity`
- `note`
- `pipeline_stage`
- `lost_reason`

Later additions:

- `quote`
- `quote_line`
- `product`
- `campaign`
- `sales_team`
- `territory`

## Good End-to-End Example Flow

### Scenario

An AI sales agent imports a lead, validates it, enriches it, converts it into an
opportunity, advances it through a pipeline, and closes it as won/lost. All
behavior comes from resource configuration and scripts.

### Step 1: Apply Default CRM Pack

The user runs:

```text
optctl resource apply packs/crm/minimal.yaml
```

The platform previews:

- New resource types: `company`, `contact`, `lead`, `opportunity`, `activity`,
  `pipeline_stage`, `lost_reason`.
- New constraints.
- New lifecycle states.
- New hooks.
- Required indexes.
- Any migration impact.

Then commits the resource configuration.

### Step 2: Define `lead`

Conceptual resource shape:

```yaml
kind: Resource
apiVersion: operant.dev/v1
metadata:
  name: lead
spec:
  fields:
    name:
      type: string
      required: true
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
    owner:
      type: ref
      ref: user
    status:
      type: string
      default: new
  constraints:
    - name: lead_requires_contact_method
      type: check
      expression: "present(email) OR present(phone)"
      enforcement: database-preferred
    - name: unique_lead_email_when_present
      type: unique
      fields: [email]
      where: "present(email)"
  lifecycle:
    states: [new, contacted, qualified, disqualified, converted]
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
          fields: [lost_reason]
      - from: qualified
        to: converted
  hooks:
    validate:
      - path: hooks/crm/validate-lead.ts
    before_commit:
      - path: hooks/crm/normalize-lead.ts
    after_commit:
      - path: hooks/crm/notify-new-lead.ts
```

### Step 3: Runtime Validation Script

A validation script can enforce logic that is too contextual for static schema.

Example `hooks/crm/validate-lead.ts`:

```ts
const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const lead = envelope.input.proposed;
const errors = [];
const warnings = [];

if (!lead.email && !lead.phone) {
  errors.push({ field: "email", message: "Lead requires email or phone" });
}

if (lead.email && !lead.email.includes("@")) {
  errors.push({ field: "email", message: "Invalid email" });
}

if (!lead.company_name) {
  warnings.push({
    field: "company_name",
    message: "Company name improves conversion quality",
  });
}

console.log(JSON.stringify({
  allow: errors.length === 0,
  errors,
  warnings,
}));
```

### Step 4: Behavior Script

Example `hooks/crm/normalize-lead.ts`:

```ts
const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const email = envelope.input.proposed.email?.trim().toLowerCase();

console.log(JSON.stringify({
  allow: true,
  patches: email
    ? [
      { op: "set", path: "/email", value: email },
    ]
    : [],
}));
```

### Step 5: Agent Creates lead Through Changeset

```text
optctl changeset preview --intent create-lead --file lead.json
```

Preview returns:

- Object to create.
- Normalized fields.
- Validation warnings/errors.
- Constraint checks.
- Hooks that will run.
- Audit/event records that would be produced.

Then:

```text
optctl changeset commit <changeset-id>
```

### Step 6: Convert lead to opportunity

The agent submits an intention:

```yaml
intent: convert_lead
lead: lead_123
create:
  contact: true
  company: true
  opportunity: true
```

The changeset engine previews creation of:

- `contact`
- `company`
- `opportunity`
- Relationships among them
- lead transition to `converted`
- Initial follow-up `activity`

All of this can be driven by a transition hook on `lead.qualified -> converted`.

### Step 7: opportunity Lifecycle

`opportunity` lifecycle:

- `new`
- `qualified`
- `discovery`
- `proposal`
- `negotiation`
- `won`
- `lost`

Example rules:

- `proposal` requires `amount` and `close_date`.
- `negotiation` with discount above threshold requires approval.
- `won` requires linked company and primary contact.
- `lost` requires `lost_reason`.

### Step 8: Add a Custom Field Later

User adds a field to `opportunity`:

```yaml
kind: ResourcePatch
metadata:
  resource: opportunity
spec:
  addFields:
    competitor:
      type: string
      indexed: true
```

Preview shows:

- Adds optional field.
- Adds index.
- No existing data violations.
- Requires Postgres migration.

### Step 9: Add Custom Behavior Later

User adds hook:

```yaml
kind: ResourcePatch
metadata:
  resource: opportunity
spec:
  hooks:
    on_transition:
      - transition: proposal -> negotiation
        path: hooks/crm/discount-approval.ts
```

The hook can return:

```json
{
  "allow": true,
  "required_approvals": [
    { "role": "sales_manager", "reason": "Discount exceeds 20%" }
  ]
}
```

### Step 10: Remove or Deprecate a Resource

Resources should not be casually dropped when data exists.

Safe removal flow:

1. Mark resource as deprecated.
2. Hide from create actions.
3. Keep read/query/export available.
4. Run migration/export/archive changeset if desired.
5. Only allow hard removal after preview confirms no live objects or after
   explicit destructive approval.

Example:

```text
optctl resource deprecate lead
optctl resource remove lead --preview
optctl resource remove lead --commit --confirm-destructive
```

## Add / Validate / Behave / Remove Flow

### Add

- Write resource definition.
- Preview config.
- Validate config syntax.
- Validate backend capabilities.
- Generate migration plan.
- Apply config revision.

### Validate

- Schema validation.
- Database constraints.
- Runtime validation hooks.
- Lifecycle transition validation.
- Policy validation.

### Add Behavior

- Attach hooks to resource or transition.
- Define input/output contract.
- Version script/digest.
- Preview with sample object.
- Audit hook execution.

### Remove

- Deprecate first.
- Block new writes.
- Preserve reads/audit.
- Migrate/archive data.
- Require destructive confirmation for physical removal.

## Why This Is a Good Prototype

This flow exercises the core platform thesis:

- Resource definitions instead of hardcoded app models.
- Real database constraints where possible.
- Runtime scripts for domain behavior.
- Changeset preview/commit for every write.
- Auditable lifecycle transitions.
- Headless API/CLI-only CRM behavior.

## Configuration Primitive Direction

The CRM pack should likely be composed of:

- `Pack` manifest
- `Resource` definitions for table-backed objects
- `Relationship` definitions for many-to-many or metadata-bearing links
- Inline or separate `Lifecycle` definitions
- `Action` definitions for domain intentions like `convert_lead`
- `Hook` definitions for executable validation/behavior
- `Seed` definitions for pipeline stages and lost reasons

For the prototype, prefer table-per-resource storage plus universal platform
tables for changesets, audit, hooks, events, comments, attachments, and generic
relationships.

## Questions recorded during the historical prototype

- Should hooks patch the proposed object directly or emit additional changeset
  operations only?
- Should resource definitions be YAML, JSON, CUE, or TypeScript-generated
  config?
- How do we test hooks before applying them to production resources?
- Should default packs include scripts inline, as file paths, or as packaged
  bundles?
