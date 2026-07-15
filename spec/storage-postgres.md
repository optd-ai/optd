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

- platform migrations and built-in `projects`
- immutable `pack_revisions`/source files plus one active-pack pointer
- immutable resource/relationship/lifecycle/action/hook/role/policy/seed
  definition revisions and hook attachments
- generated project-scoped current resource/relationship tables
- immutable stage evidence, lifecycle coordination, approval requirements/
  decisions, and exactly-once `changeset_commits` exactly as named in
  `staged-changeset-storage.md`
- `object_versions`, append-only comments, `auth_contexts`, `audit_events`, and
  committed `events` from `events-audit.md`
- normalized users/credentials/sessions/requests/authorizations/assignments from
  `authentication.md` and `authorization-assignments.md`
- durable outbox deliveries/attempts/retry generations from
  `outbox-delivery.md`
- global encrypted secrets and revision-specific hook-secret grants
- immutable migration plans, append-only validations/apply attempts, and one
  atomic active-revision application record per successful plan

There are no generic mutable `changesets`, `changeset_previews`, stage
idempotency-key, artifact, attachment, or undeclared-extension tables in MVP.

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

## Planning status

- Resource definitions normalize to immutable definition revisions and semantic
  migration plans before generated SQL; pack activation never compiles and
  applies unreviewed source directly.
- MVP full-text uses Postgres-native indexing only where a resource explicitly
  configures it. Semantic/vector indexing is deferred.
- Connection-pool, queue, and backpressure numbers are deployment configuration
  to benchmark during implementation; they do not change storage semantics and
  are not a design blocker.
