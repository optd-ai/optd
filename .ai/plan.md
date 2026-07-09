# MVP Implementation Plan

## Goal

Build the Operant platform-engine MVP: an open-source, single-tenant,
API/CLI-first operational data platform that can run real packs safely through
HTTP APIs and `optctl`.

The MVP is not a CRM-only application. The canonical proof fixture is
`prototypes/crm-default-pack/` (`default.crm@0.1.0`), and the MVP must also
support a second bundled Odoo-inspired project-management pack
(`default.project_management@0.1.0`) to prove the engine is generic.

The plan is intentionally validation-first. Every chunk should leave behind an
executable path that starts real code, performs real operations, and checks
observed results. Unit tests and integration tests are required, but they are
not enough by themselves: each chunk should include at least one scenario-style
validation that exercises the new capability through the highest available
boundary, preferably `optctl -> HTTP -> application -> Postgres`.

## Decisions and constraints to preserve

- MVP target is the **platform-engine MVP**, not a CRM product.
- Production deployment is container-only: Docker Compose or Kubernetes.
- Runtime storage is real Postgres only:
  - use external Postgres when `OPERANT_DATABASE_URL` is set;
  - otherwise start app-managed Postgres under `OPERANT_DATA_DIR`.
- Production image/container environment must provide Postgres binaries.
- Integration tests should use the same app-managed Postgres lifecycle when
  binaries are available through `direnv + shell.nix`.
- PGlite is permitted for focused prototypes only, not MVP runtime or
  integration-test default.
- Server stack: Deno + Hono.
- CLI stack: Deno + Cliffy, distributed as a compiled binary.
- Hooks runtime: Deno/TypeScript only.
- No Deno hook imports initially: no remote imports, npm imports, or local
  relative imports unless a later pack proves the need.
- Core SQL uses raw SQL plus small typed helpers; no ORM/Knex for core behavior.
- Validation uses TypeBox + Ajv.
- Pack source is strict directory-based YAML plus hook scripts; parse with
  `yaml`, enable merge-key support, normalize to canonical JSON, validate with
  TypeBox/Ajv, and reject custom tags/non-JSON values/multi-doc features.
- `optctl` outputs TOON by default through `@toon-format/toon` behind an
  adapter. HTTP is JSON-only. CLI structured input is JSON only; provide
  `--json` for output.
- API routes follow Proposal A in `spec/mvp-api-routes.md`.
- `optctl` may accept dotted identifiers like `default.lead`, but it translates
  them to `{namespace}/{name}` API path segments or JSON fields.
- Hooks receive curated stdin JSON only. Hooks cannot directly query DB.
  Permissioned API calls may be supported by later hook permissions.
- Hook secrets are declared in Hook YAML, decrypted only at execution time,
  injected as narrow env vars, and granted narrow Deno `--allow-env=...`
  permissions.
- Secret values are encrypted before storage in Postgres. Master key comes from
  runtime env, e.g. `OPERANT_SECRET_MASTER_KEY`.
- `super_admin` can bootstrap/bypass authorization, but bypass is auditable.
- Policy is required for MVP: RBAC, ABAC, one-hop ReBAC, SQL pushdown before
  pagination, action auth, changeset auth, stable denial explanations.
- Expression language is a hardcoded CEL subset. Use `@bufbuild/cel` for AST
  parsing if compatible, with Operant-owned conservative SQL lowering.
- Pack migrations are required for MVP: semantic diff, preview, live facts, safe
  apply, staged destructive changes, digest-bound confirmation, cleanup/backfill
  through ordinary changesets, audit trail.
- Changesets are all-or-nothing transactions with preview/commit semantics,
  idempotency, optimistic locking, aliases, stable errors,
  history/audit/events/outbox.
- Object history uses immutable `object_versions`; generated resource tables are
  mutable current projections with `current_object_version_id`.
- Default packs are ordinary hackable configuration; no hidden
  CRM/project-specific engine code.

## Architecture approach

Follow `spec/mvp-implementation-boundaries.md`.

```text
src/
  domain/
  application/
  adapters/
    inbound/http-hono/
    inbound/cli-cliffy/
    outbound/postgres/
    outbound/postgres-process/
    outbound/deno-hooks/
    outbound/yaml/
    outbound/toon/
    outbound/crypto/
  schemas/
  config/
  main_server.ts
  main_optctl.ts
```

Rules:

- Domain/application do not import Hono, Cliffy, concrete Postgres clients, Deno
  process-spawn hook code, or TOON packages.
