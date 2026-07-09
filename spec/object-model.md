# Object Model

## Summary

Users define or enable object types such as `task`, `project`, `contact`,
`company`, `deal`, `ticket`, `run`, `incident`, and `document`. Object types are
business resources with built-in platform capabilities, not thin wrappers around
tables.

## Resource / Object Type

The platform should use a Kubernetes-like resource model. Built-in and
default-pack resources are ordinary definitions users can inspect and modify.

A resource/object type defines:

- Stable kind/type key, e.g. `task`, `contact`, `deal`.
- Kind/type keys are always lowercase. Use lowercase snake case for multi-word
  kinds, e.g. `pipeline_stage`, `lost_reason`, `contact_company`. This is a hard
  convention to prevent agent errors around capitalization.
- Human display name.
- Core fields.
- Extension namespaces allowed on the type.
- Lifecycle/state-machine rules, if any.
- Schema validations.
- Runtime validation hooks.
- Policy bindings.
- Index/search configuration.
- Relationship and foreign-key constraints.
- Lifecycle hooks/scripts.

## Object Instance

Every object instance has universal identity fields:

- `id`: UUID or similar globally unique identifier.
- `type`: object type key.
- `created_at`, `updated_at`, `deleted_at`.
- `created_by`, `updated_by`.
- `version`: monotonic optimistic-lock token.
- `owner_id` or ownership relation where relevant.

## Built-In Capabilities

### Collaboration

- Comments
- Attachments
- Labels/tags
- Links/relationships
- Mentions or participants, if needed later

### Governance

- RBAC/policy checks
- Audit history
- Optimistic locking
- Soft delete
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

## Open Questions

- Are object types core-defined, pack-defined, user-defined, or layered?
- Which object capabilities are mandatory vs optional?
- How much schema strictness is needed before first commit?
- Should relationships be typed objects visible in the same changeset engine?
