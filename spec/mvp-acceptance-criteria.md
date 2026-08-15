<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-mvp-acceptance-criteria; contract: 1; input: sha256:ae31aabaf73233fc108543ab0a3ad1b5fb04358f2f80b4395968ebadebd92b50 -->

# MVP Acceptance Criteria

Generated exact-contract projection imported into project-model/model.json from the reviewed mvp-acceptance-criteria.md source.

## Exact migrated contract

<a id="obj-com-exact-mvp-acceptance-criteria-v1"></a>

### Exact v1 contract — MVP Acceptance Criteria

**Migration provenance.** Exact normative contract imported from `spec/mvp-acceptance-criteria.md` at `sha256:840d58390cc1a42d98a05c02c4d3cf73eeacc2dd7f391e90352ea70fa4f30c7b`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## MVP definition

The MVP is the smallest platform-engine implementation that can run real packs
safely through API and `optctl`. It is not a CRM-only product.

CRM is the default bundled proof fixture. A second bundled project-management
pack proves that the platform is generic and not accidentally hard-coded around
CRM semantics.

## Required demo path

A fresh containerized install must support this path without manual database
setup:

1. Configure `OPERANT_BOOTSTRAP_TOKEN` and start the server with no
   `OPERANT_DATABASE_URL`.
2. Server starts app-managed Postgres from bundled/container-provided binaries.
3. Server runs platform migrations idempotently and reports `bootstrap_required`
   separately from readiness.
4. `optctl bootstrap init --username <name>` creates/logs in the first human
   `system:super_admin` through the public auth interface.
5. Authenticated `optctl home` returns agent-friendly TOON output.
6. `optctl project create sales --display-name "Sales"` creates the explicit
   UUIDv7 runtime/auth boundary and selects it in local context.
7. `optctl pack preview prototypes/crm-default-pack` validates the CRM pack
   against `pack-definition-schemas.md` (including publisher-qualified identity,
   separate lifecycle/action/hook/role/policy/seed definitions) and shows the
   resulting migration/apply plan. Legacy namespace/dotted/inline aliases are
   rejected.
8. `optctl pack apply prototypes/crm-default-pack` applies the CRM pack as
   authored in the repository.
9. `optctl --project sales seed commit operant/crm --all` uses the exact
   client-side stage/changeset-commit reconcile path; a repeated run returns
   unchanged without creating object versions.
10. `optctl metadata resource operant/crm:lead` and
    `optctl metadata action operant/crm:convert_lead` expose AXI guidance and
    schema metadata.
11. `optctl changeset stage/inspect/commit` can create, update, archive, link,
    unlink, transition, and comment on objects; stage output already contains
    the complete inspect representation.
12. `optctl --project sales query operant/crm:lead ...` filters through
    SQL-lowered expressions, policy pushdown, projection, and cursor pagination.
13. `optctl --project sales action stage/commit operant/crm:convert_lead ...`
    runs the configured action/hook path; direct commit is a client-side stage
    followed by commit.
14. Object and first-class relationship read/query/history show immutable
    versions; comments appear as typed history timeline entries.
15. After-commit hooks enqueue outbox work; the main server's in-process polling
    loop and `optctl outbox list/inspect/attempts/retry/cancel/drain` operate on
    durable rows.
16. Stable errors are returned for validation, policy denial, hook failure,
    migration blockers, already-committed stages, stale versions, and bad
    cursors.

## Authentication acceptance

- Development, containers, and production use the same opaque-token server auth.
- No public actor/role headers, request fields, disabled mode, or dev-trust mode
  can bypass authentication.
- Unit tests may inject deterministic auth through application composition.
- Focused integration tests exercise real bootstrap, Argon2id password login,
  configurable password policy, throttling/503 hash saturation, token lookup,
  revocation, role/boundary resolution, and auth-context persistence.
- Normal forgotten-password reset requires an unenumerable exact request id,
  active super-admin approval, requester nonce redemption, indefinite WebSocket
  wait, and single-use completion; pending reset requests cannot be listed.
- At least one public-interface scenario starts an agent outside a human
  binding, requests and receives roles, performs allowed work, observes a
  denial, verifies provenance, revokes authorization, and verifies rejection.
- Internal hooks/workers preserve initiator and causation without receiving the
  initiating bearer token.
- Approval sends no bearer token to the approver; requester-side `auth wait`
  waits indefinitely over a reconnectable WebSocket, then redeems and installs
  it, including interrupted-delivery retry.
- The nearest process binding always supplies one current authorization token;
  `optctl` never credential-shops by role/project or falls back after denial.
- On Linux, PID/start-time/user/boot-marker ancestry selects the nearest
  binding, rejects PID reuse/stale/mismatched identity, and survives compiled
  CLI tests. Unimplemented OS adapters fail `process_inspection_unsupported`,
  never PID-only.
- `auth isolate` starts an agent with request-only authority; `auth doctor`
  validates/repairs local filesystem/context state in interactive and
  noninteractive modes.
- Bootstrap automatically creates/activates the normalized server context.
- Recovery is executable and tested for forgotten password, explicit user
  enablement, super-admin restoration, cancellation, expiry, and session
  revocation.

