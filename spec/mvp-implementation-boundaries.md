# MVP Implementation Boundaries

## Decision

This file freezes dependency/module boundaries for the next implementation plan.
Exact filenames may remain small/use-case-oriented, but responsibilities must not
collapse across these layers.

## Source layout

```text
src/
  domain/
    auth/ authorization/ projects/
    packs/ definitions/ migrations/
    changesets/ approvals/ operations/
    objects/ relationships/ comments/ history/
    expressions/ policies/ queries/
    hooks/ secrets/ outbox/
    events/ audit/ ids/ errors/

  application/
    services/
      auth/ projects/ packs/ migrations/
      changesets/ actions/ seeds/
      queries/ history/ metadata/
      policies/ secrets/ outbox/
    ports/
      transactions + clock + UUIDv7
      auth/session/authorization/request repositories
      role/policy assignment repositories
      project/pack/definition/migration repositories
      stage/object/history/event/audit repositories
      expression lowerer + policy evaluator
      hook runner + secret cryptography/store/grant resolver
      outbox repository/provider execution
      local process binding/credential provider (CLI composition only)

  adapters/
    inbound/
      http-hono/
      cli-cliffy/
    outbound/
      postgres/
      postgres-process/
      deno-hooks/
      yaml/
      toon/
      crypto/
      process-inspection/
      local-auth-store/

  schemas/
    api/ auth/ packs/ migrations/ changesets/
    hooks/ policies/ queries/ metadata/

  config/
  main_server.ts
  main_optctl.ts
```

## Dependency rules

- `domain/` contains pure types/invariants/transitions/stable error codes and has
  no Hono, Cliffy, Postgres, Deno subprocess, YAML, TOON, or filesystem imports.
- `application/` orchestrates use cases/transactions through ports. It never
  parses public transport shapes or emits CLI text.
- Inbound adapters validate TypeBox/Ajv DTOs, authenticate, create immutable auth
  context, invoke one application service, and wrap the shared API envelope.
- Outbound adapters own raw SQL, process startup/inspection, hook spawning, YAML,
  cryptography, local auth files, and TOON encoding.
- Hono/Cliffy/Postgres client/hook spawn/process-inspection imports stay inside
  their named adapters.
- TypeBox schemas are the executable external contract and correspond to the
  frozen specs; `additionalProperties: false` is the default.
- Application services return JSON-compatible data DTOs or typed stable errors,
  never prewrapped HTTP envelopes.

## Authentication boundary

- Every protected HTTP request resolves exactly one opaque bearer credential;
  callers cannot inject actor/role/process evidence.
- Authentication/session/authorization resolution and immutable auth-context
  creation occur before protected application work. Authorization services
  consume server-derived context only.
- CLI local process ancestry/credential selection is not sent to the server. It
  lives behind process-inspection/local-credential ports and selects one nearest
  token with no fallback after denial.
- Password hashing uses a bounded worker/concurrency service so request handlers
  can return the frozen saturation behavior without blocking unrelated work.
- Hooks/outbox receive internal invocation capability and causation IDs, never
  bearer tokens or initiating roles.

## Postgres and transaction boundary

Postgres is the only runtime database in external or app-managed mode. No
correctness path depends on PGlite, Redis, Kafka, filesystem locks, or in-memory
single-process state.

Explicit transactions are required for:

- bootstrap/recovery/session/authorization/assignment mutations;
- project create/update/archive;
- final successful stage persistence and lifecycle/approval/cancel mutation;
- changeset commit under the canonical lock protocol;
- whole-plan migration apply and active-pack activation;
- secret create/rotate/disable and hook-secret grant mutation;
- committed object versions/audit/events/outbox insertion;
- outbox claim/completion/retry/cancel state transitions.

Stage hooks execute outside a long SQL transaction. The service reads versioned
facts, executes hooks, normalizes/validates, then atomically persists all stage
evidence only on success. Dependencies become commit-time revalidation facts;
failed staging persists no stage rows.

Outbox polling is one async loop per main server process/container using
Postgres `SKIP LOCKED`; horizontally scaled loops share the same protocol.

## Pack/migration boundary

- CLI scans one strict local directory and submits multipart preview.
- Server repeats path/layout/YAML/TypeBox/cross-reference/static hook validation,
  canonicalizes source, stores/reuses immutable candidate revision, and creates
  a durable migration plan.
- Pack apply is not another upload/parser path. It applies one exact ready
  migration plan and activates the reviewed revision in the same all-or-nothing
  transaction.
- Generated SQL and physical table identifiers are produced only in the
  Postgres pack/migration adapter through safe identifier helpers.

## Changeset/action/seed boundary

- Direct staging, semantic actions, and seed reconcile all converge on one
  operation normalization/validation/persistence service.
- Action hooks and seed expansion can author operations only within reviewed
  manifests and one project; direct changesets may span projects.
- No service regenerates operations or reruns synchronous hooks at commit.
- Stage immutable evidence and lifecycle coordination use the exact storage
  split in `staged-changeset-storage.md`.
- Object/history/event/audit/outbox writes are one commit transaction; external
  delivery never affects commit success.

## Query/policy boundary

- CEL parsing/lowering is one shared service with context-specific symbol tables.
- Query and policy predicates are lowered to parameterized SQL and applied before
  sort/keyset/limit/count. No application post-filter pagination is permitted.
- Route/CLI adapters pass the same strict query DTO; CLI only resolves local
  project context and renders DTOs.
- Policy definitions/assignments and current authorization are loaded by ports;
  role strings supplied in request DTOs are rejected before evaluation.

## Hook/secret boundary

- Deno runner receives stored script bytes plus curated envelope and resolved
  granted secret env values from application services. It has no DB repository,
  self-API token, general filesystem, subprocess, import, or ambient env access.
- Secret crypto adapter alone handles plaintext/key material. Repositories store
  ciphertext metadata and never return plaintext DTOs.
- Outbox service loads pinned code/grants and current secret value under the
  frozen delivery contract.

## CLI/server contract

- Server HTTP JSON is canonical; `optctl --json` preserves it and default output
  renders TOON.
- CLI sends publisher-qualified definition identities plus explicit project UUID
  resolved from context. Dotted namespace/project aliases are unsupported.
- Direct commit commands are client orchestration of stage then commit; there is
  no combined server use case.
- CLI must not duplicate schema, policy, migration, hook, seed, or changeset
  business decisions.

## Verification boundary

- Unit tests cover pure invariants/services with fakes only where concurrency/SQL
  semantics are irrelevant.
- TypeBox route contracts, Cliffy parsing/exit status, YAML strictness, TOON
  golden output, process binding, crypto, and hook sandbox have adapter tests.
- Real Postgres integration tests cover migrations, auth state, policy SQL,
  staging persistence, lock races, exactly-once commit, history/events, secrets,
  and outbox leases/retries.
- Public compiled-CLI scenarios cover bootstrap/login/agent request, CRM and
  project packs, multi-project changesets, approvals, revocation, migration,
  seeds, queries/history, and delivery.
- Container smoke covers app-managed and external Postgres. PGlite remains
  prototype evidence only.
