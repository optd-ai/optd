<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-migrations; contract: 1; input: sha256:af8bb58c97d2af30cdf2daba69d79e05245b77dfca7b8013d1c63e4a7b58622e -->

# Migrations

Generated exact-contract projection imported into project-model/model.json from the reviewed migrations.md source.

## Exact migrated contract

<a id="obj-com-exact-migrations-v1"></a>

### Exact v1 contract — Migrations

**Migration provenance.** Exact normative contract imported from `spec/migrations.md` at `sha256:b9a579733be1c15e4cf2bc1004586f4105b34bf41ca7b06715df32253f71f8de`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Status

This is the canonical spec for pack/resource migrations.

## Purpose

Migrations reconcile an active pack/resource configuration with a desired
pack/resource configuration while protecting data, API compatibility,
auditability, and operational safety.

## Core Model

Migration classification uses two separate concepts:

```text
class: what kind of change this is
status: whether it can proceed right now
```

### Classes

- `safe`: additive, compatible, low hazard.
- `risky`: no expected data loss, but needs validation/review/hazard awareness.
- `destructive`: removes or breaks data/API/behavior, or cannot safely roll back
  without backup/export.

### Statuses

- `ready`: the complete plan can be applied atomically according to its class.
- `blocked`: the complete plan cannot apply until data/config issues are
  resolved or an explicit intermediate pack revision is applied first.
- `applied`: the whole plan completed in one transaction.

Failed apply attempts are append-only attempt/audit records, not plan statuses.
There is no partially applied/staged migration-plan state.

Example: removing a field with present values is `class: destructive`,
`status: blocked`. The destructiveness is intrinsic; blocked is current
readiness.

## Migration Plan Object Model

The migration plan object is not only an internal code detail. It is the durable
review/audit/coordination object shared by:

- API responses
- `optctl migration ...` commands
- UI/review surfaces later
- audit log records
- confirmation-token generation
- migration execution

The exact top-level shape is frozen below. Illustrative fragment:

```yaml
schema_version: migration.plan.v1
id: 019b7a2e-7c10-7000-8000-000000000001
publisher: optd
pack: crm
from_pack_revision_id: 019b7a2e-7c10-7000-8000-000000000002
to_pack_revision_id: 019b7a2e-7c10-7000-8000-000000000003
candidate_source_digest: sha256:...
plan_digest: sha256:...
class: destructive
status: blocked
summary: { safe: 2, risky: 3, destructive: 4, blocked: 3 }
changes:
  - id: 019b7a2e-7c10-7000-8000-000000000004
    class: destructive
    status: blocked
    kind: remove_field
    target: { resource: optd/crm:lead, field: company_name }
    reason: field removed from desired config
    facts: { present_values: 700, references: [optd/crm:convert_lead] }
    hazard_codes: [DATA_LOSS]
    intermediate_revision_guidance: add replacement field and block/dual-write old field
    cleanup_required: export_or_clear_values
    destructive_action: drop column
hazards:
  - code: DATA_LOSS
    severity: blocking
    change_id: 019b7a2e-7c10-7000-8000-000000000004
    message: Dropping lead.company_name would discard present values.
blockers:
  - change_id: 019b7a2e-7c10-7000-8000-000000000004
    code: PRESENT_VALUES
    count: 700
    message: Existing values must be explicitly cleaned up.
steps:
  - id: 019b7a2e-7c10-7000-8000-000000000005
    kind: drop_column
    change_ids: [019b7a2e-7c10-7000-8000-000000000004]
live_facts_digest: sha256:...
last_validation: null
application: null
```

## Explicit intermediate revisions

One migration plan never installs a hidden transitional/staged schema. If safe
cleanup cannot happen under the current schema, the author applies an explicit
intermediate pack revision first—for example, add a replacement field and
validation/normalization hooks that block or dual-write the old field. Ordinary
changesets then backfill/clean data. The final pack revision is previewed as a
new plan and applies atomically only when blockers are gone.

This deliberately moves complexity for genuinely complex upgrades into visible,
versioned pack source rather than a partially applied server plan. There is no
built-in `deprecated`, `write_blocked`, shadow-table, or dual-write migration
mode; a pack may express transitional validation/behavior through its normal
strict resource/hook/action definitions and AXI guidance.

## Rename Support

Renames are hard to detect safely. A removed thing plus an added thing may be a
rename, but it may also be two separate changes.

### V1 decision

Do **not** support automatic renames in v1.

The platform should not detect, infer, warn on, or execute likely renames in v1.
A removed field/resource and an added field/resource are separate changes.

Recommended user flow:

1. Add the new resource/field.
2. Backfill/copy data from the old resource/field using changesets or a
   migration cleanup/backfill mechanism.
3. Update actions/hooks/AXI to use the new name.
4. Deprecate the old resource/field.
5. Later perform destructive cleanup to drop the old resource/field.

This avoids hidden destructive behavior and keeps migration intent explicit.

