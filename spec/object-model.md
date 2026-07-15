# Object Model

## Summary

Operators define domain resources through globally installed strict packs.
Resources such as task, contact, company, ticket, run, incident, and document
are business objects with platform identity/history/policy, not thin public SQL
table wrappers.

## Resource / Object Type

The platform uses a Kubernetes-like declarative resource model. Bundled proof
resources are ordinary pack definitions operators can inspect and fork under a
controlled publisher identity.

A `Resource` file defines one lowercase snake-case child name, pack fields,
constraints/index/search, and AXI guidance. Lifecycle, relationships, actions,
hooks, roles, policies, and seeds are separate strict pack files that reference
it. There is no extension namespace bag, inline hook script, arbitrary table
mapping, or mutable resource-definition endpoint.

## Object Instance

Every object instance has universal platform fields:

- `id`: server-generated UUIDv7 per RFC 9562.
- `project_id` and publisher-qualified resource definition/revision identity.
- `created_at`, `updated_at`, `archived_at`.
- creating/updating/archiving auth-context provenance.
- monotonic `version` plus current immutable object-version UUID.

Ownership is not universal: packs declare an `owner_id` reference or a
relationship when their domain needs it. `type`, `deleted_at`, and caller actor
strings are not competing platform aliases.

## Built-In Capabilities

### Collaboration

- Append-only comments and first-class links/relationships are MVP platform
  operations.
- Labels/tags are ordinary pack resources/relationships.
- Binary attachments/blobs and mentions/participant infrastructure are deferred;
  there is no hidden attachment operation/table/API in MVP.

### Governance

- RBAC/policy checks
- Audit history
- Optimistic locking
- Archive without hard delete/unarchive
- Approvals
- Ownership
- Configurable constraints

### AI/API

- Semantic search, permission-filtered.
- Summaries, permission-filtered and auditable.
- MCP tools.
- REST API.
- CLI.

## Relationships

Relationships should be first-class objects or rows rather than ad hoc
foreign-key fields when they need audit/history/policy.

Candidate relationship features:

- Source object
- Target object
- Relationship type, e.g. `blocks`, `belongs_to`, `mentions`, `duplicates`,
  `relates_to`
- Creator/timestamps
- Optional metadata/extensions
- Optional lifecycle or validation rules

## Domain Packs vs Platform Core

**Decision:** Odoo-style product packs are research scaffolding for object
coverage, not product commitments.

Likely architecture:

- Platform core: object infrastructure and universal capabilities.
- Domain packs/templates: optional starter object types such as CRM, Helpdesk,
  Project, Finance.
- User customizations: locally edited object types, constraints, hooks, and
  extensions.

Default packs must not require hidden platform branches; they are configuration
and scripts layered on the same resource APIs as user-defined resources.

## Frozen layering decisions

- Platform/system record types are built in; runtime domain resource and
  relationship definitions come from globally installed packs. Operators create
  custom domain types by authoring/applying packs, not by bypassing pack
  validation with an unversioned loose-type API.
- Every runtime object has UUIDv7 identity, explicit project, qualified resource
  definition, mutable current projection, immutable version history, audit
  provenance, archive fields, policy evaluation, and changeset-only mutation.
  Lifecycle, search, comments, relationships, actions, and hooks are optional
  definition capabilities unless their specific schemas require them.
- Resource/relationship schema is strict before staging: unknown fields and
  incompatible values fail; commit revalidates the pinned canonical graph
  against the current exact referenced pack revision.
- First-class relationships are typed pack definitions with UUIDv7 rows,
  versions, policy/history, and `link`/`unlink` operations in the same changeset
  engine. Direct reference fields remain available for simpler ownership links.
