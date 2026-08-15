<!-- generated-by: pi-dag-workflow/project-model; view: view-disposition-crm-migration-prototype; contract: 1; input: sha256:dbb02ef76c72d219b6bf7da0f14f4af677b749876989053cb1a10adcfe920891 -->

# CRM Migration Prototype Evidence

Generated non-normative disposition view preserving the complete reviewed legacy source for auditability.

## Migration disposition

<a id="obj-com-disposition-crm-migration-prototype"></a>

### Disposition — CRM Migration Prototype Evidence

**Migration disposition.** This source is preserved literally below for auditability at `sha256:63ebbba102e821aab22b4831ff1eb483c4e750427d23c7e3f712599eb47dd830`, but remains non-normative historical, supporting research, prototype evidence, roadmap, or superseded planning material. Only separately accepted current project-model objects carry product authority.

> **Status:** supporting prototype evidence. Open questions and old CLI examples
> here do not override the frozen migration, staging, and pack identity specs.

## Status

Supporting executable evidence for the canonical [Migrations](migrations.md)
spec.

## Executable Prototype

There are executable Deno prototypes at:

- `prototypes/migration/migration-prototype.ts`
- `prototypes/migration/scenarios/safe-additive.json`
- `prototypes/migration/scenarios/breaking-crm.json`
- `prototypes/migration/packs/crm-v1/`
- `prototypes/migration/packs/crm-v2/`
- `prototypes/migration/packs/live-facts.json`
- `prototypes/migration/packs/crm-edge-v1/`
- `prototypes/migration/packs/crm-edge-v2/`
- `prototypes/migration/packs/edge-live-facts.json`
- `prototypes/migration/migration-prototype.test.ts`
- `prototypes/migration/pglite-destructive-prototype.ts`
- `prototypes/migration/pglite-destructive-prototype.test.ts`
- `prototypes/migration/e2e-pack-pglite-prototype.ts`
- `prototypes/migration/e2e-pack-pglite-prototype.test.ts`
- `prototypes/migration/complex-cast-workaround-prototype.ts`
- `prototypes/migration/complex-cast-workaround-prototype.test.ts`

Run scenario mode:

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts prototypes/migration/scenarios/breaking-crm.json
```

Run end-to-end pack diff mode:

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts diff-packs prototypes/migration/packs/crm-v1 prototypes/migration/packs/crm-v2 prototypes/migration/packs/live-facts.json
```

Run broad edge-case pack diff mode:

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts diff-packs prototypes/migration/packs/crm-edge-v1 prototypes/migration/packs/crm-edge-v2 prototypes/migration/packs/edge-live-facts.json
```

Run combined pack diff + PGlite end-to-end walkthrough:

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/e2e-pack-pglite-prototype.ts
```

Run unsupported complex cast workaround walkthrough:

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/complex-cast-workaround-prototype.ts
```

Run PGlite destructive migration walkthrough:

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/pglite-destructive-prototype.ts
```

Test:

```bash
deno test --allow-read prototypes/migration/migration-prototype.test.ts
```

