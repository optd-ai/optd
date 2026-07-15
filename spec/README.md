# Specifications

This directory is the organized, durable product specification for the
operational data platform. It should be updated whenever brainstorms produce
meaningful decisions.

`.ai/project.md` remains the research notebook and sensemaking log. `spec/` is
the cleaner product contract.

## Authority and status

Topic-specific files labeled **Decision**, **Decisions**, **frozen**, or
**canonical** are normative. When they conflict, the more specific/newer frozen
contract wins and this index should be corrected. Files explicitly labeled
historical, prototype evidence, research, roadmap, or open-question history are
non-normative and must not drive implementation tasks.

The completed consistency review is recorded in
[Planning Readiness Audit](planning-readiness-audit.md).

## Current Spec Set

- [Vision](vision.md): positioning, goals, users, non-goals, validation intent.
- [Historical Design Proposals](proposals.md): non-normative design history.
- [Expression Language](expression-language.md): hardcoded CEL subset,
  expression contexts, built-in archive helpers, SQL lowering, and `optctl`
  help.
- [Query and Object Read API](query-api.md): strict object/query DTOs, policy
  pushdown, projection, keyset cursors, history timeline, and archive access.
- [CEL-to-SQL Partial Indexes](cel-sql-partial-indexes.md): prototype for
  partial index config, CEL lowering, and security/breakage tests.
- [Object Model](object-model.md): object types, identity, collaboration,
  governance, AI capabilities, relationships.
- [Platform Projects](projects.md): built-in UUIDv7 project boundary,
  lifecycle, routes, locking, and CLI behavior.
- [Changesets](changesets.md): immutable staging, validation, commit, and
  conflict behavior.
- [Immutable Staged Changeset Storage](staged-changeset-storage.md): normalized
  immutable stage evidence, lifecycle/approval separation, digests, and
  exactly-once commit record.
- [Changeset Approval Contract](changeset-approvals.md): requirement schema,
  decision authority, quorum, lifecycle, and commit revalidation.
- [Changeset Operation Schemas](changeset-operation-schema.md): frozen
  `changeset.operations.v1` and RFC 6902-subset `patch.v1`, UUIDv7 identities,
  structured references, mutation merging, normalization, limits, and RFC 8785
  graph hashing.
- [Commit Revalidation](commit-revalidation.md): race-free Postgres transaction,
  canonical table/row lock ordering, conservative pack invalidation, timeouts,
  retries, and real concurrency evidence.
- [Migrations](migrations.md): atomic plan lifecycle, explicit intermediate
  revisions, hazard codes, confirmation tokens, and dependency graph purpose.
- [Migration Classification](migration-classification.md): supporting research
  for safe/risky/destructive schema change classification grounded in existing
  migration tooling patterns.
- [CRM Migration Prototype](crm-migration-prototype.md): non-normative
  executable evidence for migration detection and breaking-migration flows.
- [Policies](policies.md): SQL-lowerable RBAC/ABAC/one-level ReBAC authorization
  architecture, policy-before-pagination filtering, identity integration
  considerations, and scaling constraints.
- [Authorization Definitions and Assignments](authorization-assignments.md):
  globally registered role/policy definitions, explicit
  project/all-project/system assignments, and authorization evaluation
  boundaries.
- [Authentication](authentication.md): local user/agent authentication,
  process-tree-selected filesystem grants, approval workflow, bootstrap,
  provenance, and the single opaque-token authentication model.
- [Authentication API](auth-api.md): canonical auth routes, DTOs, WebSocket
  wait, stable errors, CLI input/exit behavior, contexts, doctor, and isolate.
- [State Machines](state-machines.md): lifecycle rules, transitions, required
  fields, approvals.
- [Extensions](extensions.md): explicit decision to defer a separate extension
  system; ordinary packs/migrations are the MVP extension mechanism.
- [Hooks and Scripts](hooks-and-scripts.md): executable lifecycle hooks using
  Deno/TypeScript, stdin JSON envelopes, and explicit permissions.
- [Resource Configuration](resource-configuration.md): Kubernetes-like
  declarative resources, constraints, and default packs.
- [Pack Structure](pack-structure.md): YAML pack authoring format, canonical
  JSON normalization, strict convention-based directory layout, seed reconcile,
  and multipart preview scanning.
- [Pack Definition Schemas](pack-definition-schemas.md): strict v1 Pack,
  Resource, Relationship, Lifecycle, Action, Hook, Policy, Role, and Seed
  vocabulary plus rejected legacy aliases.
