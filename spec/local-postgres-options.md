<!-- generated-by: pi-dag-workflow/project-model; view: view-disposition-local-postgres-options; contract: 1; input: sha256:166be8960c22dc6eb15bae5f5991353732e49aa829c219305a6c3663fd91fa4b -->

# Historical Local Postgres Options Research

Generated non-normative disposition view preserving the complete reviewed legacy source for auditability.

## Migration disposition

<a id="obj-com-disposition-local-postgres-options"></a>

### Disposition — Historical Local Postgres Options Research

**Migration disposition.** This source is preserved literally below for auditability at `sha256:20910c3ab5084bb1f0939a2cf117b0a04cf422e5ce3647b1b41d0ab93cb5c580`, but remains non-normative historical, supporting research, prototype evidence, roadmap, or superseded planning material. Only separately accepted current project-model objects carry product authority.

> **Status:** supporting research only. The frozen target is real external or
> app-managed Postgres in `deployment.md`/`storage-postgres.md`; PGlite is
> prototype-only.

## Historical question

Can we get SQLite-like deployment ergonomics while keeping Postgres semantics,
so the app can decide at boot whether to start a local database instead of
requiring users to configure a sidecar?

## Short Answer

There are two credible paths:

1. **PGlite:** in-process Postgres compiled to WASM, packaged as a TypeScript
   library.
2. **Bundled local Postgres process:** run the official Postgres server beside
   the app, managed by the app/container entrypoint.

They solve different problems. PGlite is closest to SQLite ergonomics. Bundled
Postgres is closest to real production Postgres semantics.

## PGlite

PGlite is a WASM build of Postgres from ElectricSQL. It can run in browser,
Node.js, Bun, and Deno with no external database process. It can be ephemeral
in-memory or persisted to filesystem/IndexedDB. Its README describes it as
Postgres in WASM and notes an important limitation: it is
single-user/single-connection because normal Postgres relies on a
process-forking model that does not map to Emscripten/WASM.

### Pros

- True in-process database ergonomics.
- No sidecar, no local server process, no port management.
- Very attractive for local development, tests, demos, desktop/local-first use,
  and possibly single-user installations.
- TypeScript/Deno integration is natural.
- Supports many Postgres features and some extensions, reportedly including
  pgvector and PostGIS.
- Startup/shutdown can be owned entirely by the app runtime.

### Cons / Risks

- Single-user/single-connection limitation is a major constraint.
- Not equivalent to server Postgres for concurrency, locking, process isolation,
  operational tooling, or extension compatibility.
- Production durability and backup story need careful validation.
- Likely tied most naturally to JS/TS runtimes; less natural if the core server
  is Go/Rust/etc.
- May make it easy to accidentally depend on behavior that diverges from real
  Postgres.
- Horizontal scaling is out of scope.

### Best Fit

- Development mode.
- Test mode.
- Demo mode.
- Maybe “personal local CRM” mode.
- Agent sandbox or ephemeral preview databases.

### Poor Fit

- Multi-process server deployments.
- Multiple concurrent workers.
- Horizontally scaled deployments.
- Any mode that promises full Postgres semantics.

## Bundled Local Postgres Process

The app/container can own a real Postgres server process. On boot it checks for
an initialized data directory, runs `initdb` if needed, starts `postgres`, waits
for readiness, runs migrations, then starts the app.

### Pros

- Real Postgres semantics.
- Same engine as production/external Postgres deployments.
- Supports normal Postgres extensions, tools, backups, locks, isolation,
  multiple connections, and worker concurrency.
- App can still provide “one container, one volume” ergonomics.
- Easier migration path from local single-container to external Postgres.

### Cons / Risks

- Not in-process; it is process supervision.
- Container has multiple processes, which is less orthodox.
- Need robust startup, shutdown, health checks, log handling, and
  upgrade/migration story.
- Need package-size and security-update management for bundled Postgres
  binaries.
- Cross-platform bundling is more work outside Docker.

### Best Fit

- Default simple self-hosted Postgres profile.
- Single-container deployment with one mounted volume.
- Users who want real Postgres semantics without learning database operations.
- Future horizontal scale migration path.

### Poor Fit

- Browser/local-first mode.
- Ultra-light embedded library use.
- Environments where process supervision is unavailable.

## Recommended Product Stance

MVP supports two real-Postgres profiles:

1. **`local-postgres` profile:** app-managed real Postgres process; the default
   one-container self-hosted path.
2. **`external-postgres` profile:** user supplies `OPERANT_DATABASE_URL`; this
   is required for horizontal scaling.

PGlite remains useful for dev/demo/ephemeral prototypes, but it is not an MVP
runtime or integration-test default. SQLite is out of MVP scope.

## Boot-Time Selection

The app can choose storage at boot through configuration:

```text
OPERANT_DATA_DIR=/data
OPERANT_DATABASE_URL=postgres://... # if set, use external Postgres
OPERANT_PG_BIN_DIR=/opt/operant/postgres/bin # optional override
OPERANT_PG_PORT=0 # app-managed mode; 0 chooses a free port/socket
```

For `local-postgres`:

1. Ensure `$OPERANT_DATA_DIR/postgres` exists.
2. If no cluster exists, run `initdb`.
3. Start `postgres` listening on a Unix socket under the data dir or private
   runtime dir.
4. Wait for readiness.
5. Run migrations with advisory/DB lock protection.
6. Start API/workers.
7. On shutdown, gracefully stop app workers then Postgres.

## Design Implications

- The database abstraction should still expose backend capabilities where
  useful, but MVP capabilities are defined against real Postgres.
- Resource/config previews should report whether constraints are enforced by
  database, runtime, both, or unsupported.
- Worker concurrency can rely on normal Postgres locking and transactions.
- Integration tests should run against app-managed real Postgres when binaries
  are available.
- Hooks/scripts must not access DB credentials directly; they use curated
  context and permissioned APIs instead.

## Remaining Questions

- Should PGlite become a first-class supported backend after MVP, or remain
  prototype-only?
- How do backup/restore commands work for app-managed Postgres?
- Can local Postgres upgrades be made safe enough for non-expert self-hosters?
- Should Unix sockets be preferred over TCP in app-managed mode where available?
