# Chunk 1: Postgres process, connection, transactions, and platform migrations

## Deliverable
Make real Postgres the validated foundation for all later work.

## Scope
- Implement `src/adapters/outbound/postgres-process/` using `prototypes/postgres/` as reference.
- Implement external URL vs app-managed selection:
  - `OPERANT_DATABASE_URL` set: connect only, never manage process.
  - absent: locate `OPERANT_PG_BIN_DIR`/PATH/container binaries and init/start/stop managed Postgres under `OPERANT_DATA_DIR`.
- Implement Postgres client adapter, parameterized query helper, identifier quoting helper, transaction manager, and migration lock if needed.
- Implement platform migration runner and minimal platform tables, including `platform_schema_migrations`.
- Wire server startup so `/health` reports DB and migration status.

## Validation requirements
- Real Postgres integration: temp data dir, start DB, run migrations, insert/select a platform sentinel row, stop DB.
- External-mode test may skip unless `OPERANT_DATABASE_URL` is provided, but skip reason must be explicit.
- Restart persistence scenario: start server, write sentinel, stop, restart with same data dir, assert sentinel and migration rows remain.
- Extend `tests/scenarios/00_bootstrap.ts` or add `tests/scenarios/00_postgres_bootstrap.ts` to verify `/health` over HTTP includes DB/migration status.

## Notes
- If local Postgres binaries are unavailable, tests that require them may skip, but the scenario must still exist with a clear skip reason.
