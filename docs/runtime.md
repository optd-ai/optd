# optd runtime and deployment

## Fresh-state identity

The server executable is `optd`; `optctl` and `/api/v1` are unchanged. Runtime
configuration uses only `OPTD_*`. The default managed data directory is
`.optd-data`, the managed PostgreSQL role is `optd`, and local credentials use
`optd/auth` beneath the platform data root (XDG on Linux).

Historical Operant development databases, credentials, contexts, process
bindings, and encrypted metadata are disposable. There is no legacy environment
alias, credential import, in-place database upgrade, or data-directory
migration. Start with fresh optd state; do not point optd at the old development
database.

Optd production deployment is container-only and supports exactly two modes.
PostgreSQL 17 or newer is required (the release image and external Compose
example pin PostgreSQL 18.4). PGlite and SQLite are prototype-only/non-MVP
runtimes.

## Mode 1: one container with app-managed PostgreSQL

Leave `OPTD_DATABASE_URL` unset. The Optd server starts and owns one PostgreSQL
process beneath `OPTD_DATA_DIR`, runs migrations, and runs exactly one
in-process outbox poll loop. There is no database or worker sidecar.

`docker-compose.yml` mounts exactly one persistent volume at `/data`. It stores
the PostgreSQL cluster and server-owned durable state. The local `optctl` auth
store belongs to the client: its default is under the invoking user's `HOME`/XDG
directories. When executing `optctl` inside this container its home is `/data`,
so that context is in the same protected volume. For a workstation CLI, back up
and permission its XDG state separately.

Use one app-managed replica. Its persistent volume must be writable by UID/GID
1993; the Kubernetes example sets `runAsNonRoot`, `runAsUser`, `runAsGroup`, and
`fsGroup` accordingly. A bind mount must likewise be owned by 1993:1993. Optd
fails closed rather than changing ownership as root.

## Mode 2: external PostgreSQL

Set `OPTD_DATABASE_URL` to a `postgres://` or `postgresql://` URL for PostgreSQL
17 or newer. Optd validates the server version before readiness or migrations.
It never runs `initdb`, starts or stops PostgreSQL, or falls back to a local
database when the URL is unreachable, malformed, unauthorized, or too old.
Stopping/recreating Optd leaves the external server, data, and outbox rows
intact. `compose.external-postgres.yml` demonstrates this mode with a separately
pinned PostgreSQL 18.4 service.

Both modes keep the outbox poll loop in the server process. Do not add a worker
container or sidecar.

## Required secrets

Every fresh deployment requires `OPTD_BOOTSTRAP_TOKEN`. The first
`optctl bootstrap init` presents it through the process environment; remove or
rotate the token after bootstrap. It is not readiness state: `/ready` can be
healthy while bootstrap status is `bootstrap_required`.

Set `OPTD_SECRET_MASTER_KEY` to canonical base64 for exactly 32 random bytes
before creating encrypted rows. Generate values without committing or baking
them into an image:

```bash
export OPTD_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"
export OPTD_SECRET_MASTER_KEY="$(openssl rand -base64 32)"
```

Keep the master key in a secret manager, not the data volume, CLI auth store,
Compose file, image build args, logs, or backups. Preserve it alongside database
backups. Once encrypted rows exist, a missing, malformed, or different key makes
startup fail closed before readiness. Losing the key is data loss; database
restore alone cannot decrypt secrets. Kubernetes uses `secretKeyRef` for both
values (and for the external database URL).

For external Compose also generate a URL-safe database password, for example
`openssl rand -hex 32`, and export it as `OPTD_POSTGRES_PASSWORD`.

## Commands

App-managed:

```bash
docker compose up --build -d
docker compose exec optd optctl --server http://127.0.0.1:8789 status ready --json
docker compose exec optd optctl --server http://127.0.0.1:8789 bootstrap init --username admin --password-stdin
docker compose down                 # retain optd-data
docker compose down --volumes       # destructive: remove all durable data
```

External:

```bash
docker compose -f compose.external-postgres.yml up --build -d
docker compose -f compose.external-postgres.yml exec optd \
  optctl --server http://127.0.0.1:8789 status ready --json
docker compose -f compose.external-postgres.yml stop optd
```

Release verification and metadata:

```bash
deno task container-smoke
deno task release-gate
# Substitute the full immutable ID of the image built from this exact HEAD:
./scripts/release-artifacts.sh sha256:<64-lowercase-hex-digits> dist
```

See [local distribution](release.md) for legal artifacts, the new-repository
premise, and the separately authorized external publication boundary. These
commands are local verification, not evidence of a published release.

`release-gate` refuses tracked or untracked source changes. Set
`OPTD_RELEASE_BASE` to a full 40-character commit ID when checking a range other
than the frozen handoff; the commit must exist locally and be an ancestor of
exact `HEAD`. The gate builds one no-cache image from an immutable
`git
archive`, then executes artifacts and the complete container suite only by
its frozen full image ID. A cryptographically unique run ID is carried by every
owned Docker name, label, Compose project, and durable registry entry.

