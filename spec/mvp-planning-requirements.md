# MVP Planning Requirements

## Product target

The MVP target is the **platform-engine MVP**, not a CRM-only product demo.

The default CRM pack remains the proof fixture and bundled example, but the MVP
must support user-authored packs and generic resource operations.

## Required MVP capabilities

### Deployment/storage

- Production deployment is container-only: Docker Compose or Kubernetes.
- The production container bundles the Postgres binary.
- Use bundled/app-managed Postgres for the MVP runtime by default.
- Support external Postgres through `OPERANT_DATABASE_URL`.
- Use app-managed Postgres in tests as well, so tests exercise startup,
  lifecycle, connection, and operational behavior of the same database mode
  users run locally.
- Use `direnv` + `shell.nix` in this repository so Deno, Postgres, and related
  integration-test tooling are available as raw processes.
- PGlite remains useful for focused prototypes, but not as the MVP test/runtime
  default.

### Pack lifecycle and migrations

Pack upgrade/migration support is required for MVP. The platform is not useful
if users can install a pack but cannot safely upgrade it.

MVP migration scope must include:

- Apply a new pack over an active pack.
- Semantic config diff.
- Safe/risky/destructive classification.
- Migration preview.
- Live-fact validation for violations/dependencies where needed.
- Apply safe additive changes.
- Staged destructive flow.
- Digest-bound destructive confirmation.
- Cleanup/backfill through ordinary changesets.
- Migration audit trail.

The focused migration prototypes are relatively fleshed out, but this is **not
yet integrated** into the vertical-slice server. MVP work must integrate those
semantics with pack registry, SQL schema changes, changesets, audit/history, and
`optctl`.

### Policy

Policy enforcement is required for MVP.

MVP policy scope must include:

- Actor context.
- RBAC and ABAC.
- One-level ReBAC if relationship-backed access is needed by default packs.
- SQL pushdown for query/list before pagination.
- Action authorization.
- Changeset operation authorization.
- Denial explanations and stable error codes.

The focused policy prototype is fleshed out for SQL/runtime parity, including
one-level ReBAC and deep-ReBAC rejection, but this is **not yet integrated**
into the vertical-slice server. MVP work must integrate policies into query,
action, and changeset paths.

### Hooks

Metadata-driven Deno hooks with safety controls are required for MVP.

MVP hook scope must include:

- Hook attachment discovery from pack metadata.
- Resource/action/event phases.
- Hook input mapping and input schema validation.
- Output schema validation.
- Deno permission enforcement.
- Global permission policy.
- Timeouts.
- stderr log capture.
- Script digest audit.
- Outbox execution for after-commit hooks.

The focused hook runner and hook attachment prototypes are fleshed out
independently, but MVP work must integrate them into the main server.

### optctl

Use Deno + Cliffy for MVP `optctl`.

Required MVP command groups:

- `optctl home`
- `optctl pack preview/apply`
- `optctl metadata ...`
- `optctl query ...`
- `optctl view ...`
- `optctl changeset preview/commit`
- `optctl action preview/commit`
- `optctl history ...`
- `optctl outbox status/drain`
- `optctl migration inspect/apply/...`

Output should use TOON by default, with `--json` and `--verbose` options.

## Hexagonal architecture decision

Use the frozen structure in
[MVP Implementation Boundaries](mvp-implementation-boundaries.md). In summary,
use a hexagonal/ports-and-adapters structure so core behavior is independent of
Hono, Cliffy, Postgres client details, and hook process execution.

```text
src/
  domain/
    packs/
    resources/
    changesets/
    actions/
    hooks/
    policies/
    queries/
    migrations/
    history/
    outbox/
    errors/

  application/
    services/
      apply_pack.ts
      preview_changeset.ts
      commit_changeset.ts
      run_action.ts
      query_objects.ts
      inspect_history.ts
      process_outbox.ts
      plan_migration.ts
    ports/
      pack_repository.ts
      object_repository.ts
      transaction_manager.ts
      hook_runner.ts
      policy_engine.ts
      migration_planner.ts
      clock.ts
      id_generator.ts

  adapters/
    inbound/
      http-hono/
      cli-cliffy/
    outbound/
      postgres/
      deno-hooks/
      toon/
      yaml/

  config/
  main_server.ts
  main_optctl.ts
```

Rules:

