# Specification Planning-Readiness Audit

**Reviewed:** 2026-07-14

**Scope:** every Markdown file under `spec/`

**Result:** ready to produce a tight next implementation plan; no unresolved
normative design question remains. Current implementation/fixtures are knowingly
behind the target and require a deliberate reset/migration workstream.

## Severity-ordered findings and resolution

### P0 — conflicting pack/project/namespace identity

Older docs/routes/fixtures mixed `default.lead`, namespace, selected project, and
pack installation. Resolved to:

- one global active `publisher/pack@version` revision;
- child identity `publisher/pack:name`;
- built-in UUIDv7 platform Projects as runtime data/auth boundaries;
- explicit project ID separate from definition identity;
- no dotted/namespace compatibility alias.

Authorities: `pack-publishers-and-projects.md`, `projects.md`,
`mvp-api-routes.md`, `pack-definition-schemas.md`.

### P0 — preview-era mutable changesets versus immutable staging

Old proposal/storage/route text allowed mutable preview records, action commit
hooks, and generic idempotency. Resolved to:

- stage hooks execute once and successful evidence is immutable;
- normalized immutable operation/dependency/hook/policy rows plus separate
  lifecycle/append-only approval decisions;
- RFC 8785/SHA-256 graph/stage digests;
- commit applies only persisted graph and is exactly once per stage;
- no stage idempotency key or combined server stage-and-commit route.

Authorities: `changesets.md`, `changeset-operation-schema.md`,
`staged-changeset-storage.md`, `changeset-approvals.md`,
`commit-revalidation.md`.

### P0 — underspecified pack child/action/hook vocabulary

Aspirational examples disagreed about inline lifecycles, action `hook`, policy
`allow`, relationship endpoint fields, metadata namespace, and hook inputs.
Resolved with strict v1 top-level/component schemas, field types, lifecycle,
action reads, relationships, seed reconcile, role/policy, and rejected aliases.
Hook attachment/output/effect manifests now have one phase-specific contract and
no self-API/import/filesystem/subprocess capability.

Authorities: `pack-definition-schemas.md`, `pack-structure.md`,
`mvp-hook-schema.md`, `hooks-and-scripts.md`, `mvp-policy-schema.md`.

### P0 — authorization actor/assignment ambiguity

Older policy research referenced caller-like roles, arbitrary actor ID arrays,
local auth modes, and OIDC/JWT. Resolved to:

- one opaque-token model everywhere;
- explicit global role/policy definitions and project/all-project/system
  assignments;
- exact role/policy assignment administration authority;
- policy actor fields limited to immutable server-derived ID/type/human anchor;
- one-hop ReBAC only through direct relationship to built-in
  `system:principal`;
- no caller-supplied role/attribute arrays or second auth mode.

Authorities: `authentication.md`, `auth-api.md`,
`authorization-assignments.md`, `mvp-policy-schema.md`, `policies.md`.

### P0 — incomplete API/error/query contract

The route proposal retained namespace paths and omitted projects, relationships,
approvals, seeds, and policy assignments. Error/validation status shapes and
query cursors were inconsistent. Resolved with:

- one resource-oriented route inventory;
- shared success/error envelope and stable HTTP classification;
- strict object/relationship DTOs and query body;
- policy-before-keyset/count SQL, cursor binding, archived/history authority;
- exact project/seed/approval/migration sequencing.

Authorities: `mvp-api-routes.md`, `api-errors.md`, `query-api.md`,
`api-actions.md`, `projects.md`.

### P0 — provisional migration lifecycle

Old integration text had incompatible statuses/commands, constructed confirmation
strings, size-dependent classes, and unclear plan persistence. Resolved to durable
`migration.plan.v1`, conservative intrinsic hazards, real-Postgres validation,
explicit class acknowledgement, short-lived opaque destructive confirmation,
and one all-or-nothing locked global pack activation per plan. Complex upgrades
use explicit intermediate pack revisions rather than partial plan state.

Authorities: `migrations.md`, `migration-classification.md`,
`mvp-migration-integration.md`, `commit-revalidation.md`.

### P1 — stale storage/history/project scoping

The storage sketch still listed mutable previews/idempotency/artifacts/
attachments and object versions lacked explicit project/commit structure.
Resolved table families, UUIDv7/project scoping, resource/relationship snapshots,
typed comment history, and removal of undeclared attachment/extension storage.

Authorities: `storage-postgres.md`, `events-audit.md`,
`staged-changeset-storage.md`, `object-model.md`.

### P1 — seed behavior and duplicate application

Acceptance required auditable seeds but did not define existing-row behavior.
Resolved deterministic project-scoped reconcile by required unique key:
create missing, update declared differing fields, preserve unspecified fields,
never archive removed rows, return unchanged without a stage, and authorize exact
semantic seed effect.

Authority: `pack-structure.md` and seed route in `mvp-api-routes.md`.

### P1 — approval authority/lifecycle

Approval was listed without a schema or race semantics. Resolved exact requirement
shape, role/boundary/quorum/principal/initiator/expiry checks, append-only
per-principal decisions, rejection/ready transitions, stage-row serialization,
and commit-time current approver revalidation.

Authority: `changeset-approvals.md`.

### P1 — secret startup/crypto ambiguity