- [Pack Publishers and Projects](pack-publishers-and-projects.md): distinct pack
  publishers, runtime projects, canonical identities, and migration from the
  currently overloaded namespace model.
- [optctl AXI Guidance](optctl-axi.md): AXI-style CLI/resource guidance so packs
  can teach agents how to use them.
- [CRM Workflows](crm-workflows.md): headless CRM resources, lifecycles, and
  scriptable automations.
- [Historical CRM Prototype Flow](crm-prototype-flow.md): non-normative
  walkthrough evidence.
- [Historical CRM Pack Definition](crm-pack-definition.md): detailed
  pre-auth design history; frozen subsystem specs and fixtures take precedence.
- [Events and Audit](events-audit.md): canonical object version history, audit
  events, committed events, and undo/compensation boundaries.
- [Durable Outbox Delivery](outbox-delivery.md): single-container in-process
  polling, pinned at-least-once hooks, stable idempotency, fixed leases,
  structured outcomes, retries, cancellation, and real Postgres/HTTP evidence.
- [API Actions](api-actions.md): non-CRUD action surface and AI interaction
  contract.
- [API Response and Error Contract](api-errors.md): shared JSON envelope,
  statuses, stable-code mapping, redaction, existence, and retry behavior.
- [Deployment](deployment.md): single-tenant OSS deployment, Postgres runtime
  modes, and one-container/container-first goals.
- [Local Postgres Options](local-postgres-options.md): supporting historical
  research; deployment/storage decisions are authoritative.
- [Postgres Storage](storage-postgres.md): storage model and horizontal scaling
  assumptions.
- [MVP Acceptance Criteria](mvp-acceptance-criteria.md): executable definition
  of done for the platform-engine MVP, CRM fixture, and second pack.
- [MVP Implementation Boundaries](mvp-implementation-boundaries.md): frozen
  module boundaries for implementation planning and subagent work.
- [Historical MVP Roadmap](mvp-roadmap.md): non-normative implementation history
  for the completed pre-auth MVP.
- [MVP Stack](mvp-stack.md): Deno/Hono server, Deno/Cliffy CLI, raw SQL,
  schema/OpenAPI stance, and runtime decisions.
- [Historical MVP Planning Requirements](mvp-planning-requirements.md):
  non-normative requirements from the completed pre-auth planning pass.
- [Historical Pre-MVP Questions](pre-mvp-open-questions.md): non-normative
  resolved/superseded proposal history.
- [MVP API Routes](mvp-api-routes.md): frozen resource-oriented route inventory,
  addressing, and write sequencing.
- [MVP Migration Integration](mvp-migration-integration.md): server/CLI
  integration design for full pack upgrades.
- [MVP Policy Schema](mvp-policy-schema.md): frozen structured YAML policy
  schema v1 and action vocabulary.
- [MVP Hook Schema](mvp-hook-schema.md): frozen hook attachment/input/secrets
  schema v1.
- [Project Management Proof-Pack Requirements](project-management-pack.md):
  normative `operant/projects` second-pack domain requirements.
- [Secret Encryption](secret-encryption.md): application-level encryption and
  master-key behavior.
- [Hook-Secret Grants](hook-secret-grants.md): global secret slots, revision
  authorization, rotation/disable/replacement, pinned outbox use, audit, API,
  and CLI contracts.
- [Odoo Object Map](odoo-object-map.md): non-normative Odoo-inspired naming
  research scaffolding.
- [Planning Readiness Audit](planning-readiness-audit.md): severity-ordered
  consistency findings, resolved decisions, and implementation handoff.

## Spec Principles

1. Prefer intent and invariants over implementation detail until implementation
   begins.
2. Label uncertain material clearly.
3. Do not copy Odoo fields or workflows unless separately justified.
4. Default to open-source single-tenant deployment; support horizontal scaling
   through Postgres when needed.
5. Treat bundled product packs as hackable configuration, not special code.
6. Design every write as stageable, policy-checked, auditable, and recoverable
   where possible.

## Current MVP Decisions

- MVP storage/runtime is Postgres only: external Postgres via
  `OPERANT_DATABASE_URL` or app-managed local Postgres when the URL is absent.
- PGlite is allowed for focused prototypes but is not the MVP runtime or
  integration-test default.
- SQLite is out of MVP scope unless a later planning cycle deliberately revives
  it.
- CRM is the default bundled proof fixture; a project-management pack is the
  second proof fixture.
