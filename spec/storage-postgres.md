<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-storage-postgres; contract: 1; input: sha256:01e172372c7d7cab4e00d8acb91a327b66b00ad7e3bcf01847f2c6d7562c3478 -->

# Postgres Storage

Generated exact-contract projection imported into project-model/model.json from the reviewed storage-postgres.md source.

## Exact migrated contract

<a id="obj-com-exact-storage-postgres-v1"></a>

### Exact v1 contract — Postgres Storage

**Migration provenance.** Exact normative contract imported from `spec/storage-postgres.md` at `sha256:a2f52223ed5d041effc941d16d361f1a0b3bac4283d5fb1c0348f33699d6cffb`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

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
- durable outbox deliveries/attempts/retry generations from `outbox-delivery.md`
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

PostgreSQL may use JSONB internally for fields declared by strict Resource
schemas and for closed platform metadata records. This physical representation
does not create a public undeclared extension bag. Queryable fields and indexes
remain explicit pack definitions with reviewed migration/reindex behavior.

Expected Postgres tools include justified GIN indexes, generated columns or side
tables for high-value declared fields, and partial indexes from safely
SQL-lowerable expressions.

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
