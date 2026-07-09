# Specifications

This directory is the organized, durable product specification for the
operational data platform. It should be updated whenever brainstorms produce
meaningful decisions.

`.ai/project.md` remains the research notebook and sensemaking log. `spec/` is
the cleaner product contract.

## Current Spec Set

- [Vision](vision.md): positioning, goals, users, non-goals, validation intent.
- [Design Proposals](proposals.md): current proposals for hook outputs,
  changeset ops, multipart upload, imports, TOON, system tables, and metadata
  APIs.
- [Expression Language](expression-language.md): hardcoded CEL subset,
  expression contexts, built-in archive helpers, SQL lowering, and `optctl`
  help.
- [CEL-to-SQL Partial Indexes](cel-sql-partial-indexes.md): prototype for
  partial index config, CEL lowering, and security/breakage tests.
- [Object Model](object-model.md): object types, identity, collaboration,
  governance, AI capabilities, relationships.
- [Changesets](changesets.md): intent-based write path, preview, validation,
  commit, idempotency, conflicts.
- [Migrations](migrations.md): main migration lifecycle, plan object, staging
  metadata, hazard codes, confirmation tokens, and dependency graph purpose.
- [Migration Classification](migration-classification.md): supporting research
  for safe/risky/destructive schema change classification grounded in existing
  migration tooling patterns.
- [CRM Migration Prototype](crm-migration-prototype.md): supporting executable
  evidence for CRM-based migration detection and staged breaking-migration
  walkthroughs.
- [Policies](policies.md): SQL-lowerable RBAC/ABAC/one-level ReBAC authorization
  architecture, policy-before-pagination filtering, identity integration
  considerations, and scaling constraints.
- [State Machines](state-machines.md): lifecycle rules, transitions, required
  fields, approvals.
- [Extensions](extensions.md): extension namespaces, declared fields, indexing,
  versioning.
- [Hooks and Scripts](hooks-and-scripts.md): executable lifecycle hooks using
  Deno/TypeScript, stdin JSON envelopes, and explicit permissions.
- [Resource Configuration](resource-configuration.md): Kubernetes-like
  declarative resources, constraints, and default packs.
- [Pack Structure](pack-structure.md): YAML pack authoring format, canonical
  JSON normalization, strict convention-based directory layout, and upload
  scanning rules.
- [optctl AXI Guidance](optctl-axi.md): AXI-style CLI/resource guidance so packs
  can teach agents how to use them.
- [CRM Workflows](crm-workflows.md): headless CRM resources, lifecycles, and
  scriptable automations.
- [CRM Prototype Flow](crm-prototype-flow.md): concrete
  add/validate/behavior/remove flow for a config-driven CRM.
- [CRM Pack Definition](crm-pack-definition.md): configuration primitives for
  CRM tables/resources, relationships, constraints, actions, hooks, and seed
  data.
- [Events and Audit](events-audit.md): canonical object version history, audit
  events, committed events, outbox, webhooks, undo/compensation.
- [API Actions](api-actions.md): non-CRUD action surface and AI interaction
  contract.
- [Deployment](deployment.md): single-tenant OSS deployment, Postgres runtime
  modes, and one-container/container-first goals.
- [Local Postgres Options](local-postgres-options.md): PGlite vs app-managed
  local Postgres process tradeoffs.
- [Postgres Storage](storage-postgres.md): storage model and horizontal scaling
  assumptions.
- [MVP Acceptance Criteria](mvp-acceptance-criteria.md): executable definition
  of done for the platform-engine MVP, CRM fixture, and second pack.
- [MVP Implementation Boundaries](mvp-implementation-boundaries.md): frozen
  module boundaries for implementation planning and subagent work.
- [MVP Roadmap](mvp-roadmap.md): prototype gaps, missing functionality, and MVP
  target scope.
- [MVP Stack](mvp-stack.md): Deno/Hono server, Deno/Cliffy CLI, raw SQL,
  schema/OpenAPI stance, and runtime decisions.
- [MVP Planning Requirements](mvp-planning-requirements.md): platform-engine MVP
  target, app-managed Postgres, hexagonal architecture proposal, validation
  tradeoffs, TypeBox/Ajv spike, TOON package research, and required
  migration/policy/hook integration.
- [Pre-MVP Open Questions](pre-mvp-open-questions.md): proposals for app-managed
  Postgres, changeset JSON v0, expression SQL lowering, policy config, hook API
  access, migration integration, outbox guarantees, metadata prototype, and TOON
  input/output.
- [MVP API Routes](mvp-api-routes.md): two HTTP route shape proposals and
  recommendation.
- [MVP Migration Integration](mvp-migration-integration.md): server/CLI
  integration design for full pack upgrades.
- [MVP Policy Schema](mvp-policy-schema.md): frozen structured YAML policy
  schema v0.
- [MVP Hook Schema](mvp-hook-schema.md): frozen hook attachment/input/secrets
  schema v0.
- [Project Management Pack](project-management-pack.md): Odoo-inspired second
  bundled pack definition proving non-CRM genericity.
- [Secret Encryption](secret-encryption.md): application-level secret encryption
  model and hook injection handling.
- [Odoo Object Map](odoo-object-map.md): Odoo-inspired object-name research
  scaffolding.

## Spec Principles

1. Prefer intent and invariants over implementation detail until implementation
   begins.
2. Label uncertain material clearly.
3. Do not copy Odoo fields or workflows unless separately justified.
4. Default to open-source single-tenant deployment; support horizontal scaling
   through Postgres when needed.
5. Treat bundled product packs as hackable configuration, not special code.
6. Design every write as previewable, policy-checked, auditable, and recoverable
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
