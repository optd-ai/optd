<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-object-model; contract: 1; input: sha256:2cf4212837d2207c1323aa5cc66fdd282f54e91d198b79f599af9f31e4a6ca7f -->

# Object Model

Generated exact-contract projection imported into project-model/model.json from the reviewed object-model.md source.

## Exact migrated contract

<a id="obj-com-exact-object-model-v1"></a>

### Exact v1 contract — Object Model

**Migration provenance.** Exact normative contract imported from `spec/object-model.md` at `sha256:68b5ab4f4405cd14db257a7ad8946a4d78b195786c973609fe03fd11a649737c`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

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

- Strict permission-filtered query and object/history reads.
- REST API and compiled CLI.
- Semantic/vector search, generated summaries, and MCP tools are deferred until
  they have explicit schemas, authorization behavior, storage, and acceptance
  tests.

## Relationships

Relationships should be first-class objects or rows rather than ad hoc
foreign-key fields when they need audit/history/policy.

Relationship definitions and runtime edges use the strict versioned schemas in
[Pack Definition Schemas](pack-definition-schemas.md). They do not admit an
undeclared metadata/extension bag or relationship-local lifecycle rules.

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
