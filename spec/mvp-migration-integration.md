# MVP Migration Integration Design

Pack upgrade support is required for MVP. The migration prototypes are the
semantic source; this spec describes how they integrate into the server and
`optctl`.

## Lifecycle

1. `POST /packs/preview` uploads a candidate pack.
2. If no active revision exists, preview returns an install plan.
3. If an active revision exists, server computes semantic diff and creates a
   persisted migration preview.
4. Preview stores:
   - candidate pack files/config/scripts by digest,
   - current revision id,
   - candidate revision digest,
   - issue list,
   - live facts used for classification,
   - generated SQL for ready steps,
   - blockers and cleanup guidance,
   - confirmation digest.
5. `optctl migration inspect <id>` shows plan details.
6. Safe additive migrations may be applied directly.
7. Risky/destructive migrations require explicit reviewed/staged/confirmed
   commands.
8. Cleanup/backfill is performed through ordinary changesets.
9. Commit-time migration apply revalidates the stored preview against current
   live facts and plan digest.
10. Successful migration activates the new pack revision and writes
    audit/events.

## Migration statuses

```text
previewed
ready
blocked
staged
partially_staged
awaiting_confirmation
applied
failed
superseded
```

## Issue classes

Use existing classification:

```text
safe | risky | destructive
```

Each issue also has status:

```text
ready | blocked | staged | applied
```

## Commands

```text
optctl pack preview ./packs/crm-v2
optctl pack apply ./packs/crm-v2 --safe
optctl migration inspect <migration_id>
optctl migration inspect <migration_id> --violations
optctl migration inspect <migration_id> --sql
optctl migration validate <migration_id>
optctl migration apply <migration_id> --safe
optctl migration apply <migration_id> --reviewed
optctl migration plan <migration_id> --stage-deprecations
optctl migration apply <migration_id> --stage 1
optctl migration preview-drop <migration_id>
optctl migration apply <migration_id> --confirm <token>
```

## Server responsibilities

- Parse and validate candidate pack.
- Store candidate files/scripts immutably before preview is returned.
- Compare normalized current/candidate pack config.
- Query live facts only for classification/validation needs.
- Generate SQL for ready migration steps.
- Revalidate before apply.
- Run apply in a transaction where possible.
- Never run cleanup/backfill outside changesets.
- Record audit/events for migration decisions and applied DDL.

## Destructive flow

1. Preview marks destructive changes as blocked/staged by default.
2. Stage deprecations where possible:
   - block new writes,
   - preserve reads,
   - hide from default AXI output.
3. Agents use normal changesets to resolve blockers/backfill data.
4. Validate again.
5. Server emits digest-bound confirmation token for exact destructive SQL.
6. Apply only when token matches current plan digest.

## MVP implementation note

Initial implementation should lift logic from:

- `prototypes/migration/migration-prototype.ts`
- `prototypes/migration/e2e-pack-pglite-prototype.ts`
- `prototypes/migration/pglite-destructive-prototype.ts`
- `prototypes/migration/complex-cast-workaround-prototype.ts`

But it should be integrated behind application services and Postgres adapters,
not copied wholesale into HTTP route handlers.