## Changeset and hook authorization acceptance

- A changeset may atomically touch multiple projects; one token is evaluated per
  operation boundary and the client creates no causation links.
- Staging executes synchronous action/hook effects once and validates declared
  effects, runtime capabilities, hook secret grants, code/config identities,
  policies, and object versions.
- Successful stage output is the complete inspect representation. A hook or
  validation/policy/schema failure creates no stage; approval-required valid
  proposals may persist.
- Commit applies the exact immutable stage without rerunning hooks and returns
  structured stale/change errors when authorization, policy, code, approval, or
  object versions change. It does not recheck synchronous hook-secret grants.
- Stage hooks may use declared host/port network access and explicit
  env/secrets, but pack authors must not intentionally cause external effects.
  All pack hooks permanently lack filesystem and subprocess access.
- Semantic action permission covers reviewed declared hook effects; internal
  hook capabilities are invocation-bound and never imply super-admin.
- After-commit delivery is separately observable and may retry/dead-letter
  without changing the committed changeset result.
- Delivery follows [Durable Outbox Delivery](outbox-delivery.md): durable
  at-least-once, stable UUIDv7 idempotency key, pinned old revision/grant,
  current secret value version, fixed lease recovery, append-only attempts,
  `delivery.v1`, ten-attempt full-jitter defaults, manual retry generations, and
  pre-claim cancellation.
- MVP uses one polling async loop in the main server/container, retains all
  delivery detail, and deliberately provides no ordering guarantee.
- Real-Postgres plus real-HTTP-provider evidence proves duplicate-attempt
  idempotency, lease recovery, claim concurrency, pinned upgrades, cancellation,
  retry history, polling, and unordered completion.
- Commit uses the canonical Postgres lock protocol in
  [Commit Revalidation](commit-revalidation.md): stage lifecycle locking, early
  compatible runtime-table locks, exact referenced pack-revision comparison,
  sorted dependency locks, one-statement authorization, and atomic facts.
- Pack apply locks every existing runtime table owned by the pack in canonical
  order and applies the entire ready migration plan plus active-revision switch
  in one transaction; injected failure proves full rollback/no partial plan.
- A complex destructive scenario proves the explicit-revision flow: atomic
  additive transitional revision, ordinary cleanup changesets, then a separately
  previewed/confirmed atomic final revision.
- The default lock timeout is 10 seconds; an authenticated request/CLI
  `--timeout` may ask the server to wait longer.
- Real-Postgres concurrency tests prove same-stage exactly-once behavior,
  commit/cancel/approval ordering, object/read dependencies, pack/write
  ordering, ordinary write concurrency, deadlock retry, and no partial facts.
- Authorization failures explain current authority and failed capability but do
  not suggest escalation.

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

- `operant/projects:project`
- `operant/projects:task`
- `operant/projects:task_stage`
- `operant/projects:project_milestone`
- `operant/projects:task_tag`
- `operant/projects:project_member`
- `operant/projects:timesheet`

Minimum behaviors:

- Project/task ownership and assignment.
- Task stage lifecycle: `todo -> in_progress -> blocked -> done` with explicit
  allowed transitions.
- Milestone linkage.
- Tags through first-class relationships or reference collections.
- Timesheet entries linked to tasks.
- At least one action, e.g. `operant/projects:start_task`,
  `operant/projects:block_task`, or `operant/projects:complete_task`.
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
- `OPERANT_SECRET_MASTER_KEY` is base64 for 32 bytes; AES-256-GCM uses fresh
  nonces and row/version AAD. Existing encrypted rows plus missing/mismatched
  key fail startup.
- Secret APIs and hook injection are policy controlled through global,
  revision-and-slot-specific hook-secret grants. Every declared slot is
  required; grant mutation requires both `secret.grant` and
  `hook.secret.configure`.
- Credential rotation atomically replaces one encrypted value and increments
  `value_version` without regranting. Disablement blocks future injection;
  normal hard deletion and direct re-enable are absent.
- Outbox work remains pinned to its enqueued hook revision and grant while using
  the secret's current value version at each attempt.
- Hook scripts cannot directly access the database.
- Hooks receive curated stdin JSON and only explicitly declared env
  vars/secrets.
- Policy is enforced for queries/object/relationship reads, changesets/actions/
  seeds, sensitive metadata, migrations, projects, assignments, secrets, and
  outbox administration. Hooks have no self-API capability.
- One-hop ReBAC is proven by CRM `opportunity_viewer` relationships directly to
  `system:principal`; no actor-supplied arrays or deep traversal are accepted.
- `system:super_admin` can bootstrap and bypass policy checks, but bypass
  remains authenticated, structurally validated, invariant-protected, and
  audited.

## Output/API acceptance

- HTTP API accepts and returns JSON.
- `optctl` outputs TOON by default.
- `optctl --json` emits JSON.
- CLI structured input is JSON only.
- Server routes follow the frozen resource-oriented inventory in
  `spec/mvp-api-routes.md`.
- CLI sends publisher-qualified definition identity and explicit project
  separately; no dotted namespace compatibility alias is required.