- Application services depend on ports.
- All real SQL lives under the Postgres outbound adapter.
- All transactions flow through an application-level transaction manager port.
- Inbound adapters translate HTTP/CLI inputs into application commands and
  format outputs.
- Application services return JSON-compatible DTOs or stable error envelopes.

## Validation strategy

### Validation ladder

Each chunk should use as many of these levels as are available:

1. **Pure unit validation** for domain/application invariants.
2. **Adapter contract validation** for Hono routes, Cliffy parsing, YAML
   parsing, TOON output, hook execution, crypto, and Postgres SQL modules.
3. **Real Postgres integration validation** through app-managed Postgres when
   binaries exist.
4. **HTTP scenario validation** against a started Hono server.
5. **CLI scenario validation** through `optctl` talking to the server.
6. **Pack-flow validation** using CRM and, once available, project-management
   pack.
7. **End-to-end smoke validation** that performs a full user/agent workflow and
   inspects persisted results.

### Chunk completion contract

A chunk is not complete unless it includes:

1. implementation code,
2. unit/adapter tests where appropriate,
3. at least one executable scenario or an explicit update to an existing
   scenario,
4. scenario execution against the highest available real boundary for that
   chunk,
5. assertions on observed persisted/API/CLI results, and
6. documented command output or test result.

If a chunk cannot perform live validation because a dependency is missing, it
must:

- state exactly what dependency is missing,
- add the scenario in skipped/pending form with a clear skip reason, and
- validate as much lower-level behavior as possible.

Workers should not mark a chunk complete by only adding unit tests unless the
chunk is explicitly pure-domain and has no available live boundary. Once
`optctl`, the server, and Postgres exist, new chunks should validate through
them whenever practical.

### Validation harness expectations

Add explicit scenario scripts/tests as the implementation emerges. Prefer names
like:

```text
tests/scenarios/00_bootstrap.ts
tests/scenarios/01_pack_preview_apply_crm.ts
tests/scenarios/02_changeset_crm_lead_flow.ts
tests/scenarios/03_query_policy_pagination.ts
tests/scenarios/04_action_hooks_outbox.ts
tests/scenarios/05_pack_migration.ts
tests/scenarios/06_project_management_pack.ts
tests/scenarios/99_full_crm_e2e.ts
```

Each scenario should actually execute a flow and assert observed state, not only
call isolated functions. When possible, the command boundary should be:

```text
compiled optctl -> HTTP server -> application services -> real Postgres -> observed metadata/history/outbox rows
```

For development convenience, the same scenario may expose a programmatic Deno
test entry point, but it should still start the real server and run real
commands.

### Useful baseline commands

Known working prototype check:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run \
  prototypes/vertical-slice/vertical-slice-server.test.ts \
  prototypes/optctl/optctl.test.ts \
  prototypes/typebox/typebox-spike.test.ts \
  prototypes/typebox/pack-yaml-validation-spike.test.ts \
  prototypes/policy-expression/policy-expression-integration.test.ts \
  prototypes/hook-typebox/hook-typebox-integration.test.ts \
  prototypes/migration-validated-packs/migration-validated-packs-spike.test.ts \
  prototypes/postgres/app-managed-postgres-spike.test.ts \
  prototypes/hexagonal/hexagonal-skeleton.test.ts \
  prototypes/platform-migrations/platform-migrations-spike.test.ts \
  prototypes/cliffy/compiled-cliffy-spike.test.ts
```

After real source exists, add stable commands such as:

```bash
deno fmt src tests spec prototypes

deno test --allow-read --allow-write --allow-env --allow-net --allow-run tests/unit tests/integration tests/scenarios

deno run --allow-read --allow-write --allow-env --allow-net --allow-run src/main_server.ts

