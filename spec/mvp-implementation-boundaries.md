# MVP Implementation Boundaries

This file freezes the implementation structure for MVP planning. Subagents
should treat this as the source of truth for module boundaries.

## Top-level source layout

```text
src/
  domain/
    actions/
    changesets/
    errors/
    events/
    hooks/
    ids/
    migrations/
    objects/
    outbox/
    packs/
    policies/
    queries/
    resources/
    secrets/

  application/
    services/
      apply_pack.ts
      preview_pack.ts
      plan_migration.ts
      apply_migration.ts
      preview_changeset.ts
      commit_changeset.ts
      run_action.ts
      query_objects.ts
      get_object.ts
      inspect_history.ts
      process_outbox.ts
      manage_secret.ts
      inspect_metadata.ts
    ports/
      clock.ts
      id_generator.ts
      pack_repository.ts
      object_repository.ts
      changeset_repository.ts
      migration_repository.ts
      policy_engine.ts
      expression_lowerer.ts
      hook_runner.ts
      outbox_repository.ts
      secret_store.ts
      transaction_manager.ts
      metadata_repository.ts

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

  schemas/
    api/
    packs/
    changesets/
    hooks/
    policies/
    metadata/

  config/
  main_server.ts
  main_optctl.ts
```

## Boundary rules

- `domain/` contains pure domain types, invariants, state transitions, and
  stable error definitions.
- `application/` orchestrates use cases and transactions. It depends on ports,
  not concrete adapters.
- Inbound adapters translate HTTP/CLI inputs into application commands and
  format outputs.
- Outbound adapters implement ports for Postgres, app-managed Postgres process
  lifecycle, Deno hook execution, YAML parsing, TOON formatting, cryptography,
  clocks, and IDs.
- Hono must not be imported outside `adapters/inbound/http-hono/`.
- Cliffy must not be imported outside `adapters/inbound/cli-cliffy/`.
- Concrete Postgres clients and raw SQL must not be imported outside
  `adapters/outbound/postgres/` and `adapters/outbound/postgres-process/`.
- Deno hook spawn code must not be imported outside
  `adapters/outbound/deno-hooks/`.
- TOON encoding must not be imported outside `adapters/outbound/toon/` or the
  CLI adapter that calls it.
- TypeBox/Ajv schemas are the canonical external contract definitions and live
  under `schemas/` or route-adjacent schema modules.
- Application services return JSON-compatible DTOs and stable error envelopes.

## Storage boundary

MVP storage is Postgres only:

1. external Postgres via `OPERANT_DATABASE_URL`, or
2. app-managed local Postgres when the URL is absent.

PGlite remains a prototype dependency only. SQLite is out of MVP scope.

## Transaction rules

- Use an application-level `TransactionManager` port.
- Changeset commit, pack apply, migration apply, secret set/delete, and outbox
  claiming must run through explicit transactions.
- Hooks that run before commit participate logically in validation but execute
  outside SQL transactions unless the implementation explicitly proves a safe
  timeout/cancellation behavior.
- After-commit hooks run from durable outbox rows, never inline as part of the
  committing transaction.

## Pack boundary

- Pack source is strict directory-based YAML plus hook scripts.
- `optctl` packages a directory into multipart upload.
- The server validates layout, parses YAML, validates TypeBox/Ajv schemas,
  normalizes to canonical JSON, stores source records by digest, and compiles
  the pack.
- Pack application and pack upgrade both flow through migration planning.

## CLI/server contract

- `optctl` is API-first: it calls server HTTP JSON APIs.
- `optctl` may keep dotted identifiers such as `default.lead`; it translates
  them to Proposal A path parameters or JSON fields expected by the API.
- `optctl` owns output formatting only. It must not reimplement server business
  rules.

## Test strategy

- Unit tests can use pure domain/application ports with fakes.
- Adapter contract tests cover Hono route schemas, Cliffy command parsing, TOON
  output, YAML parsing, hook execution, and Postgres SQL behavior.
- Integration tests use app-managed Postgres when binaries are available through
  `direnv + shell.nix`.
- Focused prototypes may continue using PGlite when the purpose is not
  runtime/lifecycle fidelity.
