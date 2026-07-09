# Migration Detection Prototype

Executable Deno prototype for CRM resource migration classification.

It compares normalized current/desired pack JSON plus simple live database facts
and emits detected migration issues and a suggested staged plan.

It also supports an end-to-end strict-pack-directory mode: load an initial pack
directory, load a desired pack directory, compute the proposed changes, and
classify the resulting migration issues.

## Run

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts prototypes/migration/scenarios/safe-additive.json
```

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts prototypes/migration/scenarios/breaking-crm.json
```

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts diff-packs prototypes/migration/packs/crm-v1 prototypes/migration/packs/crm-v2 prototypes/migration/packs/live-facts.json
```

Run the broad edge-case fixture that exercises all current migration issue
types:

```bash
deno run --allow-read prototypes/migration/migration-prototype.ts diff-packs prototypes/migration/packs/crm-edge-v1 prototypes/migration/packs/crm-edge-v2 prototypes/migration/packs/edge-live-facts.json
```

## End-to-end pack diff + PGlite walkthrough

This combines the pack-directory diff prototype with the PGlite execution
prototype:

1. Load and apply `packs/crm-v1` to PGlite.
2. Seed CRM data.
3. Load `packs/crm-v2`.
4. Compute migration plan from pack diff plus live DB facts.
5. Apply safe additive changes.
6. Review risky action/hook changes.
7. Stage destructive changes.
8. Validate blockers.
9. Apply explicit cleanup/backfill changeset-like operations.
10. Revalidate.
11. Generate a digest-bound confirmation token.
12. Apply destructive cleanup and activate CRM v2.

No rename inference is performed: `company_name` removal and `organization_name`
addition are separate changes; the cleanup step explicitly copies values.

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/e2e-pack-pglite-prototype.ts
```

## Complex cast workaround walkthrough

This prototype exercises an unsupported type change (`string -> integer`) and the agent workaround:

1. Direct type change is blocked.
2. Agent uploads a workaround pack adding a new integer field.
3. Safe additive field is applied.
4. Agent-generated changesets parse/backfill valid values.
5. Invalid values block revalidation.
6. Agent fixes invalid rows with ordinary changesets.
7. Final pack removes the old string field.
8. Old values are cleared with ordinary changesets.
9. Digest-confirmed destructive cleanup drops the old column.

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/complex-cast-workaround-prototype.ts
```

## PGlite destructive migration walkthrough

This prototype uses a real in-memory PGlite database and CRM-flavored resources
(`lead`, `note`) to walk through destructive migration variants. The migration
code remains generic and has no hardcoded knowledge of CRM fields:

- remove field
- change field type through replacement column/backfill for supported generated
  casts
- remove lifecycle state
- remove resource/table
- stage/deprecate first
- validate blockers
- cleanup/backfill/archive through ordinary changeset-style operations
- generate digest-bound confirmation token
- apply destructive cleanup

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/migration/pglite-destructive-prototype.ts
```

## Test

```bash
deno test --allow-read prototypes/migration/migration-prototype.test.ts
```

Full prototype suite, including PGlite:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/migration/migration-prototype.test.ts prototypes/migration/pglite-destructive-prototype.test.ts prototypes/migration/e2e-pack-pglite-prototype.test.ts prototypes/migration/complex-cast-workaround-prototype.test.ts
```

## What it proves

- Proposed changes can be built by scanning strict pack directories.
- The combined E2E prototype can apply an active pack to a real PGlite database,
  compute a migration from a desired pack, stage/clean/confirm/apply the
  migration, and activate the desired revision.
- The edge fixture exercises every migration issue type currently implemented by
  the prototype.
- Many migration issues can be detected with normalized config diffing and
  simple live facts.
- Blocking changes need only targeted facts: row counts, violation counts,
  duplicate counts, dependency references.
- Destructive changes can be staged/deprecated by default instead of applied
  directly.

Prototype fixture note: files use `.yaml` names to match the pack convention,
but their contents are JSON because JSON is valid YAML and this keeps the
prototype dependency-free. The real implementation should parse restricted YAML
and normalize to canonical JSON.

This is not a production migration planner. It is a pressure-test for the
classification model in `spec/crm-migration-prototype.md`.