The parent trap is installed as soon as the single state root exists. On every
exit it revalidates registered Docker labels and Linux process identity before
cleanup, never uses name-prefix ownership, and never prunes. The image baseline
is the exact sorted result of `docker image ls --all --no-trunc --quiet`.
Because the supported daemon uses the legacy builder, the gate durably captures
that one build's stdout, stderr, exit status, and terminating signal. Only IDs
on legacy builder result lines can be resolved against the exact post-build
delta; creation times, parent chains, final history when available, and the
final run label must agree before each proven full ID is fsynced to the
registry.

Before its first image removal, cleanup revalidates the complete registered set,
immutable evidence, final tag and label, parent/child relationships, tags,
digests, and container references. It removes exact full IDs child-to-parent
with `--no-prune`, without force or mutable tags, and then requires the
all-image snapshot to be byte-identical to baseline. Unknown concurrent deltas,
ambiguous short IDs, unexpected references, or removal failures block image
deletion and retain the private evidence directory for audit; unrelated images
are never removed. `release-artifacts.sh` requires a clean exact source revision
and a full immutable image ID, compiles the standalone CLI with the frozen
lockfile, fsyncs same-filesystem staging, and rolls an interrupted publication
back to the prior output. Output symlinks and replaced output parents are
rejected.

## Liveness, readiness, and startup

- `GET /live` reports that the HTTP process can answer. Use it for liveness.
- `GET /ready` returns 200 only while PostgreSQL is reachable and all platform
  migrations are healthy; otherwise it returns 503. Use it for readiness and
  startup probes.
- `GET /api/v1/auth/bootstrap/status` independently reports `bootstrap_required`
  or `active`.

The image health check uses `/ready`. Kubernetes uses `/live` for liveness and
`/ready` for startup/readiness. During graceful termination Optd first aborts
the HTTP listener (so new readiness/work is rejected), stops the one outbox poll
loop within its grace bound, closes authentication listeners and the SQL pool,
and finally stops app-managed PostgreSQL. External PostgreSQL is never signaled.
The server runs under `tini` as PID 1 so SIGTERM/SIGINT are forwarded and zombie
children are reaped. App-managed PostgreSQL gets an 8-second smart-shutdown
window and then an 8-second fast-shutdown window. If both expire, Optd logs a
redacted `postgres_shutdown_escalated` lifecycle event and uses PostgreSQL's
documented immediate shutdown so the postmaster is reaped before the
orchestrator's final SIGKILL deadline; the next start performs crash recovery.
Allow at least 30 seconds termination grace.

## Runtime environment

| Variable                 | Mode        | Meaning                                                                                                               |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `OPTD_DATA_DIR`          | app-managed | Persistent directory; defaults to `/data`. PostgreSQL data is under `postgres/data` and sockets under `postgres/run`. |
| `OPTD_DATABASE_URL`      | external    | External PostgreSQL URL. Its presence irrevocably selects external mode for that start.                               |
| `OPTD_PG_BIN_DIR`        | app-managed | Directory containing `initdb`, `postgres`, and `psql`; release default is `/usr/lib/postgresql/18/bin`.               |
| `OPTD_BOOTSTRAP_TOKEN`   | both        | Required injected bootstrap credential; never put it in image layers.                                                 |
| `OPTD_SECRET_MASTER_KEY` | both        | Canonical base64 encoding of exactly 32 random bytes, held outside database/data volume.                              |
| `OPTD_HOST`              | both        | Bind address; image default `0.0.0.0`.                                                                                |
| `OPTD_PORT`              | both        | HTTP port; default `8789`.                                                                                            |
| `OPTD_PG_PORT`           | app-managed | Optional managed PostgreSQL port; default `0` selects a free local port.                                              |

## Persistence, restart, and recovery

Startup initializes an empty app-managed cluster, or reuses the existing
`PG_VERSION`, then validates PostgreSQL and applies migrations idempotently.
Never point two app-managed containers at one volume. Restart with the same
volume and master key; migrations, facts, encrypted secrets, auth state, and
queued/retry outbox work persist. Outbox leases recover according to their
durable expiry contract after an unclean stop.

A normal SIGTERM cleanly removes PostgreSQL's `postmaster.pid`. After SIGKILL,
PostgreSQL performs its own crash recovery on restart; Optd does not delete or
forge lock/PID files. Permission, key, database authentication, migration, and
version errors remain startup failures with bounded redacted diagnostics.

## Backup and restore

MVP has no first-class backup command. Use `pg_dump`/`pg_restore`, or the
external provider's PostgreSQL-aware backup tooling. Do not copy a live data
directory as the primary backup. Restore the matching master key from its
separate custody system, keep file ownership at 1993:1993 for app-managed mode,
and restart Optd so migrations and outbox recovery run normally.