- Domain/application layers do not import Hono, Cliffy, or a concrete Postgres
  client.
- Inbound adapters translate HTTP/CLI inputs into application commands.
- Outbound adapters implement ports for SQL storage, hook execution, YAML
  parsing, TOON formatting, IDs, and time.
- Transactions are controlled by an application-level transaction manager port.
- Raw SQL lives in the Postgres adapter modules.
- Tests can use the same app-managed Postgres adapter as production-local
  runtime.

## Validation library options

### TypeBox + Ajv

Pros:

- JSON Schema first; useful if OpenAPI/SDK/docs are added later.
- Good for validating external JSON payloads and pack config.
- Ajv is mature and fast.
- Schemas can be reused for HTTP contract tests and persisted config validation.
- Easier path to generated API documentation later.

Cons:

- More ceremony than Valibot.
- Type inference can feel less ergonomic than parser-first libraries.
- Ajv error messages often need normalization to become agent-friendly.
- JSON Schema expressiveness does not naturally model every TypeScript/domain
  invariant.

Best fit:

- Pack config schemas.
- HTTP request/response contracts.
- Persisted normalized JSON validation.
- Future OpenAPI/SDK compatibility.

### Valibot

Pros:

- Lightweight and ergonomic TypeScript-first validation.
- Good inferred types.
- Pleasant for application boundary validation.
- Smaller and simpler than Ajv for many internal command schemas.
- Easier custom validation composition in TypeScript.

Cons:

- Not JSON Schema first.
- We would need extra work if we later want OpenAPI/JSON Schema generation.
- Less ideal as the canonical pack-schema format if external tools need to
  consume schemas.
- Ecosystem/maturity is smaller than Ajv/JSON Schema.

Best fit:

- Internal application commands.
- CLI input normalization.
- Service boundary validation.

### Decision

Use **TypeBox + Ajv** for MVP validation.

Rationale:

- Pack schemas are external user-authored contracts, not just internal
  TypeScript types.
- JSON Schema portability matters for future docs, tooling, editor support,
  SDKs, and possible OpenAPI generation.
- Ajv is mature and fast enough for request/config validation.
- TypeBox keeps schema definitions close to TypeScript types.

OpenAPI generation remains optional and non-blocking, but TypeBox + Ajv gives a
clean path to generate or derive OpenAPI later if needed. Valibot remains a good
library, but using one validation system is simpler for MVP.

Executable spike: `prototypes/typebox/` validates the integration shape across
YAML pack parsing/normalization, pack config validation, changeset v0 operation
schemas, hook envelope/output schemas, Hono request validation, metadata
derivation, and optional future OpenAPI document shape.

## YAML

Use the `yaml` package for MVP parsing, with merge-key support enabled. Keep
canonicalization separate:

- Parse YAML source.
- Reject custom tags, non-JSON values, executable YAML features, and
  multi-document files.
- Treat anchors, aliases, and merge keys as authoring sugar only; canonical JSON
  must not preserve YAML references.
- Validate resulting JS value with TypeBox/Ajv.
- Normalize to canonical JSON for storage/diffing.

## TOON package research

Existing packages found:

- `@toon-format/toon` — current package, MIT, describes itself as Token-Oriented
  Object Notation for compact schema-aware JSON encoding.
- `@toon-format/cli` — CLI companion for JSON ↔ TOON conversion.
- `@toon-format/spec` — official spec package.
- Other alternatives include `@programsmagic/toon-format`, `tooner`, and
  `@toonify/toonify`.

Decision: start with `@toon-format/toon` for MVP output if it works in Deno/npm
imports. Keep TOON use isolated behind an adapter so we can replace it if
compatibility or output-shape issues appear.

## Why codified schemas are still needed

Even if `optctl` is the primary agent interface and exposes metadata/AXI,
codified schemas are needed for correctness and compatibility:

- Validate untrusted/user-authored pack files.
- Validate HTTP request bodies and return stable errors.
- Validate hook inputs/outputs.
- Validate persisted canonical config before storage.
- Validate changeset/action payloads before executing transactions.
- Produce metadata that `optctl` can expose to agents.
- Enable migration diffing against normalized, typed shapes.
- Keep tests precise and prevent accidental contract drift.

OpenAPI generation is optional; schemas are not. OpenAPI can be
generated/maintained later once HTTP APIs stabilize.
