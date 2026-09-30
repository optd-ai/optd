<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-migration-classification; contract: 1; input: sha256:ec7ab03b36a247f482637cf36f749c86f9395c277f1b93b319d5a6db18aae6f5 -->

# Migration Classification

Generated exact-contract projection imported into project-model/model.json from the reviewed migration-classification.md source.

## Exact migrated contract

<a id="obj-com-exact-migration-classification-v1"></a>

### Exact v1 contract — Migration Classification

**Migration provenance.** Exact normative contract imported from `spec/migration-classification.md` at `sha256:8ae2a4d42f2e975867343802a8096d95b797c8486f5bf1662a174b33737ddb3d`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Status

Normative for the canonical classification algorithm and frozen MVP decisions
referenced by [Migrations](migrations.md). The comparative tool survey remains
supporting research rather than product authority.

## Purpose

Define how the platform distinguishes non-destructive, risky, and destructive
resource schema changes without inventing everything from scratch.

## Research Summary

Relevant existing concepts and tools:

- **Postgres DDL behavior:** `ALTER TABLE`, constraints, and indexes have
  different locking/validation behavior. `CREATE INDEX CONCURRENTLY`,
  `NOT VALID` constraints, and later `VALIDATE CONSTRAINT` are important
  online-migration tools.
- **Stripe `pg-schema-diff`:** diffs desired/current Postgres schemas and
  generates migration plans with a hazards system warning about locks/downtime.
  It uses native Postgres online migration operations where possible and
  validates migration plans against a temporary database.
- **Xata `pgroll`:** focuses on zero-downtime, reversible Postgres migrations by
  keeping old and new schema versions working simultaneously. This is
  essentially expand/contract migration discipline with rollback safety.
- **sqldef:** declarative schema management: compare desired schema to current
  schema and generate DDL. Useful mental model for desired-state diffing.
- **Atlas:** uses dev databases/sandboxes for schema diffing, migration
  planning, and migration linting. Key idea: parse/plan against a real database,
  not just strings.
- **Liquibase preconditions:** migrations can declare checks evaluated before
  changes run. Useful for safety gates.
- **API backward compatibility rules:** compatibility is about whether old
  clients continue to work. For this project, that maps to whether existing
  data, existing hooks/actions, and existing API/CLI usage continue to work.

## Core Insight

“Destructive” is not one binary property. We should classify changes across
several dimensions:

1. **Data-loss risk:** will existing data be dropped, hidden, coerced, or made
   invalid?
2. **Backward compatibility:** will existing API/CLI/hooks/actions/queries still
   work?
3. **Constraint validity:** can existing rows satisfy the new schema/constraint?
4. **Operational hazard:** will Postgres need locks/table rewrites/long
   validation?
5. **Reversibility:** can we roll back without restoring from backup/export?

A change can be non-data-destructive but still operationally hazardous, e.g.
adding a large index. A change can be operationally easy but
backward-incompatible, e.g. renaming a field.

## Classification Research

### Safe / Additive

Definition: preserves existing data, preserves existing resource API shape, does
not invalidate existing rows, and has low operational hazard.

Examples:

- Add a new optional field.
- Add a new resource/table.
- Add a new action.
- Add a new hook not attached to existing write paths.
- Add AXI/help metadata.
- Add a new lifecycle transition that does not invalidate existing states.
- Add non-unique index concurrently on small/medium tables, subject to
  operational policy.

Default behavior: can be auto-applied after preview.

### Risky / Requires Validation

Definition: may be safe depending on existing data size/content or Postgres
execution plan.

Examples:

- Add required field to an empty table.
- Add required field with a default/backfill plan.
- Add unique constraint/index.
- Add check constraint.
- Add foreign key.
- Add partial unique index.
- Tighten validation expression.
- Add lifecycle guard to a transition already used by objects.
- Change default value.
- Add index on a large table.

Default behavior: require server-side validation/impact analysis. May require
confirmation depending on table size, lock risk, and violations.

### Destructive / Breaking

Definition: can lose data, remove existing API shape, invalidate existing
references, or break existing clients/hooks/actions.

Examples:

- Drop field/column.
- Drop resource/table.
- Rename field/resource without compatibility alias/staged migration.
- Change field type incompatibly.
- Remove enum/lifecycle state used by existing rows.
- Remove action/hook referenced by active resources/lifecycles/actions.
- Tighten requiredness when existing rows are missing values.
- Drop relationship table or foreign key target.
- Change semantic meaning of a field without migration/versioning.

