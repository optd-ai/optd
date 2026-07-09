# Chunk 10: Pack migration lifecycle

## Deliverable
Preview and apply pack upgrades safely with semantic diff, live facts, safe/risky/destructive handling, and audit.

## Scope
- Implement semantic diff between active and candidate normalized pack definitions.
- Implement migration issue classification from prototypes: safe, risky, destructive, unsupported/blocking.
- Implement live fact queries for row counts, violations, dependencies, nullability, indexes where needed.
- Persist migration plans, steps, digest, SQL preview, violations.
- Implement safe additive apply.
- Implement staged destructive flow and digest-bound confirmation for destructive cleanup.
- Route cleanup/backfill guidance through ordinary changesets.
- Add routes and CLI for migration inspect/apply/confirm; make `optctl pack preview/apply` show migration summary when active revision exists.

## Validation requirements
- Unit tests for migration classification matrix.
- Integration test applies CRM v1-like fixture, previews v2 candidate with safe/risky/destructive changes, inspects live facts, applies safe changes, stages destructive change, performs cleanup through changesets, confirms digest, verifies audit.
- Live scenario uses CRM migration fixture and verifies generated SQL plus final table shape/data.
- Verify pack registry updates only after successful migration apply.
