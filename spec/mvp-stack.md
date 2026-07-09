# MVP Stack Decisions

## Decisions

### Server

Use **Deno + Hono** for the MVP API server.

Rationale:

- Close to the current Deno prototypes.
- Lightweight routing without NestJS-level framework ceremony.
- Good fit for Fetch-compatible request/response handling.
- Keeps server iteration fast while core semantics stabilize.
- Does not prevent a later Rust server if performance requirements demand it.

Avoid NestJS for the MVP unless the project later needs its module/decorator/DI
model. The platform's hard problems are storage correctness, policy/query
lowering, changesets, hooks, migrations, and outbox behavior; a heavy HTTP
framework does not solve those.

### CLI

Use **Deno + Cliffy** for the MVP `optctl` CLI.

Rationale:

- Deno-native command framework.
- Faster to iterate than Rust while the command surface is still changing.
- Avoids needing to implement a custom TOON parser/serializer in Rust
  immediately.
- Keeps hooks, server prototype, and CLI in one language/runtime for the MVP.

Keep boundaries clean so a future Rust CLI remains possible:

- `optctl` talks to the server through HTTP APIs.
- `optctl` owns CLI parsing and output formatting only.
- Business rules remain server-side.
- TOON formatting/parsing is isolated behind an interface/module.
- Command output contracts are covered by golden tests.

### SQL access

Use **raw SQL** with small typed helpers; do not use Knex or a heavy ORM for
core platform logic.

Rationale:

- The system needs precise Postgres behavior: transactions, row locks,
  `for update skip locked`, keyset pagination, JSONB, partial indexes, migration
  introspection, advisory locks if needed, and generated DDL.
- Query/policy lowering should produce auditable SQL.
- ORMs/query builders can obscure transaction and SQL behavior without removing
  the core complexity.

Expected shape:

- Explicit SQL strings or SQL files.
- Parameterized queries only.
- Small helper for safe identifier quoting.
- Typed result decoding/validation at module boundaries.
- Storage modules organized by subsystem: packs, changesets, query, policy,
  hooks, outbox, migrations.

### Pack parsing and validation

Use the `yaml` package plus schema validation, then normalize to canonical JSON.

Requirements:

- Enable merge-key support for deterministic YAML authoring sugar.
- Reject custom tags, non-JSON values, executable YAML features, and
  multi-document files.
- Treat anchors/aliases/merge keys as authoring sugar only; do not preserve YAML
  references in canonical JSON.
- Produce file/path-aware validation errors.
- Validate strict pack layout and `metadata.name`/filename matching.
- Store canonical JSON plus source files/scripts by digest.

### API schema / OpenAPI

OpenAPI is useful but not required as the MVP's primary agent interface.

Decision:

- The primary agent interface is `optctl`, backed by metadata/AXI APIs and
  compact TOON output.
- The server should still expose stable HTTP JSON contracts with explicit
  schemas in code/tests.
- Do not make OpenAPI generation a blocker for MVP.
- Consider generating or maintaining OpenAPI later for SDKs, external
  integrations, and documentation once the API stabilizes.

Near-term API contract discipline:

- Define request/response schemas near route handlers or service boundaries.
- Use stable error envelopes.
- Add golden tests for `optctl` output and focused HTTP contract tests for
  server behavior.
- Keep HTTP routes language-neutral so a future Rust CLI/server remains
  possible.

### Runtime direction

Use Deno now for:

- MVP server
- MVP `optctl`
- Hook runtime
- Executable tests/prototypes

Defer Rust until there is concrete evidence that startup time, memory, or
concurrency requirements justify the cost. A future Rust `optctl` remains
possible if the Deno CLI becomes too slow or too resource-heavy.

## Initial MVP stack summary

```text
server:      Deno + Hono
cli:         Deno + Cliffy
hooks:       Deno/TypeScript
sql:         raw SQL + typed helpers
storage:     app-managed or external Postgres; app-managed Postgres for integration tests
api schema:  explicit schemas/tests now, OpenAPI later if needed
output:      TOON for optctl, JSON for HTTP
```
