# Operant runtime and deployment

Operant production deployment is container-only and supports exactly two modes.
PostgreSQL 17 or newer is required (the release image and external Compose
example pin PostgreSQL 18.4). PGlite and SQLite are prototype-only/non-MVP
runtimes.

## Mode 1: one container with app-managed PostgreSQL

Leave `OPERANT_DATABASE_URL` unset. The Operant server starts and owns one
PostgreSQL process beneath `OPERANT_DATA_DIR`, runs migrations, and runs exactly
one in-process outbox poll loop. There is no database or worker sidecar.

`docker-compose.yml` mounts exactly one persistent volume at `/data`. It stores
the PostgreSQL cluster and server-owned durable state. The local `optctl` auth
store belongs to the client: its default is under the invoking user's `HOME`/XDG
directories. When executing `optctl` inside this container its home is `/data`,
so that context is in the same protected volume. For a workstation CLI, back up
and permission its XDG state separately.

Use one app-managed replica. Its persistent volume must be writable by UID/GID
1993; the Kubernetes example sets `runAsNonRoot`, `runAsUser`, `runAsGroup`, and
`fsGroup` accordingly. A bind mount must likewise be owned by 1993:1993. Operant
fails closed rather than changing ownership as root.

## Mode 2: external PostgreSQL

Set `OPERANT_DATABASE_URL` to a `postgres://` or `postgresql://` URL for
PostgreSQL 17 or newer. Operant validates the server version before readiness or
migrations. It never runs `initdb`, starts or stops PostgreSQL, or falls back to
a local database when the URL is unreachable, malformed, unauthorized, or too
old. Stopping/recreating Operant leaves the external server, data, and outbox
rows intact. `compose.external-postgres.yml` demonstrates this mode with a
separately pinned PostgreSQL 18.4 service.

Both modes keep the outbox poll loop in the server process. Do not add a worker
container or sidecar.

## Required secrets

Every fresh deployment requires `OPERANT_BOOTSTRAP_TOKEN`. The first
`optctl bootstrap init` presents it through the process environment; remove or
rotate the token after bootstrap. It is not readiness state: `/ready` can be
healthy while bootstrap status is `bootstrap_required`.

Set `OPERANT_SECRET_MASTER_KEY` to canonical base64 for exactly 32 random bytes
before creating encrypted rows. Generate values without committing or baking
them into an image:

```bash
export OPERANT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
export OPERANT_SECRET_MASTER_KEY="$(openssl rand -base64 32)"
```

Keep the master key in a secret manager, not the data volume, CLI auth store,
Compose file, image build args, logs, or backups. Preserve it alongside database
backups. Once encrypted rows exist, a missing, malformed, or different key makes
startup fail closed before readiness. Losing the key is data loss; database
restore alone cannot decrypt secrets. Kubernetes uses `secretKeyRef` for both
values (and for the external database URL).

For external Compose also generate a URL-safe database password, for example
`openssl rand -hex 32`, and export it as `OPERANT_POSTGRES_PASSWORD`.

## Commands

App-managed:

```bash
docker compose up --build -d
docker compose exec operant optctl --server http://127.0.0.1:8789 status ready --json
docker compose exec operant optctl --server http://127.0.0.1:8789 bootstrap init --username admin --password-stdin
docker compose down                 # retain operant-data
docker compose down --volumes       # destructive: remove all durable data
```

External:

```bash
docker compose -f compose.external-postgres.yml up --build -d
docker compose -f compose.external-postgres.yml exec operant \
  optctl --server http://127.0.0.1:8789 status ready --json
docker compose -f compose.external-postgres.yml stop operant
```

Release verification and metadata:

```bash
deno task container-smoke
deno task release-gate
./scripts/release-artifacts.sh operant:0.1.0-dev dist
```