deno run --allow-read --allow-env --allow-net src/main_optctl.ts --server http://127.0.0.1:8789 home
```

Exact command names can change during implementation, but every chunk should
update this plan or a README if validation commands change.

## Implementation sequence

The sequence below is designed so each chunk builds on validated glue from
earlier chunks. Do not defer all end-to-end validation to the end; each chunk
should create or extend an executable scenario.

### 0. Repository scaffolding and shared validation harness

**Goal:** Create the real MVP source/test skeleton and a reusable
live-validation harness.

**Implement:**

- `src/` layout from `spec/mvp-implementation-boundaries.md`.
- Initial `deno.json` with tasks for fmt/test/server/optctl/scenarios if useful.
- Shared stable error envelope type and result helpers.
- Shared actor/id/time test helpers.
- Scenario harness that can:
  - allocate a temp `OPERANT_DATA_DIR`,
  - start the app-managed Postgres lifecycle when binaries are available,
  - start the Hono server as a real server process or real in-process listener
    on a random port,
  - run `optctl` commands against that server over HTTP,
  - collect logs/artifacts on failure,
  - clean up child processes/listeners.
- A minimal `GET /health` route and `optctl home` stub wired through the real
  server boundary, even if it only returns bootstrap status.
- A first scenario file, e.g. `tests/scenarios/00_bootstrap.ts`, that starts the
  server and invokes `optctl` rather than only calling app objects in memory.

**Dependencies:** none.

**Validation:**

- Unit: stable error/result helpers.
- Integration: app-managed Postgres lifecycle test still skips cleanly without
  binaries and runs when `OPERANT_PG_BIN_DIR` exists.
- Live scenario: start the real server listener, call `GET /health` over HTTP,
  run `optctl home --json` against that HTTP URL, assert response contains
  server version/status, and assert the scenario would fail if the server were
  not actually listening.

**Exit criteria:** A subagent can add a new application service and a scenario
test without inventing project layout. The bootstrap scenario proves the
server/CLI harness crosses a real HTTP boundary.

### 1. Postgres process, connection, transaction, and platform migrations

**Goal:** Make real Postgres the validated foundation.

**Implement:**

- `adapters/outbound/postgres-process/` using the spike from
  `prototypes/postgres/`.
- External URL vs app-managed selection:
  - `OPERANT_DATABASE_URL` set: connect only;
  - absent: locate `OPERANT_PG_BIN_DIR`/PATH/container binaries, init/start/stop
    managed Postgres.
- Postgres client adapter with parameterized query helper, identifier quoting
  helper, transaction manager, and migration lock if needed.
- Platform schema migrations from `prototypes/platform-migrations/`, expanded
  with required MVP platform tables in minimal form.
- Idempotent startup: run platform migrations every boot.

**Dependencies:** chunk 0.

**Validation:**

- Integration with real Postgres: create temp data dir, start DB, run
  migrations, insert/select from a platform table, stop DB.
- External-mode test can use a provided `OPERANT_DATABASE_URL` when available;
  skip with clear message otherwise.
- Restart persistence validation: start server against a temp data dir, write a
  sentinel row through the Postgres adapter or a minimal diagnostic service,
  stop server, start it again with the same data dir, and assert the sentinel
  row and migration rows remain.
- Live scenario extends chunk 0: start server, verify `/health` reports
  DB/migration status over HTTP, restart server against the same data dir,
  verify migrations are idempotent and data remains visible through the scenario
  assertion.

**Exit criteria:** Every later chunk can assume a transaction-capable Postgres
adapter and platform migration table exist.

### 2. TypeBox/Ajv schemas, YAML parser, canonical pack loader, and source digests

**Goal:** Validate pack files before any database mutation.

**Implement:**

- `schemas/packs/` for Pack, Resource, Relationship, Lifecycle, Action, Hook,
  Policy, Seed v0 shapes.
- `adapters/outbound/yaml/` using `yaml` with merge-key support.
- Strict pack directory scanner:
  - known directories only;
  - child YAML must include `metadata.name`;
  - basename must match `metadata.name`;
  - hook YAML required for every hook script;
  - hook script references are basenames only;
  - no pack `docs/` directory.
- Canonical JSON normalization and deterministic digest calculation for source
  files/scripts.
- File/path-aware normalized validation errors.

**Dependencies:** chunk 0.

**Validation:**

- Unit: schemas reject bad names, unknown fields, filename mismatches, invalid
  hook script paths, custom tags/non-JSON values/multi-doc YAML.
- Adapter: parse YAML merge keys and assert canonical JSON has no YAML
  references.
- Live scenario: `optctl pack preview prototypes/crm-default-pack --json` must
  package the directory as multipart, call the real server route over HTTP, have
  the server scan and validate the upload, return normalized pack summary, and
  prove no DB mutation occurred by checking pack registry tables remain empty.

**Exit criteria:** CRM pack previews as valid through the real
`optctl -> HTTP -> server pack loader` path. If the pack is internally
inconsistent, fix the pack, not engine special cases.

### 3. Pack registry, metadata storage, and metadata/home APIs

**Goal:** Store validated pack metadata and expose agent-friendly discovery.

**Implement:**

- Pack registry tables and repositories: pack revisions, source files,
  resource/action/hook/policy/lifecycle/relationship/seed definitions.
- `preview_pack` service returns apply plan for first install.
- `apply_pack` for first install stores immutable revision metadata
  transactionally but can initially defer generated resource table DDL to chunk
  4 if needed.
- Metadata services/routes:
  - `GET /metadata/home`
  - `GET /metadata/packs`
  - `GET /metadata/packs/{namespace}/{name}`
  - `GET /metadata/resources/{namespace}/{resource}`
  - `GET /metadata/actions/{namespace}/{action}`
  - `GET /metadata/hooks/{namespace}/{hook}`
  - `GET /metadata/policies/{namespace}/{policy}`
- `optctl home` and `optctl metadata ...` with TOON default and `--json`.

**Dependencies:** chunks 1, 2.

**Validation:**

- Integration: apply CRM metadata, verify exact rows and script digests in
  Postgres.
- HTTP: metadata routes return expected CRM AXI guidance and schemas.
- CLI live scenario: `optctl pack apply prototypes/crm-default-pack`,
  `optctl home`, `optctl metadata resource default.lead`,
  `optctl metadata action default.convert_lead`; assert TOON contains expected
  resources/actions/help and `--json` contains equivalent structured fields.
- Glue validation: restart server and verify `optctl home` and metadata commands
  still load from Postgres, not in-memory state.

**Exit criteria:** Agents can discover the applied CRM pack through `optctl`,
and metadata survives restart.

### 4. Resource and relationship SQL compilation for first install

**Goal:** Compile pack definitions into queryable Postgres tables.

**Implement:**

- Resource DDL generator for table-per-resource current projections:
  - platform columns: id, version, archived fields, current_object_version_id,
    timestamps;
  - declared fields with Postgres types;
  - required fields as appropriate DB/runtime constraints;
  - safe identifier quoting.
- Relationship table DDL generator for `rel_*` tables.
- Minimal definition-to-DDL migration plan for first install.
- Apply DDL transactionally where Postgres allows; otherwise use clear migration
  step boundaries.
- Metadata records should link definitions to generated table names.

**Dependencies:** chunks 1-3.

**Validation:**

- Integration: apply CRM pack, introspect actual Postgres system
  catalogs/information_schema for tables/columns/constraints for `res_lead`,
  `res_opportunity`, and at least one `rel_*` table. Do not rely only on stored
  metadata rows.
- Live scenario: after `optctl pack apply`, call a debug/metadata or
  scenario-only assertion that verifies expected tables exist in Postgres; if
  exposed publicly, keep it under migration/metadata response rather than raw
  SQL.
- Negative validation: invalid field type or duplicate generated SQL identifier
  fails preview before mutation; assert no partial generated table remains.

**Exit criteria:** CRM resource and relationship tables exist in real Postgres
after pack apply.

### 5. Changeset preview/commit core, object versions, audit, and history

**Goal:** Make the write path real and observable.

**Implement:**

- Changeset v0 schemas: create, update, archive, transition, link, unlink,
  comment.
- `preview_changeset` service:
  - validates resources/fields/relationships;
  - resolves aliases;
  - performs current-row reads for diffs;
  - detects required field and type issues before SQL errors;
  - validates expected versions when provided.
- `commit_changeset` service:
  - revalidates preview or direct operations;
  - writes resource projections and relationship rows transactionally;
  - writes immutable `object_versions`;
  - updates `current_object_version_id`;
  - writes `audit_events` and `events`;
  - supports comments;
  - returns stable response envelope.
- History route and `optctl history`/`optctl view`.

**Dependencies:** chunks 1-4.

**Validation:**

- Unit: alias resolution, stable error mapping, optimistic version conflict
  detection.
- Integration: commit creates rows in resource table, object_versions,
  audit_events, events, comments.
- Live CRM scenario: using `optctl changeset preview/commit`, create a lead,
  update it, comment on it, archive it, inspect `optctl view` and
  `optctl history`; assert history shows immutable versions and current
  projection points at latest version.
- Glue validation: metadata from chunk 3 must drive field/resource validation;
  resource tables from chunk 4 must receive writes.

**Exit criteria:** A CRM lead can be created/updated/commented/archived through
`optctl`, and persisted history proves the write path.

### 6. Seeds through changeset-backed apply

**Goal:** Seed reference data through auditable writes, not special hidden
inserts.

**Implement:**

- Seed definition loader from pack metadata.
- Seed application path that lowers seed records to ordinary changeset
  operations or an equivalent changeset-backed/audited path.
- Idempotent seed reapply by stable seed key/resource identity.
- Seed audit/history marking so users can see seed provenance.

**Dependencies:** chunks 3-5.

**Validation:**

- Integration: CRM seed records create object_versions/audit/events.
- Live scenario: apply CRM pack, query `default.lead_status`,
  `default.opportunity_stage`, `default.sales_team`; reapply pack, assert no
  duplicate seeds and idempotent result.
- Glue validation: changeset commit code handles seed operations without
  bypassing validation/history.

**Exit criteria:** CRM reference data exists after pack apply and is
auditable/idempotent.

### 7. Expression lowering, query/list, projection, pagination, and cursor safety

**Goal:** Read data through SQL-lowered filters with stable pagination.

**Implement:**

- Expression adapter using `@bufbuild/cel` AST and conservative SQL lowerer from
  `prototypes/expression/`.
- `POST /queries` route and `query_objects` service.
- SQL filter lowering for MVP CEL subset.
- Field projection validation against metadata.
- Sort and keyset/cursor pagination.
- Cursor binding to filter/sort/projection/actor-policy digest.
- Archive handling: active by default; include archived only with permission
  once policy exists, or a temporary super_admin-only path until chunk 8.
- `optctl query` with TOON default and `--json`.

**Dependencies:** chunks 3-6.

**Validation:**

- Unit: CEL lowerer rejects unsupported functions, unknown fields, type
  mismatches, non-boolean roots, too-complex expressions.
- Integration: generated SQL uses parameters and returns expected
  lead/status/stage rows.
- Live CRM scenario: create multiple leads, query active leads by
  owner/status/email, paginate, request projected fields, verify cursor mismatch
  errors when changing filter/sort.
- Glue validation: query uses metadata from pack registry and rows from
  changesets/seeds.

**Exit criteria:** Agents can query CRM data safely through `optctl query`, with
real SQL and cursor correctness.

### 8. Policy engine integration across query, object read, changeset, action, and secrets

**Goal:** Enforce authorization as part of every meaningful operation.

**Implement:**

- Policy schema and loader from pack metadata.
- Actor context shape and CLI/API actor input convention.
- RBAC/ABAC/one-hop ReBAC compiler/evaluator from prototypes.
- SQL pushdown for query/list before pagination.
- Runtime policy checks for object reads, changeset operations, actions,
  metadata where sensitive, and secrets.
- `super_admin` audited bypass.
- Stable denial explanations and error codes.

**Dependencies:** chunks 3, 5, 7.

**Validation:**

- Unit: SQL/runtime parity for policy cases; deep ReBAC rejected.
- Integration: policy SQL is included before pagination and affects total
  returned rows.
- Live CRM scenario: create data owned by different actors/teams; run
  `optctl query` as sales_rep, manager, viewer, super_admin; attempt
  unauthorized update and action; assert stable denial and audit record.
- Glue validation: pagination cursors include actor/policy digest; changeset
  path from chunk 5 now refuses unauthorized operations.

**Exit criteria:** CRM operations are policy-controlled, and query results are
filtered before pagination.

### 9. Hook runner, hook attachments, validation hooks, action hooks, and after-commit outbox enqueue

**Goal:** Execute metadata-driven Deno hooks safely and connect them to
writes/actions/events.

**Implement:**

- Deno hook runner adapter from `prototypes/hooks/`:
  - stdin envelope;
  - stdout JSON schema validation;
  - stderr capture;
  - timeout;
  - Deno permission flags;
  - global permission policy;
  - script digest audit;
  - no imports initially.
- Hook attachment discovery from Hook YAML/resource/action/lifecycle/event
  metadata.
- Hook input mapping and input schema validation.
- Resource before-preview/before-commit validation hooks.
- Action hooks returning `changeset.operations.v1`.
- After-commit hook enqueue into durable outbox rows, but full worker processing
  can land in chunk 10.
- Action routes and `optctl action preview/commit`.

**Dependencies:** chunks 3, 5, 8.

**Validation:**

- Unit/adapter: permission failures, timeout, bad JSON, invalid output schema,
  stderr capture.
- Integration: CRM `normalize_lead`/`validate_lead` hooks modify or validate
  proposed lead data; action hook generates changeset operations.
- Live CRM scenario: create lead with normalization, attempt invalid lead
  rejected by hook, preview/commit `default.convert_lead`, verify
  contact/company/opportunity rows and history.
- Glue validation: action authorization from chunk 8 runs before action commit;
  generated operations reuse changeset path from chunk 5.

**Exit criteria:** CRM hooks/actions run from pack metadata without hardcoded
names.

### 10. Durable outbox worker, hook execution records, retry, and dead-letter operations

**Goal:** Make after-commit work durable and inspectable.

**Implement:**

- Outbox schema fields from spec: pending/running/succeeded/failed/dead_letter,
  attempts, available_at, locked_by, locked_at, last_error.
- Worker claim using `for update skip locked`.
- Retry/backoff and dead-letter after max attempts.
- `hook_executions` append-only records.
- `GET /outbox`, `POST /outbox/drain`, `POST /outbox/{id}/retry`.
- `optctl outbox status/drain/retry`.

**Dependencies:** chunks 5, 9.

**Validation:**

- Integration: two worker loops/drain calls do not double-claim the same row.
- Live CRM scenario: commit an operation that enqueues after-commit hook; run
  `optctl outbox status`, `optctl outbox drain`, verify hook_executions and
  outbox succeeded. Force a failing hook fixture and verify retry/dead-letter
  behavior if included in test pack.
- Glue validation: events from changesets feed outbox rows; hook runner from
  chunk 9 executes outbox hook.

**Exit criteria:** After-commit hooks are durable, observable, retryable, and do
not run inline in the committing transaction.

### 11. Secrets and encryption at rest

**Goal:** Support hook secrets safely.

**Implement:**

- Crypto adapter for application-level encryption/decryption.
- `platform_secrets` table and secret repository.
- Master-key startup behavior:
  - required for create/read/decrypt secret paths;
  - fail closed if encrypted secrets exist and key is missing.
- Secret policy checks and audited `super_admin` bootstrap.
- Secret routes: `GET /secrets`, `POST /secrets`, `DELETE /secrets/{name}`.
- `optctl secret list/set/delete` if included in MVP CLI surface, or at least
  server route + scenario harness command.
- Hook secret resolution/injection into narrow env vars.

**Dependencies:** chunks 8-10.

**Validation:**

- Unit: encrypt/decrypt round trip, wrong key fails, ciphertext differs from
  plaintext.
- Integration: DB never stores plaintext secret; audit events never include
  secret values.
- Live scenario: set a secret as super_admin/admin, run a hook that requires it,
  verify only declared env var is granted and output succeeds; remove
  key/missing secret and verify fail-closed behavior before spawn.
- Glue validation: hook runner from chunk 9 and policy engine from chunk 8
  participate in secret injection.

**Exit criteria:** Hooks can use declared secrets without leaking plaintext to
DB/logs/API responses.

### 12. Pack migration planning and safe/risky/destructive apply lifecycle

**Goal:** Upgrade packs safely.

**Implement:**

- Semantic diff between active and candidate normalized pack definitions.
- Migration issue classification from prototypes:
  - safe additive;
  - risky;
  - destructive;
  - unsupported/blocking.
- Live fact queries for row counts, violations, dependencies, nullability,
  indexes where needed.
- Migration plan persistence, digest, SQL preview, violations route.
- Safe additive apply.
- Staged destructive apply with deprecation metadata.
- Digest-bound confirmation for destructive cleanup.
- Cleanup/backfill guidance through ordinary changesets.
- Routes and CLI:
  - `optctl pack preview/apply` shows migration summary when active revision
    exists;
  - `optctl migration inspect/apply/confirm`.

**Dependencies:** chunks 2-8, especially changesets and pack registry.

**Validation:**

- Unit: classification matrix from migration prototypes.
- Integration: apply CRM v1-like pack, preview v2 candidate with
  safe/risky/destructive changes, inspect live facts, apply safe changes, stage
  destructive change, perform cleanup via changesets, confirm digest, verify
  audit.
- Live scenario: use CRM fixture plus a small migration fixture under tests;
  verify generated SQL and final table shape/data.
- Glue validation: migration cleanup uses changeset path from chunk 5; migration
  auth uses policy from chunk 8; pack registry updates only after successful
  apply.

**Exit criteria:** Pack upgrades are previewable, auditable, and safe enough for
MVP.

### 13. Project-management pack implementation and genericity validation

**Goal:** Prove the engine is not CRM-specific.

**Implement:**

- `prototypes/project-management-pack/` or `packs/project-management/` according
  to final repository convention.
- Resources/actions/hooks/policies/seeds from `spec/project-management-pack.md`.
- Deno hook scripts: `validate_task.ts`, `notify_project_change.ts`, plus action
  hooks if actions are hook-backed.
- AXI guidance for home/resource/action metadata.

**Dependencies:** chunks 2-12, with hooks/actions/policy/outbox available.

**Validation:**

- Live project scenario: apply project pack, create project, create task, start
  task, block task, unblock task, complete task, log timesheet entry, query
  tasks, read history, drain outbox.
- Negative scenario: non-member/non-assignee cannot update the task.
- Glue validation: same engine paths as CRM are used; no project-specific server
  code.

**Exit criteria:** Second pack applies and executes a full workflow through
generic pack/resource/action/hook/policy machinery.

### 14. CLI completeness, compiled binary, TOON golden outputs, and command ergonomics

**Goal:** Make `optctl` the primary agent interface.

**Implement:**

- Complete command groups required by specs:
  - `home`
  - `pack preview/apply`
  - `metadata ...`
  - `query ...`
  - `view ...`
  - `changeset preview/commit`
  - `action preview/commit`
  - `history ...`
  - `outbox status/drain/retry`
  - `migration inspect/apply/confirm`
  - secrets if exposed in MVP CLI.
- TOON default output and JSON output with `--json`.
- `--verbose` where useful.
- Error output follows stable envelope and includes helpful next-step commands.
- `deno compile` task for CLI binary.
- Golden output tests for representative success and error cases.

**Dependencies:** all feature chunks whose commands are exposed.

**Validation:**

- CLI contract tests for parsing and API URL construction.
- Golden TOON tests for home, metadata, query, changeset preview/commit, action
  preview/commit, migration inspect, outbox status, errors.
- Live scenario: execute every major command against a real server with CRM pack
  applied.
- Compile validation: `deno compile` produces a runnable binary; run binary
  against server and assert output.

**Exit criteria:** Agents can use the compiled `optctl` binary for all MVP
operations without relying on direct HTTP calls.

### 15. Container/dev environment and startup validation

**Goal:** Validate the intended production-like runtime.

**Implement:**

- Dockerfile or container build definition with Deno app/CLI and Postgres
  binaries available.
- Docker Compose file for one-command local run.
- Runtime env docs for `OPERANT_DATA_DIR`, `OPERANT_DATABASE_URL`,
  `OPERANT_PG_BIN_DIR`, `OPERANT_SECRET_MASTER_KEY`.
- Health checks for app and DB.
- Startup/shutdown behavior for app-managed Postgres.
- Minimal backup/restore command may be documented or stubbed if not
  MVP-critical; do not overbuild beyond acceptance criteria.

**Dependencies:** chunks 1, 14.

**Validation:**

- Build container.
- Run container/compose with no `OPERANT_DATABASE_URL`; verify app-managed
  Postgres starts, migrations run, `optctl home` works.
- Run against external Postgres service in Compose by setting
  `OPERANT_DATABASE_URL`; verify app does not start a managed DB.
- Restart container with persisted volume; verify data remains and migrations
  are idempotent.

**Exit criteria:** MVP can be run in the intended production-style container
modes.

### 16. Full-system CRM end-to-end validation and release hardening

**Goal:** Prove the MVP works as an actual platform, not just a set of tested
pieces.

**Implement/validate:**

Create a final scenario that runs from a clean data dir/container and performs
the complete CRM flow through compiled `optctl` against the real server:

1. Start server with app-managed Postgres.
2. Run platform migrations.
3. `optctl home` before packs.
4. `optctl pack preview prototypes/crm-default-pack`.
5. `optctl pack apply prototypes/crm-default-pack`.
6. Verify seeds/reference data through `optctl query`.
7. Inspect `default.lead` and `default.convert_lead` metadata.
8. Create a lead through changeset preview/commit.
9. Update the lead and add comments/activities.
10. Query with SQL-lowered filters and pagination.
11. Attempt unauthorized read/write and verify policy denial.
12. Preview/commit `default.convert_lead`.
13. Verify contact/company/opportunity were created/linked.
14. Log activity.
15. Mark opportunity won or lost through action/lifecycle path.
16. Drain outbox and verify hook execution records.
17. Inspect object history and audit/events.
18. Re-run an idempotent command and verify replay/conflict behavior.
19. Restart server and verify data/history still present.
20. Run a pack migration fixture and verify preview/apply/audit.

Also run the project-management scenario from chunk 13 as part of final
validation.

**Dependencies:** all previous chunks.

**Validation:**

- This chunk is itself the validation gate.
- It should not pass by only running unit tests.
- It must execute real flows and inspect real persisted results.
- Keep artifacts/logs for failures.

**Exit criteria:** The MVP is demonstrably usable end-to-end with CRM and
project-management packs through `optctl` and HTTP APIs.

## Risks and mitigation

- **App-managed Postgres complexity:** Startup, ports/sockets, shutdown, stale
  pid recovery, and binary packaging can be tricky. Mitigate by making chunk 1
  an early validation gate and testing both restart and external URL modes.
- **Deno/Postgres client behavior:** Raw SQL adapter details may reveal runtime
  edge cases. Mitigate by keeping SQL helpers tiny and adding adapter contract
  tests early.
- **Migration scope creep:** Pack migration can expand endlessly. Mitigate by
  implementing the MVP classification set from prototypes and rejecting
  unsupported changes with stable errors.
- **Policy/query coupling:** Policy must run before pagination. Mitigate by
  integrating policy before declaring query complete, and by cursor-binding
  actor/policy digest.
- **Hook nondeterminism:** Hooks can time out, fail permissions, or emit invalid
  JSON. Mitigate by treating hook runner as an adapter with strong contract
  tests and by making hook failures stable validation results.
- **Secret handling:** Easy to accidentally log or store plaintext. Mitigate
  with integration tests that inspect DB/audit/log fields for absence of
  plaintext.
- **Pack fixture drift:** CRM/project packs may expose schema gaps. Mitigate by
  fixing packs only when packs are inconsistent with specs; otherwise fix
  engine/spec mismatch explicitly.
- **CLI output churn:** TOON/golden outputs can make iteration noisy. Mitigate
  by stabilizing output envelopes and using `--json` for detailed debugging.
- **Container validation late failure:** If Docker packaging waits too long,
  binary/runtime assumptions may break. Mitigate by adding minimal container
  validation before final hardening if chunk 15 feels too late.

## Assumptions

- The real MVP source can be introduced under `src/` while preserving existing
  prototypes as evidence/reference.
- Deno can import the chosen npm/jsr packages in the target environment:
  - Hono,
  - Cliffy,
  - TypeBox,
  - Ajv,
  - `yaml`,
  - `@bufbuild/cel`,
  - `@toon-format/toon`,
  - a Postgres client selected during implementation.
- `direnv + shell.nix` remains the local way to provide Deno/Postgres tools for
  integration validation.
- No existing production users/data need migration from an earlier
  implementation.

## Unresolved questions to preserve

These should not block planning, but implementers should make explicit choices
when encountered:

- Exact Deno Postgres client package and pooling defaults.
- Exact Docker image layout for bundled Postgres binaries.
- Whether app-managed Postgres should prefer Unix sockets over TCP where
  available.
- Exact backup/restore command surface for MVP vs post-MVP.
- Whether secret CLI commands are required in MVP or can remain
  HTTP/scenario-only if hook-secret acceptance is covered.
- Exact location/name for bundled packs in the final source tree (`packs/`,
  `prototypes/`, or another convention). CRM fixture is currently
  `prototypes/crm-default-pack/` and must remain canonical until moved
  deliberately.

## Non-goals for MVP

- SaaS multi-tenancy as a core design center.
- SQLite runtime support.
- PGlite production/runtime support.
- Odoo cloning or field-level Odoo compatibility.
- OpenAPI generation as a release blocker.
- Rust server or Rust CLI.
- Deep/transitive ReBAC.
- Arbitrary hook runtimes or hook dependency/import support.
- Direct SQL as the product interface.
- UI-first product surface.
- Global outbox ordering guarantees.
- Advanced migration backfills beyond the conservative MVP set.
- Secret key rotation, unless it becomes unavoidable during implementation.

## Self-review notes

- The plan is chunkable: each chunk has dependencies, boundaries, validation,
  and exit criteria.
- The chunks are ordered so that every later capability validates glue to
  earlier pieces, not just isolated functions.
- The final chunk is explicitly full-system execution with CRM and
  project-management packs, not just unit/integration tests.
- No placeholders such as `TBD` remain. Real uncertainties are listed explicitly
  under unresolved questions.
- Scope is limited to the platform-engine MVP; post-MVP ideas are listed as
  non-goals.
