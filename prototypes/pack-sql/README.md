# Pack Upload → SQL Schema Prototype

This prototype validates what happens to the database when a pack is uploaded
over HTTP multipart and applied.

It uses a Deno HTTP server backed by PGlite.

## What it proves

- Pack upload uses multipart form data.
- `pack.yaml` is required.
- Strict pack paths are validated; no general `docs/` directory is accepted.
- JSON-compatible YAML config is normalized into internal JSON.
- Resource files compile into actual SQL resource tables.
- Built-in platform columns are added:
  - `id text primary key`
  - `version integer not null default 1`
  - `archived_at timestamptz`
- `required: true` compiles to `not null`.
- Field types compile to SQL types.
- Field refs are recorded as metadata for later dependency/migration work.
- First-class relationships compile to `rel_*` SQL tables and relationship
  metadata.
- Lifecycle and policy documents are stored as first-class pack metadata.
- Seed files are stored as seed definitions and idempotent seed records keyed by
  seed/resource key; the intended real execution path is seed sugar lowered into
  ordinary changeset operations.
- Pack revisions, source files, resource definitions, field definitions,
  relationship definitions, lifecycle definitions, policy definitions, seed
  definitions, hook definitions, action definitions, and apply events are stored
  in platform tables.
- Every child YAML file must include `metadata.name`; names are never inferred
  from filenames.
- Hook YAML is required for every hook script.
- Hook YAML must reference a script basename, and the matching `hooks/*.ts`
  upload must exist.
- Hook scripts are stored with digest/bytes metadata.
- Preview compiles the plan without changing the database.
- Apply stores metadata and creates SQL tables transactionally.

## Run server

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/pack-sql/pack-sql-server.ts
```

Server defaults to `http://127.0.0.1:8789`.

## Test

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/pack-sql/pack-sql-server.test.ts
```

## Endpoints

- `GET /health`
- `GET /debug/schema`
- `GET /debug/platform`
- `POST /packs/preview`
- `POST /packs/apply`

## Fixture

The tests upload `prototypes/migration/packs/crm-v1` as multipart form files and
verify the resulting PGlite database schema and platform metadata.