### Possible future support

Later, migration directives could support explicit renames, but that should be a
migration feature, not inferred from resource config:

```yaml
kind: MigrationDirective
spec:
  renameField:
    resource: lead
    from: company_name
    to: organization_name
```

## Type Changes

Every field `type` change is destructive/API-breaking and blocked as an in-place
MVP change. Increasing a string `maxLength` without changing type is
semantically compatible but classed risky when generated constraint DDL
scans/locks, otherwise safe.

Type conversion uses explicit revisions: add a new field with the desired type
in an atomic intermediate revision, populate it with ordinary changesets or an
action, update readers/writers/hooks/AXI in source, then preview a later final
revision that removes the old field. The server does not infer conversion,
rename the replacement, or run an automatic cast/backfill DSL.

Migration cleanup/backfill should use ordinary changesets. Do not introduce a
separate migration cleanup DSL. A migration can surface blockers and suggested
cleanup operations, but the actual data changes should flow through the same
stage/commit/audit/policy path as any other write.

Initial cleanup/backfill strategy:

- Agents generate ordinary changesets to resolve migration blockers.
- The platform may provide suggested changeset templates, but the write
  mechanism is unchanged.
- Bulk cleanup is not a special migration operation initially; agents can
  generate scoped changesets, and later product work can add ergonomic bulk
  changeset helpers.
- Backups/exports are separate operational commands an agent may choose to run
  before risky/destructive cleanup; they are not migration commands.

## Confirmation Token Purpose

A confirmation token prevents accidental or stale destructive execution.

It proves the user/agent is confirming the exact destructive plan they
previewed, not a different plan produced after config/data changed.

The opaque token binds to migration ID, plan digest, live-facts digest,
destructive change IDs, issuing principal/authorization root, and the configured
expiry exactly as frozen below. It is not a human-constructed digest string. If
plan/data facts/destructive steps change, the old token is invalid.

## Hazard Codes

Initial hazard codes:

- `DATA_LOSS`: data may be dropped, cleared, coerced, or made unreachable.
- `API_BREAK`: resource/field/action shape changes in a way existing
  clients/agents may not understand.
- `REFERENCE_BREAK`: actions, hooks, expressions, relationships, lifecycles, or
  AXI guidance reference a removed/changed item.
- `VALIDATION_SCAN`: applying the change requires scanning existing rows.
- `DUPLICATE_VALUES`: unique constraint/index would fail due to duplicate data.
- `ORPHANED_REFERENCES`: foreign key/reference constraint would fail due to
  orphaned rows.
- `STATE_IN_USE`: lifecycle state cannot be removed because existing rows use
  it.
- `INDEX_BUILD`: index creation may consume CPU/time.
- `EXCLUSIVE_LOCK`: operation may require a blocking lock.
- `TABLE_REWRITE`: operation may rewrite a table.
- `HOOK_BEHAVIOR_CHANGE`: validation/commit hook changed and may alter write
  behavior.
- `ACTION_CONTRACT_CHANGE`: action input/availability/behavior changed.
- `IRREVERSIBLE`: rollback would require backup/export or manual reconstruction.

## Dependency Graph Purpose

The dependency graph exists primarily to calculate migration risk and produce
useful guidance.

It answers: “What will break or need updating if this thing changes?”

Edges include:

- field references from resource fields (`ref`).
- relationship definitions referencing resources/fields.
- lifecycle definitions referencing state fields/states/transitions.
- action input schemas referencing resources/fields.
- action behavior referencing hooks.
- hook input mappings referencing fields/relationships.
- expressions referencing fields/states.
- indexes/constraints referencing fields.
- AXI guidance referencing fields/actions/resources.
- comments/audit/event metadata referencing resource identities, where relevant.

Use cases:

- Removing `lead.score` can report references from `axi.list`,
  `hook:score_lead`, and expressions.
- Removing hook `convert_lead` can report `action:convert_lead` still uses it.
- Removing lifecycle state `contacted` can report rows in that state and actions
  that transition from it.
- Removing resource `company` can report fields/relationships/actions that
  reference it.

The graph should not need complex inference at first. It can be built from
normalized config references and simple database facts.

## Command Flow

### Preview

```text
optctl pack preview ./packs/crm-v2
```

Returns the atomic migration plan with classes, hazards, blockers, and any
suggested cleanup/intermediate-revision guidance.

### Apply safe changes

If all changes are safe and ready:

```text
optctl migration apply <migration-id> --safe
```

### Review risky changes

```text
optctl migration inspect <migration-id>
optctl migration inspect <migration-id> --sql
optctl migration validate <migration-id>
optctl migration apply <migration-id> --reviewed
```

### Resolve blockers

```text
optctl migration inspect <migration-id> --violations
optctl changeset stage --input cleanup.json
optctl changeset commit <stage-id>
optctl migration validate <migration-id>
```

### Use an intermediate revision when blocked