The secret spec allowed either startup failure or subsystem failure and did not
freeze algorithm/key shape/AAD. Resolved base64 32-byte master key,
AES-256-GCM/fresh nonce, row/version AAD, key fingerprint, startup failure when
ciphertext exists but key is missing/mismatched, and fail-closed grant delivery.

Authorities: `secret-encryption.md`, `hook-secret-grants.md`.

### P1 — hook environment/runtime-policy ambiguity

Non-secret env source and “current global runtime policy” were undefined.
Resolved exact operator env/net ceilings, reserved names, noninheritance,
phase/output schemas, operation effect manifests, and current-policy checks for
stage/outbox without initiating-role reevaluation.

Authorities: `mvp-hook-schema.md`, `outbox-delivery.md`.

### P2 — proof-pack genericity contradictions

Project-management requirements used reserved `project_id`, unsupported field
types, ambiguous principal relationship endpoints, and old `default.*` IDs.
Resolved `operant/projects`, `work_project_id`, canonical field types, explicit
member resource, lifecycle field, actions/hooks/policies/seeds, and separation
from built-in platform Project.

Authorities: `project-management-pack.md`, `mvp-acceptance-criteria.md`.

### P2 — historical material looked normative

Proposal/roadmap/prototype files contained open questions and old commands.
Explicit historical/supporting status banners and README authority rules now keep
them as evidence without allowing them to drive implementation.

## Normative authority map

| Topic | Primary authority |
|---|---|
| identity/projects | `pack-publishers-and-projects.md`, `projects.md` |
| strict pack source | `pack-definition-schemas.md`, `pack-structure.md` |
| auth/process binding | `authentication.md`, `auth-api.md` |
| assignments/policy | `authorization-assignments.md`, `mvp-policy-schema.md` |
| expressions/query | `expression-language.md`, `query-api.md` |
| changeset graph/storage | `changeset-operation-schema.md`, `staged-changeset-storage.md` |
| approvals/commit races | `changeset-approvals.md`, `commit-revalidation.md` |
| hooks/secrets | `mvp-hook-schema.md`, `hook-secret-grants.md`, `secret-encryption.md` |
| migrations | `migrations.md`, `mvp-migration-integration.md` |
| history/events/outbox | `events-audit.md`, `outbox-delivery.md` |
| HTTP/errors/CLI | `mvp-api-routes.md`, `api-errors.md`, `optctl-axi.md` |
| architecture/tests | `mvp-implementation-boundaries.md`, `mvp-acceptance-criteria.md` |

## Explicitly deferred, non-blocking scope

- macOS/Windows process inspection adapters until matching test machines are
  available (must fail unsupported, never PID-only)
- hardened local credential broker/keyring/root helper
- automatic human/agent session expiry and renewal UX
- OIDC/OAuth/JWT identity-provider integration
- master-key rotation
- pack archive input, registry/publishing/trust protocol, OpenAPI generation
- generic extension bags, binary attachments/blobs, mentions; packs may use
  declared object-store URI/metadata fields
- multiple lifecycles/resource, regex fields, decimal fractional CEL literals
- semantic/vector search, deep ReBAC, field-level policy
- ordered outbox delivery, heartbeat leases, retention purge
- Rust server/CLI rewrite

These items require future specs before implementation and must not produce
placeholder compatibility APIs/tables now.

## Known implementation delta (plan inputs, not design blockers)

The current server/CLI/fixtures still include pre-target behavior. The next plan
must explicitly replace rather than wrap:

- namespace/dotted `default.*` parser, routes, metadata, fixture references;
- legacy Pack/Resource/Action/Policy/Relationship/Lifecycle schemas and inline
  resource lifecycle/action-hook aliases;
- preview-era/mutable changeset records and operation aliases;
- trust-actor/public role assumptions with full opaque-token auth/context tables;
- unscoped generated runtime rows/object versions with explicit projects;
- old policy actor arrays/generic action permissions;
- current secret crypto/resolver with AAD, global grants, env/net ceilings;
- current commit path with immutable storage and canonical locks/revalidation;
- current outbox worker with pinned deliveries/attempt generations/leases;
- fixture decimal numbers and reserved/domain field names;
- CLI commands/output/routes with full identities, project resolution, auth
  binding, strict DTOs, TOON default, and JSON envelope preservation.

Development databases may be invalidated; no compatibility/backfill layer is
required.

## Planning handoff constraints

A tight DAG/plan should order work by dependency, not by old feature files:

1. executable schemas/error/UUID/project/storage foundation;
2. server auth/authorization plus Linux local binding/CLI auth;
3. strict global pack definitions and migration planning/apply;
4. policy/expression/query/object/history contracts;
5. immutable operation staging, trusted hook sandbox, secrets/grants/approvals;
6. all-or-nothing locked pack migration apply, changeset commit,
   history/events, and durable outbox;
7. CLI completion, target CRM/project fixtures, real-Postgres concurrency,
   compiled CLI, container, and public E2E acceptance.

Parallel work is safe only behind frozen ports/schemas; Postgres migration files,
central route composition, shared TypeBox registries, and CLI root command should
have single owners to avoid merge collisions.

## Mechanical audit evidence

- Every `spec/*.md` file is indexed by `spec/README.md`.
- Relative Markdown link scan passes.
- Normative-file scans find no unresolved-question or placeholder-work heading.
- Remaining preview/action-commit/`default.*` matches are explicit historical or
  rejection/migration notes.
- `git diff --check` is required after this audit and before plan creation.
