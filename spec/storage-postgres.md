# Postgres Storage

## Direction

The project is open-source and single-tenant by default. MVP storage is Postgres
only, either:

1. external Postgres via `OPERANT_DATABASE_URL`, or
2. app-managed local Postgres when `OPERANT_DATABASE_URL` is absent.

PGlite remains useful for focused prototypes. SQLite is out of MVP scope unless
a later planning cycle deliberately revives it.

## Postgres as coordination layer

Postgres mode supports horizontal scaling with Postgres as the only required
coordination layer:

- Transactions.
- Row locks where necessary.
- Optimistic version checks.
- Unique constraints.
- Advisory locks only if absolutely needed and object/resource-scoped.
- `for update skip locked` worker queues for outbox or background jobs.

Avoid requiring Redis, ZooKeeper, etcd, Kafka, or a central policy service for
correctness in the default deployment.

## Core Tables Sketch

Initial MVP table families:

- generated resource tables such as `res_lead`, `res_contact`, `res_company`,
  each with `current_object_version_id`
- generated relationship tables such as `rel_contact_company`
- `platform_schema_migrations`
- `pack_revisions`
- `pack_files`
- `resource_definitions`
- `field_definitions`
- `relationship_definitions`
- `lifecycle_definitions`
- `action_definitions`
- `hook_definitions`
- `policy_definitions`
- `seed_definitions`
- `changesets`
- `changeset_operations`
- `changeset_previews`
- `object_versions`
- `approvals`
- `idempotency_keys`
- `audit_events`
- `events`
- `outbox`
- `hook_executions`
- `object_comments`
- `artifacts`
- `attachments`
- `migration_plans`
- `migration_steps`
- `resource_health_checks`
- `platform_secrets`

## Constraints

Resource configuration should map to database-level constraints where possible:

- Required fields.
- Unique constraints.
- Composite unique constraints.
- Foreign-key references.
- Check constraints.
- Enum-like constraints.
- Indexes.

The platform should report whether each constraint is enforced by:

- database only,
- runtime only,
- both, or
- unsupported.

For MVP, previews and metadata should assume Postgres capabilities. Runtime-only
enforcement is still allowed for invariants that cannot be safely expressed as
SQL constraints.

## JSONB and indexing

Extension payloads can use JSONB. Declared extension fields need explicit
indexing strategy and migration/reindex workflows.

Expected Postgres tools:

- JSONB columns for flexible extension payloads and metadata.
- GIN indexes where justified.
- Generated columns or side tables for high-value queryable extension fields.
- Partial indexes from SQL-lowerable expressions when safe.

## Single-tenant implication

Remove tenant isolation as a default design center. If multi-tenant support
appears later, it should be layered rather than infecting the core open-source
model.

## Open questions

- Should resource definitions compile directly to migration plans or through an
  intermediate storage model?
- Full-text and semantic index storage choices.
- Exact connection pool and backpressure defaults for Deno/Postgres.