`release-gate` refuses tracked or untracked source changes, builds one no-cache
image labeled with the exact source revision, and reuses that image for the
complete checked/container suite and artifact checks. It removes that exact
image on exit after comparing full container, volume, network, owned-process,
and owned-temporary-directory inventories; set `OPERANT_RELEASE_KEEP_IMAGE=1` to
retain it. `release-artifacts.sh` likewise requires clean source and a matching
image revision, compiles the standalone CLI with the frozen lockfile, and swaps
a fully checksummed staging directory into place only after every artifact
succeeds.

## Liveness, readiness, and startup

- `GET /live` reports that the HTTP process can answer. Use it for liveness.
- `GET /ready` returns 200 only while PostgreSQL is reachable and all platform
  migrations are healthy; otherwise it returns 503. Use it for readiness and
  startup probes.
- `GET /api/v1/auth/bootstrap/status` independently reports `bootstrap_required`
  or `active`.

The image health check uses `/ready`. Kubernetes uses `/live` for liveness and
`/ready` for startup/readiness. During graceful termination Operant first aborts
the HTTP listener (so new readiness/work is rejected), stops the one outbox poll
loop within its grace bound, closes authentication listeners and the SQL pool,
and finally stops app-managed PostgreSQL. External PostgreSQL is never signaled.
The server runs under `tini` as PID 1 so SIGTERM/SIGINT are forwarded and zombie
children are reaped. App-managed PostgreSQL gets an 8-second smart-shutdown
window and then an 8-second fast-shutdown window. If both expire, Operant logs a
redacted `postgres_shutdown_escalated` lifecycle event and uses PostgreSQL's
documented immediate shutdown so the postmaster is reaped before the
orchestrator's final SIGKILL deadline; the next start performs crash recovery.
Allow at least 30 seconds termination grace.

## Runtime environment

| Variable                    | Mode        | Meaning                                                                                                               |
| --------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPERANT_DATA_DIR`          | app-managed | Persistent directory; defaults to `/data`. PostgreSQL data is under `postgres/data` and sockets under `postgres/run`. |
| `OPERANT_DATABASE_URL`      | external    | External PostgreSQL URL. Its presence irrevocably selects external mode for that start.                               |
| `OPERANT_PG_BIN_DIR`        | app-managed | Directory containing `initdb`, `postgres`, and `psql`; release default is `/usr/lib/postgresql/18/bin`.               |
| `OPERANT_BOOTSTRAP_TOKEN`   | both        | Required injected bootstrap credential; never put it in image layers.                                                 |
| `OPERANT_SECRET_MASTER_KEY` | both        | Canonical base64 encoding of exactly 32 random bytes, held outside database/data volume.                              |
| `OPERANT_HOST`              | both        | Bind address; image default `0.0.0.0`.                                                                                |
| `OPERANT_PORT`              | both        | HTTP port; default `8789`.                                                                                            |
| `OPERANT_PG_PORT`           | app-managed | Optional managed PostgreSQL port; default `0` selects a free local port.                                              |

## Persistence, restart, and recovery

Startup initializes an empty app-managed cluster, or reuses the existing
`PG_VERSION`, then validates PostgreSQL and applies migrations idempotently.
Never point two app-managed containers at one volume. Restart with the same
volume and master key; migrations, facts, encrypted secrets, auth state, and
queued/retry outbox work persist. Outbox leases recover according to their
durable expiry contract after an unclean stop.

A normal SIGTERM cleanly removes PostgreSQL's `postmaster.pid`. After SIGKILL,
PostgreSQL performs its own crash recovery on restart; Operant does not delete
or forge lock/PID files. Permission, key, database authentication, migration,
and version errors remain startup failures with bounded redacted diagnostics.

## Backup and restore

MVP has no first-class backup command. Use `pg_dump`/`pg_restore`, or the
external provider's PostgreSQL-aware backup tooling. Do not copy a live data
directory as the primary backup. Restore the matching master key from its
separate custody system, keep file ownership at 1993:1993 for app-managed mode,
and restart Operant so migrations and outbox recovery run normally.
