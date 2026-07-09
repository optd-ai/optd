# MVP Roadmap and Prototype Gaps

## Current prototype status

The integrated Deno/PGlite vertical slice proves the core product loop:

1. Apply the default CRM pack by HTTP multipart.
2. Compile resources and relationships to SQL tables.
3. Store pack metadata, hooks, actions, policies, lifecycles, and seeds.
4. Lower seeds into ordinary changesets.
5. Preview/commit changesets.
6. Run Deno hooks for normalization, validation, actions, and after-commit
   outbox work.
7. Record object versions, audit events, committed events, outbox rows, and hook
   executions.
8. Query resources through `POST /queries`.
9. Inspect object history.
10. Exercise the flow through a minimal Deno `optctl` shim.

This is a concept-complete prototype, not an MVP implementation.

## Missing functionality to carry forward

### optctl ergonomics

- `optctl home` as an agent-friendly landing page/status/affordance map.
- `optctl metadata` for packs, resources, actions, hooks, lifecycles, policies,
  and seeds.
- `optctl view` for one object.
- `optctl changeset preview`.
- `optctl outbox status/drain`.
- Compact default output with `--verbose` and `--json` modes.
- Better command suggestions and stable errors.
- Output driven by pack/resource/action `axi` guidance.

### Query and pagination

- Integrate the real CEL subset parser/lowerer into the vertical slice.
- Sort support.
- Keyset/cursor pagination.
- Cursor binding to filter/sort/actor/policy digest.
- Field projection validation.
- Relationship/reference filters.
- Archived-object handling and permissions.
- Better unsupported-filter diagnostics.

### Policy enforcement

- Enforce stored policies; current vertical slice mostly stores them.
- Actor context and identity shape.
- RBAC, ABAC, and one-level ReBAC checks.
- SQL pushdown for list/query before pagination.
- Action authorization.
- Changeset operation authorization.
- Denial explanations and stable error codes.

### Metadata-driven hooks

- Replace hardcoded hook names with attachment discovery from hook YAML.
- Support attachment phases by resource/action/event.
- Hook ordering.
- Hook conditions using the expression language.
- Hook input mapping from current/proposed/action/event context.
- Declared input schema validation.
- Timeout and Deno permission enforcement from the hook runner prototype.
- Multiple hooks per phase.

### Validation and correctness

- Required field validation before SQL errors.
- Unknown field rejection.
- Type validation.
- Lifecycle transition validation.
- Optimistic locking / expected version enforcement.
- Relationship target validation.
- Constraint violation normalization into stable errors.
- Better all-or-nothing validation output.

### Idempotency and retries

- Idempotency keys for changeset commit.
- Replay same response for same key/payload.
- Conflict for same key/different payload.
- Action idempotency.
- Seed idempotent reapply.
- Safe agent retry behavior.

### Migrations

- Apply a v2 pack over an existing v1 pack in the integrated server.
- Migration preview.
- Safe/risky/destructive classification.
- Staged destructive migrations.
- Digest-bound confirmation.
- Migration audit trail.
- Cleanup/backfill through ordinary changesets.

### Outbox and hook execution

- Durable worker loop.
- Locking and leases.
- Retry/backoff.
- Dead-letter state.
- Idempotent hook execution where needed.
- Structured logs.
- Replay/retry commands.
- Batch draining.

### Concurrency and performance

- Concurrent changeset tests.
- Conflicting update tests.
- Action double-submit tests.
- Concurrent outbox worker tests.
- Pack apply versus concurrent read/write behavior.
- DB pool/backpressure behavior.
- Larger datasets for query/pagination performance.

### Pack authoring and validation

- `yaml` package parsing with merge-key support and explicit rejection of
  non-canonical/non-JSON features.
- TypeBox/Ajv schema validation with file/path-aware errors.
- Canonical JSON normalization.
- Better diagnostics for missing/invalid references.
- Pack metadata APIs for discovery.

## MVP target

The MVP should be the smallest implementation that can safely run the CRM pack
locally, run a second project-management pack, and provide agent-friendly
operations:

- One containerized local/server deployment backed by external or app-managed
  real Postgres.
- Pack apply/preview with strict validation.
- Changeset preview/commit with idempotency, optimistic locking, validation,
  policy, audit/history, and stable errors.
- Query/list with SQL-lowered filters, policy pushdown, field projection, and
  cursor pagination.
- Metadata-driven Deno hooks with permissions/timeouts.
- Actions as hook/declarative operation generators.
- Object history and audit/event/outbox records.
- A usable `optctl` with home, metadata, query, view, changeset preview/commit,
  action preview/commit, history, and outbox basics.
