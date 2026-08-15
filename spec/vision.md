<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-vision; contract: 1; input: sha256:3ac5930a89c1847155766d1c13e19d2e2c49053fc9ebf7953ba1068b77385c51 -->

# Vision

Generated exact-contract projection imported into project-model/model.json from the reviewed vision.md source.

## Exact migrated contract

<a id="obj-com-exact-vision-v1"></a>

### Exact v1 contract — Vision

**Migration provenance.** Exact normative contract imported from `spec/vision.md` at `sha256:bd3cdd1fa8dcea21ec6368fd83aa7fa5d85a0ac37bc7282d0bfca8f4f8c73556`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## One-Line Vision

An API-first operational data platform for AI agents: the correctness-enforcing
control plane underneath CRMs, support tools, project tools, workflows, and
agentic business applications.

## Philosophy

> If an AI agent is allowed to modify your business, it should do so through a
> system that enforces correctness by default.

The platform is not a database, CRM, Airtable clone, or automation tool. It
provides safe business primitives the way Kubernetes provides safe
infrastructure primitives: useful defaults, declarative resources,
extensibility, lifecycle hooks, and a control plane API.

## Differentiation

Most applications eventually rebuild the same operational primitives:

- RBAC and ownership
- Audit trails and object history
- Optimistic locking
- Transactions
- Approvals
- State machines
- Events/webhooks
- Idempotency
- Extension points
- Search and summaries

This platform makes those primitives part of the substrate rather than bespoke
application code.

## Users

- AI agents that need to ask “can I do this?” before committing business
  changes.
- Developers building AI applications who need safe operational primitives.
- Operations teams who need reviewable, reversible, governed AI-driven work.
- Self-hosters who want a simple open-source single-tenant deployment.
- Admins who define object types, policies, lifecycle rules, extensions,
  resource constraints, and executable behavior.

## Goals

- Expose object types, not raw tables.
- Accept intentions as changesets, not direct row updates.
- Make writes previewable, validated, authorized, conflict-checked,
  transactional, audited, and evented.
- Be open-source and single-tenant by default.
- Support real Postgres for both simple app-managed installs and external
  scale-out/concurrency deployments.
- Support horizontal scaling without coordination beyond the database.
- Provide domain object templates as hackable configuration, not special code.
- Let users add their own resources and resource behavior through declarative
  config and lifecycle scripts.

## Non-Goals

- Not direct SQL-as-product-interface.
- Not a UI-first Airtable/Odoo replacement.
- Not an Odoo clone.
- Not field-level replication of existing ERP/CRM products.
- Not an automation engine where arbitrary imperative steps bypass governance.
- Not SaaS multi-tenancy as the default design center.

## Validation Intent

The platform is successful when an agent or developer can:

1. Discover available object types and allowed actions.
2. Read relevant objects.
3. Submit a proposed intention.
4. Preview the resulting diff and policy decisions.
5. Commit atomically when allowed or route for approval when required.
6. Recover from conflicts, denials, and supported undo cases.
7. Apply a default CRM pack, inspect its resource definitions, modify them, and
   add lifecycle scripts without changing platform code.
