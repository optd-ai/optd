# Chunk 13: Container/dev environment and runtime startup validation

## Deliverable
Validate the intended production-like container runtime with bundled/app-managed and external Postgres modes.

## Scope
- Add Dockerfile/container build definition with Deno app/CLI and Postgres binaries available.
- Add Docker Compose file for one-command local run.
- Document runtime env: `OPERANT_DATA_DIR`, `OPERANT_DATABASE_URL`, `OPERANT_PG_BIN_DIR`, `OPERANT_SECRET_MASTER_KEY`.
- Add health checks for app and DB.
- Validate startup/shutdown for app-managed Postgres.
- Document or stub backup/restore only as needed; do not overbuild beyond MVP acceptance.

## Validation requirements
- Build container.
- Run container/compose without `OPERANT_DATABASE_URL`; verify app-managed Postgres starts, migrations run, and `optctl home` works.
- Run against external Postgres service with `OPERANT_DATABASE_URL`; verify app does not start managed DB.
- Restart with persisted volume; verify data remains and migrations are idempotent.