Default behavior: never auto-apply. Block until live facts are safe, require an
explicit intermediate pack revision when cleanup needs transitional schema, and
require destructive confirmation tied to the final whole-plan digest.

### Operational Hazard

This is an independent flag layered on top of the above classes.

Hazards:

- table rewrite likely
- long lock possible
- index build cost
- foreign key validation scan
- check/unique constraint validation scan
- large table row count
- DDL cannot run inside transaction
- concurrent operation required

Default behavior: preview must surface hazards and mitigations.

## Canonical Classification Algorithm

Input:

- current normalized resource config
- desired normalized resource config
- live database introspection
- row counts/statistics
- dependency graph: resources, actions, hooks, lifecycles, relationships, AXI
  refs

Steps:

1. **Normalize configs** to canonical JSON.
2. **Compute semantic diff** between current and desired resource graph.
3. **Map each diff to migration primitive**, e.g. add column, drop column, add
   unique index, change type.
4. **Classify each primitive** as safe/risky/destructive using hardcoded rules.
5. **Run live validation** for risky/destructive changes:
   - row count
   - violating rows count
   - dependent objects/actions/hooks
   - existing values/states
6. **Plan Postgres operation** using online-safe forms where possible:
   - `CREATE INDEX CONCURRENTLY`
   - `ADD CONSTRAINT ... NOT VALID`
   - `VALIDATE CONSTRAINT`
   - staged backfill
7. **Attach hazards** similar to `pg-schema-diff` hazard warnings.
8. **Produce migration preview** with exact classes, hazards, generated
   SQL/steps, and required confirmations.
9. **Optionally validate plan in a temporary/shadow database** before applying,
   following Atlas/pg-schema-diff style.

## Borrowed Patterns to Reuse

### Hazard warnings from pg-schema-diff

Adopt the idea of a hazard list separate from the schema diff.

Example hazards:

```yaml
hazards:
  - code: INDEX_BUILD
    severity: warning
    message: Concurrent index build may consume CPU and take time, but should not block writes.
  - code: ACQUIRES_EXCLUSIVE_LOCK
    severity: blocking
    message: This operation may take an access exclusive lock.
```

### Expand/contract from zero-downtime migration practice

For destructive or breaking changes:

1. expand: add new schema while old still works
2. migrate/backfill data
3. switch reads/writes
4. contract: remove old schema later

### Preconditions from Liquibase

Migration steps can include preconditions:

- table has zero rows
- no rows violate new constraint
- no active actions reference removed hook
- resource has no live objects
- backup/export artifact exists

### Temporary database validation from Atlas/pg-schema-diff

Before applying complex plans, run generated DDL against a temporary database or
schema clone where feasible.

## Easy Rule of Thumb

A change is destructive/breaking if any answer is “yes”:

- Does it remove a field/resource/action/hook/lifecycle state that currently
  exists?
- Could existing data be lost, hidden, or coerced?
- Could existing rows fail the new schema without backfill?
- Could existing API/CLI/hook/action references stop working?
- Is rollback impossible without backup/export?

A change is risky if any answer is “yes”:

- Does it require scanning existing rows?
- Does it add uniqueness, foreign key, requiredness, or check constraints?
- Could Postgres take long locks or rewrite a large table?
- Is table size large enough that online operation matters?

Only changes that are additive, compatible, valid for existing data, and
low-hazard are safe.

## Prototype

See [CRM Migration Prototype](crm-migration-prototype.md) for a concrete
CRM-based walkthrough of detection rules, hazards, staged deprecations, data
cleanup, confirmation tokens, and destructive cleanup.

## Frozen MVP decisions

- optd owns a semantic pack-definition diff/planner and borrows established
  hazard concepts; it does not embed `pg-schema-diff` as a runtime dependency.
- Stable internal hazard codes are the exact codes exposed through HTTP and
  `optctl`; presentation may add explanations but never rename them.
- MVP has no table-size threshold that changes safety class. Any operation that
  scans/rewrites data or requests a blocking/strong lock is intrinsically risky;
  preview additionally reports live row/byte estimates so operators can judge
  duration. This is conservative and avoids environment-dependent classes.
- Every generated DDL plan receives structural execution validation against
  temporary real Postgres before it becomes applicable. Risky/destructive plans
  also revalidate live blockers/facts immediately before locked transactional
  activation. Temporary validation never substitutes for live-data checks.
