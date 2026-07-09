# MVP Acceptance Criteria

## MVP definition

The MVP is the smallest platform-engine implementation that can run real packs
safely through API and `optctl`. It is not a CRM-only product.

CRM is the default bundled proof fixture. A second bundled project-management
pack proves that the platform is generic and not accidentally hard-coded around
CRM semantics.

## Required demo path

A fresh containerized install must support this path without manual database
setup:

1. Start the server with no `OPERANT_DATABASE_URL`.
2. Server starts app-managed Postgres from bundled/container-provided binaries.
3. Server runs platform migrations idempotently.
4. `optctl home` returns agent-friendly TOON output.
5. `optctl pack preview prototypes/crm-default-pack` validates the CRM pack and
   shows the resulting migration/apply plan.
6. `optctl pack apply prototypes/crm-default-pack` applies the CRM pack as
   authored in the repository.
7. Seeds are applied through ordinary changesets or an equivalent auditable
   changeset-backed path.
8. `optctl metadata resource default.lead` and
   `optctl metadata action default.convert_lead` expose AXI guidance and schema
   metadata.
9. `optctl changeset preview/commit` can create, update, archive, link, unlink,
   transition, and comment on objects.
10. `optctl query default.lead ...` filters through SQL-lowered expressions,
    policy pushdown, projection, and cursor pagination.
11. `optctl action preview/commit default.convert_lead ...` runs the configured
    action/hook path.
12. Object history shows immutable versions and audit/event evidence.
13. After-commit hooks enqueue outbox work; `optctl outbox status/drain/retry`
    operates on durable rows.
14. Stable errors are returned for validation, policy denial, hook failure,
    migration blockers, idempotency conflicts, stale versions, and bad cursors.

## CRM pack acceptance

`prototypes/crm-default-pack/` is the canonical CRM fixture for MVP planning.

- The pack should apply as-is.
- If an implementation test fails because the pack is internally inconsistent,
  fix the pack rather than special-casing the engine.
- If an implementation test fails because the engine rejects valid pack
  semantics documented in `spec/`, fix the engine/spec mismatch explicitly.
- Do not add hidden CRM-specific code paths.
- The CRM fixture must exercise resources, relationships, lifecycles, actions,
  hooks, policies, seeds, metadata/AXI, history, and outbox.

## Second pack acceptance

The MVP plan must include a second bundled pack modeled after Odoo-style project
management. It does not need every Odoo feature, but it must prove genericity by
using different domain objects and workflows from CRM.

Minimum resources:

- `default.project`
- `default.task`
- `default.task_stage`
- `default.project_milestone`
- `default.task_tag`
- `default.timesheet_entry`

Minimum behaviors:

- Project/task ownership and assignment.
- Task stage lifecycle: `todo -> in_progress -> blocked -> done` with explicit
  allowed transitions.
- Milestone linkage.
- Tags through first-class relationships or reference collections.
- Timesheet entries linked to tasks.
- At least one action, e.g. `default.start_task`, `default.block_task`, or
  `default.complete_task`.
- At least one validation hook and one after-commit hook.
- Policy rules for project members, assignees, managers, and admins.
- AXI guidance sufficient for `optctl home` and metadata commands.

## Runtime acceptance

- Production deployment is container-only: Docker Compose or Kubernetes.
- The production image/container environment provides Postgres binaries.
- If `OPERANT_DATABASE_URL` is set, the server uses external Postgres and never
  manages that process.
- If `OPERANT_DATABASE_URL` is absent, the server starts app-managed Postgres
  under `OPERANT_DATA_DIR`.
- Integration tests use the same app-managed Postgres lifecycle when Postgres
  binaries are available.
- PGlite is permitted only for focused prototypes/unit spikes, not as the MVP
  runtime or integration-test default.

## Security and policy acceptance

- Secret values are encrypted before storage in Postgres.
- `OPERANT_SECRET_MASTER_KEY` or equivalent runtime-mounted key material is
  required before creating/reading secrets.
- Secret APIs and hook secret injection are policy controlled.
- Hook scripts cannot directly access the database.
- Hooks receive curated stdin JSON and only explicitly declared env
  vars/secrets.
- Policy is enforced for queries, object reads, changesets, actions, metadata
  where sensitive, secrets, and hook-triggered API calls.
- `super_admin` can bootstrap and bypass checks, but bypass must be auditable.

## Output/API acceptance

- HTTP API accepts and returns JSON.
- `optctl` outputs TOON by default.
- `optctl --json` emits JSON.
- CLI structured input is JSON only.
- Server routes follow Proposal A in `spec/mvp-api-routes.md`.
- Dotted CLI identifiers are translated to `{namespace}/{name}` route path
  segments.
