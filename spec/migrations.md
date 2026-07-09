# Migrations

## Status

This is the canonical spec for pack/resource migrations. Some implementation
details remain provisional and are called out explicitly.

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

- `ready`: can be applied according to its class rules.
- `blocked`: cannot be applied until data/config issues are resolved.
- `staged`: non-destructive staging has been applied; destructive cleanup not
  yet done.
- `applied`: completed.

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

Initial canonical shape:

```yaml
id: mig_123
from_revision: packrev_old
to_revision: packrev_new
plan_digest: sha256:...
status: blocked
summary:
  safe: 2
  risky: 3
  destructive: 4
  blocked: 3
changes:
  - id: chg_1
    class: destructive
    status: blocked
    kind: remove_field
    target:
      resource: lead
      field: company_name
    reason: field removed from desired config
    facts:
      present_values: 700
      references: [hook:convert_lead]
    stage_action: deprecate field and block writes
    cleanup_required: export_or_clear_values
    destructive_action: drop column
hazards:
  - code: DATA_LOSS
    severity: blocking
    change: chg_1
    message: Dropping lead.company_name would discard present values.
blockers:
  - change: chg_1
    code: PRESENT_VALUES
    count: 700
stages:
  - id: stage_1
    kind: staging
    changes: [chg_1]
    operations:
      - mark field deprecated
      - block writes to field
confirmations: []
```

## Staging Metadata

Staging should be represented in platform metadata, not by immediately changing
user tables destructively.

### Resource staging fields

For each resource definition/revision:

- `deprecated`: resource should not be used for new designs.
- `create_blocked`: new object creation is blocked.
- `read_allowed`: reads remain allowed by default.
- `query_allowed`: queries remain allowed by default.
- `archive_required_before_drop`: destructive cleanup cannot drop until active
  rows are gone.
- `replacement_resource`: optional pointer to replacement resource.

### Field staging fields

For fields:

- `deprecated`: field should not be used in new configs/actions/AXI.
- `write_blocked`: changesets cannot set/update this field.
- `read_allowed`: reads remain allowed by default.
- `export_required_before_drop`: require export before destructive cleanup, if
  configured.
- `replacement_field`: optional pointer to replacement field.

### Action/hook/lifecycle staging

- actions can be `deprecated` and hidden from default `optctl` action lists.
- hooks can be retained for historical audit while detached from new flows.
- lifecycle states can be `deprecated` so new transitions into them are blocked
  while existing rows remain readable.

### AXI behavior

Deprecated items should be hidden from default list/detail guidance but
discoverable through metadata commands with flags such as
`--include-deprecated`.

## Rename Support

Renames are hard to detect safely. A removed thing plus an added thing may be a
rename, but it may also be two separate changes.

### Proposal

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

Treat type changes as destructive by default unless explicitly allowlisted as
widening or supported as a generated staged cast.

### Initial rules

Safe/risky allowlist may include:

- `integer -> decimal`: risky, validate/backfill.
- `string(maxLength: smaller) -> string(maxLength: larger)`: safe/risky
  depending on operational behavior.

Generated staged casts supported initially:

- `integer -> string`
- `integer -> decimal`
- `decimal -> string`

Everything else is invalid/blocking as an in-place type change. The agent
workaround is to add a new field with the desired type, populate it using
ordinary changesets or an action/hook-generated changeset, update
readers/writers/AXI, and then remove the old field in a later migration.

### Staged type-change mechanics

For destructive type changes:

1. Add replacement field/column with new type.
2. Backfill replacement from old value using explicit conversion behavior.
3. Validate replacement completeness and conversion errors.
4. Update reads/writes/actions/hooks/AXI to use replacement.
5. Deprecate old field.
6. Later destructive cleanup drops old field and optionally renames replacement.

Migration cleanup/backfill should use ordinary changesets. Do not introduce a
separate migration cleanup DSL. A migration can surface blockers and suggested
cleanup operations, but the actual data changes should flow through the same
preview/commit/audit/policy path as any other write.

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

A token should bind to:

- migration id
- plan digest
- destructive step ids
- actor/session, if useful
- expiration, if useful

Example:

```text
mig_123:sha256:abc123:drop-deprecated-fields
```

If the migration plan changes, data blockers change materially, or destructive
steps change, the digest changes and the old token is invalid.

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
- comments/attachments/audit metadata referencing resource ids, where relevant.

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

Returns migration plan with classes, statuses, hazards, blockers, and suggested
stages.

### Apply safe changes

If all changes are safe and ready:

```text
optctl migration apply mig_123 --safe
```

### Review risky changes

```text
optctl migration inspect mig_123
optctl migration inspect mig_123 --sql
optctl migration validate mig_123
optctl migration apply mig_123 --reviewed
```

### Resolve blockers

```text
optctl migration inspect mig_123 --violations
optctl changeset preview --file cleanup.yaml
optctl changeset commit cs_456
optctl migration validate mig_123
```

### Stage destructive changes

```text
optctl migration plan mig_123 --stage-deprecations
optctl migration apply mig_123 --stage 1
```

### Destructive cleanup

```text
optctl migration preview-drop mig_123
optctl migration apply mig_123 --confirm mig_123:sha256:abc123:drop-deprecated-fields
```

## Prototype Evidence

Executable prototypes live in `prototypes/migration/`:

- strict pack diff classification
- broad edge fixture covering implemented issue types
- PGlite destructive migration walkthrough with CRM-flavored data and generic
  migration code
- combined end-to-end pack diff + PGlite execution walkthrough from `crm-v1` to
  `crm-v2`

## Provisional Details

The migration lifecycle is spec-level. These implementation details remain open:

- Exact migration plan JSON schema field names.
- Exact cleanup/backfill command UX around ordinary changesets.
- Whether migration plans are themselves resources.
- Table size thresholds for operational hazards.
- Whether confirmation tokens expire.