```text
optctl pack preview ./packs/crm-v1.1-transition
optctl pack apply ./packs/crm-v1.1-transition --reviewed
optctl changeset stage --input cleanup.json
optctl changeset commit <stage-id>
optctl pack preview ./packs/crm-v2
```

### Destructive cleanup

```text
optctl migration inspect <migration-id> --sql
optctl migration validate <migration-id> --json
optctl migration apply <migration-id> --confirm-token <opaque-token>
```

## Prototype Evidence

Executable prototypes live in `prototypes/migration/`:

- strict pack diff classification
- broad edge fixture covering implemented issue types
- PGlite destructive migration walkthrough with CRM-flavored data and generic
  migration code
- combined end-to-end pack diff + PGlite execution walkthrough from `crm-v1` to
  `crm-v2`

## Frozen migration-plan DTO

Migration plans are durable built-in system resources with immutable plan
content and separate append-only validations/application result. IDs are UUIDv7.
The canonical `migration.plan.v1` data shape is:

```text
id, schema_version, publisher, pack,
from_pack_revision_id|null, to_pack_revision_id,
candidate_source_digest, plan_digest, created_auth_context_id, created_at,
class, status, summary,
changes[], hazards[], blockers[], steps[],
live_facts_digest, last_validation|null, application|null
```

- `class`: highest intrinsic `safe|risky|destructive` class.
- `status`: `ready|blocked|applied`; validation may change computed
  readiness/facts but never rewrites immutable plan content.
- `summary`: exact counts by class/status/hazard severity.
- `changes[]`: ordered by canonical target then kind and contains UUID `id`,
  `kind`, `class`, `status`, structured target identity, reason, facts,
  hazard-code references, intermediate-revision guidance, cleanup requirement,
  and destructive action. Inapplicable fields are explicit `null`, not omitted
  aliases.
- `hazards[]`: ordered objects with stable uppercase `code`, `warning|blocking`
  severity, change ID, and safe message.
- `blockers[]`: ordered objects with change ID, stable uppercase code, current
  count/fact value, and safe message.
- `steps[]`: canonically ordered SQL/metadata step descriptors for the one
  atomic transaction. SQL text is served only by the authorized `/sql` route,
  not duplicated throughout the plan.
- `live_facts_digest`: SHA-256 over canonical planner-visible live facts.
- `last_validation` and `application` are projections from append-only records,
  so inspect APIs return one complete current representation.

Unknown fields/enum values are rejected. Canonical array ordering participates
in `plan_digest` using RFC 8785 JSON and SHA-256.

## Cleanup UX

There is no migration-specific cleanup/backfill mutation command. The migration
inspection/violations endpoints expose structured blockers and suggested
ordinary operation templates; agents author normal changeset stage/commit input.
After cleanup under the same active pack revision,
`optctl migration validate
<id>` refreshes live facts/readiness. If cleanup
required an intermediate pack revision, the old plan's `from_pack_revision_id`
is stale and the final desired revision must be previewed into a new plan.

## Operational hazard size

No row/byte threshold changes safety class in MVP. Scan, rewrite, or strong-lock
operations are intrinsically risky as frozen in
[Migration Classification](migration-classification.md); current relation
statistics are still reported.

## Atomic application request

The apply route executes the complete ready plan in one Postgres transaction:

```json
{
  "acknowledgement": "reviewed",
  "confirmation_token": null,
  "lock_timeout": "10s"
}
```

- `acknowledgement` is required: `safe` for a safe plan, `reviewed` for risky,
  and `destructive` for destructive; weaker/mismatched values fail.
- `confirmation_token` is required only for destructive and otherwise must be
  null/omitted.
- `lock_timeout` is optional under the commit/apply lock-timeout contract.
- DDL, metadata, default assignments/grant carry-forward, and active-revision
  switch commit together or all roll back.
- Repeating a successfully applied plan returns its existing application result.

MVP does not pretend to provide zero-downtime/online migration automation.
Strong locks, scans, rewrites, and expected interruption are reported plainly.
The planner blocks unsafe work and requires explicit intermediate revisions; it
does not add partial plans, shadow tables, implicit dual writes, background copy
orchestration, or other false complexity.

## Destructive confirmation

`POST /migrations/{id}/validate` returns no confirmation for safe/risky plans.
For a currently ready destructive plan it may issue one opaque 256-bit
single-use confirmation token. Only its hash is stored. The token binds:

- migration ID and immutable plan digest;
- live-facts digest from that validation;
- exact destructive change IDs;
- issuing principal and authorization root;
- issuance and expiry, default 15 minutes and server-configurable.

`POST /migrations/{id}/apply` must include that token for destructive work.
Apply rechecks current authority and live facts under the pack/runtime locks;
any binding mismatch, expiry, prior use, or facts/plan change rejects it. Token
use and successful activation occur atomically. Safe/risky apply uses explicit
class-aware CLI flags but no confirmation token. Repeated apply after successful
activation returns the existing application result.
