# Operant runtime and deployment

Operant production deployment is container-only. The runtime is Postgres-only:
use an external Postgres service by setting `OPERANT_DATABASE_URL`, or omit it
and let the container start an app-managed Postgres process under
`OPERANT_DATA_DIR`.

## Runtime environment

| Variable                    | Required                                       | Description                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERANT_DATA_DIR`          | app-managed mode                               | Persistent runtime directory. Defaults to `/data` in the container. App-managed Postgres stores its cluster under `$OPERANT_DATA_DIR/postgres/data` and runtime socket/PID files under `$OPERANT_DATA_DIR/postgres/run`. Mount this as a persistent volume. |
| `OPERANT_DATABASE_URL`      | external mode                                  | `postgres://` or `postgresql://` URL for external Postgres. When set, Operant never starts or stops a managed Postgres process. Non-Postgres URLs are rejected at startup.                                                                                  |
| `OPERANT_PG_BIN_DIR`        | app-managed mode unless binaries are on `PATH` | Directory containing `initdb`, `postgres`, and `psql`. The production image installs Postgres and defaults this to `/usr/lib/postgresql/17/bin`; the entrypoint auto-detects a packaged version if the path changes.                                        |
| `OPERANT_SECRET_MASTER_KEY` | before secret create/read/decrypt paths        | Master key material for application-level encrypted secrets and hook secret injection. Mount through a secret manager; do not bake it into images.                                                                                                          |
| `OPERANT_HOST`              | optional                                       | Bind host, default `127.0.0.1` locally and `0.0.0.0` in the container image.                                                                                                                                                                                |
| `OPERANT_PORT`              | optional                                       | HTTP port, default `8789`.                                                                                                                                                                                                                                  |
| `OPERANT_PG_PORT`           | optional                                       | Managed Postgres port. Defaults to `0`/auto-select in app-managed runtime; set only when a fixed local port is needed.                                                                                                                                      |

## Container modes

### App-managed Postgres, one container

```bash
docker compose up --build
```

This starts one Operant container, initializes Postgres if
`$OPERANT_DATA_DIR/postgres/data` is empty, runs platform migrations
idempotently, starts the HTTP API, and exposes health/readiness on port `8789`.

Smoke check:

```bash
docker compose exec operant optctl --server http://127.0.0.1:8789 home --json
```

### External Postgres with Compose

```bash
docker compose -f compose.external-postgres.yml up --build
```

The `operant` service receives `OPERANT_DATABASE_URL` pointing at the `postgres`
service. In this mode the server connects to external Postgres only; it does not
run `initdb` or start a managed Postgres process.

### Kubernetes examples

- `k8s/operant-app-managed.example.yaml`: single replica with app-managed
  Postgres on a persistent volume.
- `k8s/operant-external-postgres.example.yaml`: app deployment using an
  external/shared Postgres URL from a Kubernetes Secret.

Use one app-managed replica only. For horizontal scaling, use external Postgres
and multiple stateless API/worker replicas after migration/outbox locking is
validated for that deployment.

## Health and readiness

- `GET /health` returns process health details and is suitable for liveness.
- `GET /ready` returns HTTP 200 only when Postgres is reachable and platform
  migrations are marked healthy; otherwise it returns HTTP 503.

Container and Kubernetes health checks use `/ready` for startup/readiness and
`/health` for liveness.

## Data directory behavior

When `OPERANT_DATABASE_URL` is absent, Operant:

1. Ensures `OPERANT_DATA_DIR` exists.
2. Initializes a Postgres cluster under `$OPERANT_DATA_DIR/postgres/data` when
   `PG_VERSION` is missing.
3. Starts `postgres` from `OPERANT_PG_BIN_DIR`.
4. Waits for readiness with `psql`.
5. Runs platform migrations idempotently.
6. Stops the managed Postgres process during server shutdown.

Keep `OPERANT_DATA_DIR` on persistent storage. Removing it removes the local
Postgres cluster.

## Backup and restore (MVP guidance)

MVP does not add a first-class backup command yet. Use standard Postgres tools:

- app-managed mode: run `pg_dump`/`pg_restore` from the container using the
  managed Postgres port shown in server health/debug logs or use a maintenance
  shell with the same data volume mounted;
- external mode: use your managed Postgres provider's backup tooling or
  `pg_dump`/`pg_restore` against `OPERANT_DATABASE_URL`.

Do not copy a live `$OPERANT_DATA_DIR/postgres/data` directory as the primary
backup mechanism unless Postgres is stopped or the backup method is
Postgres-aware.

## Runtime guardrails

PGlite and SQLite are prototype-only/non-MVP runtimes. Production startup
accepts only real Postgres via `postgres://`/`postgresql://` URLs or app-managed
Postgres binaries. `OPERANT_DATABASE_URL=file:...`, `sqlite:...`, `pglite:...`,
or other non-Postgres URLs fail fast.