Full prototype test suite, including PGlite:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/migration/migration-prototype.test.ts prototypes/migration/pglite-destructive-prototype.test.ts prototypes/migration/e2e-pack-pglite-prototype.test.ts prototypes/migration/complex-cast-workaround-prototype.test.ts
```

## Purpose

Prototype how the platform can detect safe, risky, and destructive resource
migration issues without complex prediction or fragile calculations. The goal is
practical classification and guided back-and-forth with the user/agent.

## Principle

Do not try to perfectly predict every Postgres operational detail. Instead:

1. Diff normalized configs.
2. Map each diff to known migration primitives.
3. Apply simple conservative rules.
4. Query live database facts only when needed.
5. Surface clear hazards and required decisions.
6. Default breaking changes to staged/deprecated states.

This gives useful safety without building a full database migration research
engine.

## CRM Baseline

Assume an installed CRM pack with resource tables:

- `crm_companies`
- `crm_contacts`
- `crm_leads`
- `crm_opportunities`
- `crm_activities`
- `crm_lost_reasons`
- `crm_pipeline_stages`

All resources have generated system fields:

- `id`
- `created_at`
- `updated_at`
- `archived_at`
- `archived_by`
- `created_by`
- `updated_by`
- `version`

## Migration Detection Model

### Inputs

- Current active pack/resource config revision.
- Desired uploaded pack/resource config revision.
- Current live DB schema introspection.
- Simple live DB facts:
  - table exists
  - row count
  - column exists
  - count of rows where a predicate fails
  - count of references/dependencies
- Resource graph:
  - fields
  - relationships/FKs
  - actions
  - hooks
  - lifecycles
  - AXI guidance references

### Output

A migration preview containing:

- `summary`
- `changes[]`
- `hazards[]`
- `violations[]`
- `required_decisions[]`
- `suggested_plan[]`
- `confirmation_required`
- `plan_digest`

## Simple Classification Rules

### Resource-level changes

#### Add resource

Example: add `quote`.

Detection:

- desired resource exists, current resource absent.

Classification:

- safe if generated table name is unused.
- risky if table name already exists but is unmanaged.

Required facts:

- table existence check.

Default action:

- create table.

#### Remove resource

Example: remove `lead`.

Detection:

- current resource exists, desired resource absent.

Classification:

- destructive if table has any rows.
- destructive if any action/hook/relationship/lifecycle/AXI reference points to
  it.
- safe only if table has zero rows and no dependencies, but still requires
  explicit confirmation because the API shape is removed.

Required facts:

- row count.
- dependency graph.

Default action:

- mark resource deprecated.
- block creates.
- keep reads/query/export.
- require explicit later drop.

#### Rename-like resource changes

Example: `opportunity` removed and `deal` added.

Detection:

- no rename detection in v1.
- the platform treats this as one removed resource plus one added resource.

Classification:

- added resource: safe/risky depending on existing table facts.
- removed resource: destructive; blocked until data/dependencies are resolved.

Default action:

- users who want rename-like behavior should add the new resource, copy data
  explicitly through changesets/backfill, update references, deprecate the old
  resource, and later drop it through destructive cleanup.

### Field-level changes

#### Add optional field

Example: add `opportunity.competitor`.

Detection:

- desired field exists, current absent, `required` omitted.

Classification:

- safe.

Required facts:

- column name unused.

Default action:

- `ALTER TABLE ADD COLUMN`.

#### Add required field

Example: add required `lead.source`.

Detection:

- desired field exists, current absent, `required: true`.

Classification:

- safe if table row count is zero.
- risky if default/backfill provided.
- destructive/blocking if table has rows and no default/backfill.

Required facts:

- row count.
- default/backfill availability.

Default action:

- if rows exist, require staged plan:
  1. add optional field
  2. backfill
  3. validate no missing values
  4. make required

#### Remove field

Example: remove `lead.score`.

Detection:

- current field exists, desired absent.

Classification:

- destructive if any row has a present value.
- breaking if actions/hooks/AXI/expressions reference it.
- still breaking even if no values, because API shape changes.

Required facts:

- count rows where field is present.
- reference graph.

Default action:

- mark field deprecated.
- hide from default list/detail.
- block new writes to field.
- preserve reads/export.
- require explicit drop with confirmation token.

#### Rename-like field changes

Example: `company.domain` removed and `company.website_domain` added.

Detection:

- no rename detection in v1.
- the platform treats this as one removed field plus one added field.

Classification:

- added field: safe/risky/blocking depending on requiredness and existing rows.
- removed field: destructive; blocked until present values/dependencies are
  resolved.

Default staged plan:

1. add new field.
2. copy/backfill from old field explicitly through cleanup/backfill flow if
   desired.
3. switch reads/AXI/actions/hooks.
4. deprecate old field.
5. drop old field later through destructive cleanup.

#### Change field type

Example: `opportunity.amount` decimal -> integer.

Detection:

- same field name, type differs.

Classification:

- safe only for known widening changes, if any are explicitly supported.
- risky for compatible casts that need validation.
- destructive for narrowing/incompatible changes.

Simple initial rule:

- treat all type changes as risky/destructive unless the platform has an
  explicit allowlist.

Allowed initial widening examples may include:

- `string(maxLength: 120)` -> `string(maxLength: 240)`
- `integer` -> `decimal`

Required facts:

- count values that cannot cast/fit.

#### Make optional field required

Example: `contact.email` becomes required.

Detection:

- current field required omitted, desired `required: true`.

Classification:

- safe if zero rows violate.
- risky because validation scan is required.
- blocking if violating rows exist.

Required facts:

- count rows where `present(email)` is false.

Default action:

- add NOT VALID check / validate / set required only after no violations.

#### Make required field optional

Detection:

- current `required: true`, desired required omitted.

Classification:

- safe from data-loss perspective.
- backward-compatible for writes, but may affect assumptions in hooks/actions.
- risky if expressions/hooks/actions assume presence.

Required facts:

- reference graph.

Default action:

- allow but warn if hooks/actions/lifecycle guards reference field without
  `present()`.

### Constraint/index changes

#### Add non-unique index

Classification:

- safe for small tables.
- operational hazard for large tables.

Required facts:

- row count/table size estimate.

Default action:

- use `CREATE INDEX CONCURRENTLY` in Postgres mode where possible.

#### Add unique index/constraint

Example: unique `contact.email` where `present(email)`.

Classification:

- risky; requires duplicate scan.
- blocking if duplicates exist.

Required facts:

- duplicate count/query.

Default action:

- preview duplicates summary.
- require data cleanup before apply.

#### Add check constraint

Example: `amount >= 0`.

Classification:

- risky; requires violation scan.
- blocking if violations exist.

Default action:

- add `NOT VALID`, validate, then enforce if supported.

#### Add foreign key

Example: `opportunity.company_id -> company.id`.

Classification:

- risky; requires orphan scan.
- blocking if orphan rows exist.
- operational hazard on large tables.

Default action:

- add `NOT VALID`, validate, then enforce if supported.

#### Remove constraint/index

Classification:

- non-data-destructive but may weaken correctness/performance.
- risky if pack/actions rely on the constraint.

Default action:

- allow with warning for non-unique indexes.
- require confirmation for removing uniqueness/FK/check constraints because
  correctness is weakened.

### Lifecycle changes

#### Add state

Classification:

- safe.

#### Remove state

Classification:

- destructive/breaking if any object currently has that state.
- breaking if actions/hooks/AXI reference it.

Required facts:

- count rows by removed state.
- reference graph.

Default action:

- require state migration map, e.g. `old_state -> new_state`.

#### Add transition

Classification:

- safe unless it bypasses required approvals/policies.

#### Remove transition

Classification:

- usually safe for data, but behavior-breaking.
- risky if active workflows/actions depend on it.

Required facts:

- action/hook refs.

### Hook/action changes

#### Add hook/action

Classification:

- safe if not attached to existing critical path.
- risky if attached to existing create/update/transition path because it can
  start blocking writes.

Required facts:

- attachment point.

Default action:

- preview affected write paths.

#### Remove hook/action

Classification:

- breaking if referenced.
- safe only if unreferenced.

Required facts:

- reference graph.

#### Change hook script

Classification:

- risky if hook participates in validation/commit.
- lower risk if after-commit side effect only.

Default action:

- record new digest.
- show old/new digest.
- optionally run sample validation fixtures if present.

## CRM Breaking Migration Walkthrough

### Scenario

User wants to replace `lead` with a new model:

- remove `lead.score`
- rename `lead.company_name` to `lead.organization_name`
- make `lead.email` required
- remove lifecycle state `contacted`
- add unique partial index on `lead.email`
- change `convert_lead` hook

### Step 1: Agent uploads desired pack

```text
optctl pack preview ./packs/crm-v2
```

### Step 2: Server returns migration preview

```toon
migration_preview:
plan: mig_123
classification: destructive
summary: 6 changes, 2 blocking violations, 3 destructive changes, 2 operational hazards
changes[6]{id,type,target,class}:
field_remove,field,crm.lead.score,destructive
field_rename,field,crm.lead.company_name -> crm.lead.organization_name,destructive
required_add,field,crm.lead.email,risky
state_remove,lifecycle,crm.lead.contacted,destructive
index_add,index,lead_email_unique_when_present,risky
hook_update,hook,crm.convert_lead,risky
violations[2]{change,count,example}:
required_add,128,email missing on existing leads
index_add,7,duplicate email values
hazards[2]{code,severity,message}:
VALIDATION_SCAN,warning,Adding required email and unique index scans crm_leads
HOOK_BEHAVIOR_CHANGE,warning,convert_lead commit hook digest changed
required_decisions[4]:
Provide migration for company_name -> organization_name
Resolve 128 leads missing email or keep email optional
Resolve 7 duplicate email values before unique index
Map removed state contacted to another state
help[4]:
Run `optctl migration inspect mig_123 --violations`
Run `optctl migration plan mig_123 --stage-deprecations`
Run `optctl migration export mig_123 --affected crm.lead`
Run `optctl metadata resource crm.lead`
```

### Step 3: Agent asks for details

```text
optctl migration inspect mig_123 --violations
```

Output includes capped samples and exact predicates:

```toon
violations:
missing_email[128]{id,name,status}:
lead_1,Alice,new
lead_2,Bob,contacted
duplicate_email_groups[7]{email,count}:
sales@example.com,3
info@example.com,2
state_contacted[42]{id,name}:
lead_9,Acme inbound
help[3]:
Run `optctl list crm.lead --where 'status == "contacted"'`
Run `optctl changeset preview --file fix-leads.yaml`
Run `optctl migration plan mig_123 --state-map contacted=qualified`
```

### Step 4: Agent proposes staged plan

```text
optctl migration plan mig_123 \
  --rename-field crm.lead.company_name=organization_name \
  --stage-remove-field crm.lead.score \
  --state-map contacted=qualified \
  --defer-required crm.lead.email \
  --defer-index lead_email_unique_when_present
