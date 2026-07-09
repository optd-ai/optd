# Deployment

## Direction

The project is now assumed to be open source and single-tenant by default.
Deployment should be simple enough to run as one container with one mounted
volume.

## Deployment Goals

- Container-only production deployment: Docker Compose or Kubernetes.
- Single Docker container for the default simple install, with one persistent
  volume.
- No required distributed coordination service beyond Postgres.
- Horizontally scalable API/workers when using external/shared Postgres.
- Easy bundled/app-managed Postgres option for users who want Postgres semantics
  without managing a database cluster.

## Storage Modes

MVP storage is Postgres only. Supported modes are:

1. external Postgres when `OPERANT_DATABASE_URL` is set, and
2. app-managed local Postgres when `OPERANT_DATABASE_URL` is absent.

SQLite is out of MVP scope. PGlite is permitted for focused prototypes only and
must not be treated as production-equivalent.

### Postgres Mode

Best for:

- Higher concurrency.
- Horizontal scaling.
- Larger data volumes.
- More robust indexing and queue/outbox claiming.

Properties:

- Postgres remains the only required coordination point.
- App nodes are stateless aside from local caches.
- Workers claim jobs/outbox rows through database locks.
- Can run against external Postgres or a bundled/sidecar Postgres profile.

### Local Postgres Options

There is no official SQLite-style in-process Postgres library. Postgres is
designed as a server with its own process model and data directory. Practical
local options are:

1. **Bundled Postgres process:** ship or depend on Postgres binaries, run
   `initdb`/`postgres` beside the app, connect over localhost or Unix socket.
2. **Single-container profile:** one image launches both the app and a local
   Postgres process under a lightweight supervisor. Data lives under the mounted
   volume.
3. **Compose/sidecar profile:** app container plus official Postgres container,
   still one command with Docker Compose.
4. **PGlite / WASM Postgres:** prototype-only convenience backend. See
   [Local Postgres Options](local-postgres-options.md).

**Decision:** use bundled local Postgres as the default simple deployment path.
The product should prefer the official Postgres engine for any mode that
promises full Postgres semantics. PGlite-like options can be explored as a
convenience backend, but should not be assumed equivalent to server Postgres for
locking, extensions, durability, concurrency, or operational maturity.

### Single-Container Postgres Profile

Recommended simple Postgres path:

- One image launches both the app and a local Postgres process under a
  lightweight supervisor.
- Data lives under the mounted volume.
- App connects over Unix socket where possible.
- Health checks cover both app and Postgres.
- Backups use `pg_dump`/base backup tooling.
- This trades container orthodoxy for self-hosting simplicity.
- A cleaner alternative is Docker Compose with app + Postgres sidecar, but the
  product should still aim for a one-command path.

## Horizontal Scaling

Horizontal scale-out should require Postgres mode. Correctness should rely on:

- Transactions.
- Unique constraints.
- Optimistic versions.
- Row locks / `SKIP LOCKED` queue claiming.
- Database-enforced resource constraints.

Avoid requiring Redis, Kafka, ZooKeeper, etcd, or a central policy service for
correctness.

## Storage Profile Sketch

```text
OPERANT_DATA_DIR=/data
OPERANT_DATABASE_URL=postgres://... # if set, use external Postgres
OPERANT_PG_BIN_DIR=/opt/operant/postgres/bin # optional override; container supplies a default
OPERANT_PG_PORT=0 # app-managed mode; 0 chooses a free port/socket
```

When `OPERANT_DATABASE_URL` is absent, app-managed Postgres is the default. It
lets the app initialize/start a managed Postgres process under
`OPERANT_DATA_DIR` while preserving real Postgres behavior.

## Remaining Operational Questions

- Exact bundled Postgres binary layout inside the production image.
- Safe local Postgres binary upgrades inside app-managed deployments.
- Backup/restore command details.
- How migrations coordinate across multiple app nodes in external Postgres mode.
- How much filesystem state scripts/hooks need beyond the database volume.
