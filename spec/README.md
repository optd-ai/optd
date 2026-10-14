# Specifications

This directory is the **source of truth** for optd's product and technical
contracts. Edit the Markdown directly in reviewed changes alongside
implementation and tests. There is no DAG model, generation step, or frozen
projection to update.

## Authority and status

Normative requirements and accepted decisions in these specifications govern.
Material explicitly marked historical, supporting research, prototype,
superseded, or deferred remains non-normative. A proposal does not become
accepted merely by being placed here. Resolve contradictions explicitly in the
affected specs; do not silently use implementation behavior or old receipts as
authority.

See [Specification governance](model-governance.md) for the editing workflow and
[retired model history](history/README.md) for provenance. The archived JSON and
receipts are historical evidence only and are never inputs to active tooling.

Run `deno task spec:check` for read-only structural checks and `deno task fmt`
for formatting. Application tests and the exact-image release gate remain
required; structural validity is not semantic correctness or release readiness.

## Contents

- [Product direction](product.md)
- [Identity, authentication, and authorization](identity-auth.md)
- [Packs, Workspaces, and resources](packs-workspaces.md)
- [Queries, policy, and history](queries-policy-history.md)
- [Immutable writes, Actions, and approvals](writes-actions.md)
- [Hooks, secrets, and outbox](hooks-secrets-outbox.md)
- [Runtime, architecture, and release](runtime-release.md)
- [Proof packs and acceptance](proof-acceptance.md)
- [Specification governance](model-governance.md)
- [API Actions](api-actions.md)
- [API Response and Error Contract](api-errors.md)
- [Authentication API and CLI Contract](auth-api.md)
- [Authentication and Local Agent Grants](authentication.md)
- [Authorization Definitions and Assignments](authorization-assignments.md)
- [CEL-to-SQL Partial-Index Prototype Evidence](cel-sql-partial-indexes.md)
- [Changeset Approval Contract](changeset-approvals.md)
- [Changeset Operation Schemas v1](changeset-operation-schema.md)
- [Changesets](changesets.md)
- [Race-Free Commit Revalidation](commit-revalidation.md)
- [CRM Migration Prototype Evidence](crm-migration-prototype.md)
- [Historical CRM Pack Definition](crm-pack-definition.md)
- [Historical CRM Prototype Flow](crm-prototype-flow.md)
- [Headless CRM Workflows](crm-workflows.md)
- [Deployment](deployment.md)
- [Events, Audit, History, and Outbox](events-audit.md)
- [Expression Language](expression-language.md)
- [Extensions](extensions.md)
- [Hook-Secret Grants](hook-secret-grants.md)
- [Hooks, Scripts, and Runtime Behavior](hooks-and-scripts.md)
- [Historical Local Postgres Options Research](local-postgres-options.md)
- [Migration Classification](migration-classification.md)
- [Migrations](migrations.md)
- [MVP Acceptance Criteria](mvp-acceptance-criteria.md)
- [MVP API Routes](mvp-api-routes.md)
- [MVP Hook Schema v1](mvp-hook-schema.md)
- [MVP Implementation Boundaries](mvp-implementation-boundaries.md)
- [MVP Pack-Migration Integration](mvp-migration-integration.md)
- [Historical MVP Planning Requirements](mvp-planning-requirements.md)
- [MVP Policy Schema v1](mvp-policy-schema.md)
- [Historical MVP Roadmap](mvp-roadmap.md)
- [MVP Stack Decisions](mvp-stack.md)
- [Object Model](object-model.md)
- [Odoo-Inspired Object Map](odoo-object-map.md)
- [optctl AXI Guidance Model](optctl-axi.md)
- [Durable Outbox Delivery](outbox-delivery.md)
- [Pack Definition Schemas v1](pack-definition-schemas.md)
- [Pack Publishers and Workspaces](pack-publishers-and-workspaces.md)
- [Pack Structure](pack-structure.md)
- [Specification Planning-Readiness Audit](planning-readiness-audit.md)
- [Policies and Authorization](policies.md)
- [Historical Pre-MVP Questions and Proposals](pre-mvp-open-questions.md)
- [Project Management Proof-Pack Requirements](project-management-pack.md)
- [Platform Workspaces](workspaces.md)
- [Historical Design Proposals](proposals.md)
- [Query and Object Read API v1](query-api.md)
- [Resource Configuration](resource-configuration.md)
- [Secret Encryption Model](secret-encryption.md)
- [Immutable Staged Changeset Storage](staged-changeset-storage.md)
- [State Machines](state-machines.md)
- [Postgres Storage](storage-postgres.md)
- [Vision](vision.md)

<a id="obj-com-exact-readme-v1"></a>

## Contract guide

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
- [Platform Workspaces](workspaces.md): built-in UUIDv7 workspace boundary,
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
- [Migration Classification](migration-classification.md): normative
  safe/risky/destructive classification algorithm and frozen decisions, with a
  supporting migration-tool research survey.
- [CRM Migration Prototype](crm-migration-prototype.md): non-normative
  executable evidence for migration detection and breaking-migration flows.
- [Policies](policies.md): SQL-lowerable RBAC/ABAC/one-level ReBAC authorization
  architecture, policy-before-pagination filtering, identity integration
  considerations, and scaling constraints.
- [Authorization Definitions and Assignments](authorization-assignments.md):
  globally registered role/policy definitions, explicit
  workspace/all-workspace/system assignments, and authorization evaluation
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
- [Pack Publishers and Workspaces](pack-publishers-and-workspaces.md): distinct
  pack publishers, runtime workspaces, canonical identities, and migration from
  the currently overloaded namespace model.
- [optctl AXI Guidance](optctl-axi.md): AXI-style CLI/resource guidance so packs
  can teach agents how to use them.
- [CRM Workflows](crm-workflows.md): headless CRM resources, lifecycles, and
  scriptable automations.
- [Historical CRM Prototype Flow](crm-prototype-flow.md): non-normative
  walkthrough evidence.
- [Historical CRM Pack Definition](crm-pack-definition.md): detailed pre-auth
  design history; frozen subsystem specs and fixtures take precedence.
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
  normative `optd/projects` second-pack domain requirements.
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
  `OPTD_DATABASE_URL` or app-managed local Postgres when the URL is absent.
- PGlite is allowed for focused prototypes but is not the MVP runtime or
  integration-test default.
- SQLite is out of MVP scope unless a later planning cycle deliberately revives
  it.
- CRM is the default bundled proof fixture; a workspace-management pack is the
  second proof fixture.