```

### Step 5: Server creates staged migration

```toon
migration_plan:
id: mig_123
mode: staged
steps[7]{order,action,class}:
1,add field crm.lead.organization_name,safe
2,backfill organization_name from company_name,risky
3,deprecate field crm.lead.company_name,destructive-staged
4,deprecate field crm.lead.score,destructive-staged
5,map lifecycle state contacted -> qualified,risky
6,leave email optional until violations resolved,blocked-deferred
7,defer unique email index until duplicates resolved,blocked-deferred
confirmation_required: false
help[3]:
Run `optctl migration apply mig_123 --stage 1`
Run `optctl changeset preview --file cleanup-missing-emails.yaml`
Run `optctl migration status mig_123`
```

### Step 6: Agent applies non-destructive stage

```text
optctl migration apply mig_123 --stage 1
```

This applies additive/backfill/deprecation steps, but does not drop columns or
enforce blocked constraints.

### Step 7: Agent fixes data

Agent uses changesets to fill missing emails and dedupe duplicates. These are
normal business-object changes, not raw SQL.

```text
optctl changeset preview --file cleanup-leads.yaml
optctl changeset commit cs_456
```

### Step 8: Agent revalidates migration

```text
optctl migration validate mig_123
```

```toon
migration_validation:
id: mig_123
blocking_violations: 0
ready_steps[2]:
make crm.lead.email required
create unique index lead_email_unique_when_present
help[2]:
Run `optctl migration apply mig_123 --remaining`
Run `optctl migration inspect mig_123 --sql`
```

### Step 9: Destructive cleanup requires token

Dropping deprecated fields still requires explicit confirmation tied to plan
digest.

```text
optctl migration preview-drop mig_123
```

```toon
destructive_confirmation:
plan: mig_123
digest: sha256:abc123
drops[2]{target,rows_with_values,export_available}:
crm.lead.company_name,0,true
crm.lead.score,913,true
confirmation: mig_123:sha256:abc123:drop-deprecated-fields
help[2]:
Run `optctl migration export mig_123 --targets crm.lead.score`
Run `optctl migration apply mig_123 --confirm mig_123:sha256:abc123:drop-deprecated-fields`
```

### Step 10: Apply destructive cleanup

```text
optctl migration apply mig_123 --confirm mig_123:sha256:abc123:drop-deprecated-fields
```

Audit records include:

- actor
- plan digest
- confirmation token
- before/after config revisions
- SQL/operation steps
- affected row counts
- export artifact ids if generated

## What This Prototype Shows

1. We can classify most changes with simple diff rules plus a few live DB
   queries. The executable edge fixture now exercises every migration issue type
   currently implemented by the prototype.
2. A real PGlite walkthrough confirms that destructive changes can be staged
   generically: deprecate/block first, add replacement columns/backfill for
   supported generated type casts, validate blockers, perform user/agent cleanup
   through ordinary changesets, then require digest-bound confirmation before
   dropping columns/tables.
3. We do not need perfect cost prediction. We need conservative hazard flags.
4. Removing things is destructive/breaking by default, even if data is empty,
   because API shape changes.
5. Adding constraints is usually risky, not immediately destructive, because it
   depends on existing data.
6. Staging/deprecation lets agents make progress on large breaking migrations
   without doing dangerous operations first.
7. Confirmation tokens should be tied to exact plan digests to prevent
   accidental mismatched confirmations.
8. Data cleanup should happen through normal changesets where possible,
   preserving audit and policy behavior.

## Questions recorded during the prototype

- How do we define table-size thresholds for operational hazards?
- Should destructive cleanup always require export artifact generation first?
- Can hooks provide migration fixtures for validating changed behavior?
- Should migration plans be represented as first-class resources?
