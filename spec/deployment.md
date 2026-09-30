<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-deployment; contract: 1; input: sha256:c29810b53e57fdeda814972eef55712a42e0e63cac1b300c11bd5eff812d7e23 -->

# Deployment

Generated exact-contract projection imported into project-model/model.json from the reviewed deployment.md source.

## Exact migrated contract

<a id="obj-com-exact-deployment-v1"></a>

### Exact v1 contract — Deployment

**Migration provenance.** Exact normative contract imported from `spec/deployment.md` at `sha256:d90ebb1594b51611916f48f816badf8aeaa81cd1142c357ba0b45c58786baa25`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

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

1. external Postgres when `OPTD_DATABASE_URL` is set, and
2. app-managed local Postgres when `OPTD_DATABASE_URL` is absent.

SQLite is out of MVP scope. PGlite is permitted for focused prototypes only and
must not be treated as production-equivalent.

### External Postgres Mode

When `OPTD_DATABASE_URL` is present, optd uses that exact PostgreSQL
database for all persistence and coordination. App nodes are stateless aside
from disposable caches; each main server runs one in-process outbox polling loop
that coordinates through PostgreSQL locks. Startup never falls back to a local
database after selecting this mode.

### App-Managed Postgres Mode

When `OPTD_DATABASE_URL` is absent, optd initializes and owns an official
PostgreSQL process under `OPTD_DATA_DIR`. The server connects over loopback
TCP using `OPTD_PG_PORT` (`0` selects a free port). The optd server arms
signal handling before readiness, supervises the exact managed child, and uses
bounded PostgreSQL-native smart/fast/immediate shutdown escalation.

The default image runs the optd server under `tini`; there is no separate
worker, database sidecar, or generic process supervisor. One mounted data volume
contains the managed database and required runtime state. Health checks cover
both application and managed-database readiness; backup/restore uses normal
PostgreSQL tooling. PGlite remains prototype evidence only.

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
OPTD_DATA_DIR=/data
OPTD_DATABASE_URL=postgres://... # if set, use external Postgres
OPTD_PG_BIN_DIR=/opt/optd/postgres/bin # optional override; container supplies a default
OPTD_PG_PORT=0 # app-managed mode; 0 chooses a free loopback TCP port
OPTD_SECRET_MASTER_KEY=<base64-32-bytes> # required once encrypted secrets exist
OPTD_HOOK_NET_ALLOW=<comma-separated-host[:port]-ceiling> # optional narrowing
OPTD_HOOK_ENV_ALLOW=<comma-separated-nonsecret-env-names> # absent means none
```

Bootstrap/recovery tokens and the secret master key are injected as secret
environment/mounted values per their specs and never printed. There is no auth
mode/bypass configuration variable.

When `OPTD_DATABASE_URL` is absent, app-managed Postgres is the default. It
lets the app initialize/start a managed Postgres process under
`OPTD_DATA_DIR` while preserving real Postgres behavior.

## MVP runtime artifacts

The repository includes production-style examples:

- `Dockerfile` builds a Deno server image, compiled `optctl` binary, and
  container-provided Postgres binaries.
- `docker-compose.yml` runs the default one-container app-managed Postgres mode.
- `compose.external-postgres.yml` runs optd against an external Compose
  Postgres service via `OPTD_DATABASE_URL`.
- `k8s/optd-app-managed.example.yaml` and
  `k8s/optd-external-postgres.example.yaml` show Kubernetes deployment
  shapes.
- `docs/runtime.md` documents runtime env, data directory behavior,
  health/readiness, backup/restore guidance, and no-PGlite guardrails.

## Operational follow-up

The two runtime modes, image layout, hook filesystem denial, migration locking,
and backup/restore procedure are frozen in `docs/runtime.md` and executable
release/runtime tests. Future PostgreSQL major-version upgrade automation and
optional horizontal scaling remain deployment enhancements, not alternate MVP
runtime modes.
