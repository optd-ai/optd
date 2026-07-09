# Resource Configuration

## Summary

The system should have a Kubernetes-like configuration model: built-in defaults
that work, plus user-defined resources and behaviors. Default CRM/Odoo-inspired
resources are configuration that users can inspect, fork, edit, and replace.

## Resource Definition

A resource definition should describe:

- Kind/type name. Resource kind names are always lowercase, using snake case for
  multi-word kinds.
- Version.
- Display metadata.
- Storage/table mapping.
- Fields and schema.
- Relationships.
- Database constraints.
- Lifecycle/state machine.
- Named actions/intentions.
- Policy rules.
- Hooks/scripts.
- Indexes and search participation.
- AXI/CLI guidance for agents (`axi`).
- Seed/reference data when packaged.
- Default views/CLI hints, if desired.

See [CRM Pack Definition](crm-pack-definition.md) for a concrete pack-level
prototype.

## Declarative Apply

Executable prototype evidence for pack upload and resource-to-SQL compilation
lives in `prototypes/pack-sql/`.

Users should be able to apply configuration files through CLI/API:

- Create/update resource definitions.
- Preview schema/config changes.
- Validate whether existing data violates new constraints.
- Apply changes atomically where possible.
- Record config revisions.

## Database-Level Constraints

Resource definitions should expose database constraints as declarative config
where supported.

Most constraints should be inline:

- Field-level constraints for single-field rules: `required`, type, format,
  min/max, enum, simple unique, ref/foreign key.
- Resource-level constraints for multi-field or named database objects:
  composite unique constraints, partial unique constraints, check constraints,
  multi-column indexes, advanced foreign keys.

Hard decision: use `required: true` as the only requiredness primitive. If
`required` is omitted, the field/input is optional/absent. Do not add a second
requiredness flag or a separate empty-value schema mode. The config model
distinguishes required vs absent.

For executable hooks, parameters are delivered as one JSON envelope on stdin.
Hook inputs should therefore use:

- omitted key = absent optional value
- empty string = present but empty string
- empty list/object = present empty collection

Validation can reject empty strings separately when desired. CLI args and
environment variables are not used for structured hook input; environment
variables are reserved for true environment configuration and secrets.

A separate top-level `Constraint` kind is not needed initially unless
constraints need to be shared, independently versioned, or applied across
resources.

## Postgres Constraint Enforcement

MVP storage is Postgres only. The config model should distinguish:

- Constraints enforced directly by Postgres.
- Constraints enforced at runtime because they cannot be represented safely as a
  database constraint.
- Constraints enforced by both database and runtime checks.
- Unsupported constraints.

The preview should report where a requested constraint will be enforced:

- `database`
- `runtime`
- `both`
- `unsupported`

## Object References and Relationships

References are object-to-object only. A reference field stores the id of another
object/resource, e.g. `company_id` references a `company` object. The platform
should not support “field refs” that point at arbitrary values inside another
field.

Relationship modeling has two forms:

1. Direct object reference fields, e.g. `company_id` references a `company`
   object.
2. First-class relationship resources/tables, e.g. `contact_company`, when the
   relationship needs metadata, history, lifecycle, or policy.

Guideline:

- Use direct object references for hard ownership/containment and required
  links.
- Use relationship resources for collaborative/domain links that need metadata,
  history, or policy.

## Default Packs

Default packs should be ordinary resources and scripts:

- CRM pack.
- Project-management pack inspired by Odoo Project.
- Helpdesk pack.
- Odoo research pack, if useful.

Users should be able to copy and modify them. No pack should require hidden
special-case code.

A pack should be able to include:

- `Pack` manifest
- `Resource` definitions
- `Relationship` definitions
- `Lifecycle` definitions
- `Action` definitions
- `Hook` definitions
- Behavior script files referenced by hook file name
- Inline field/resource constraints
- `Seed` data
- `axi` guidance that teaches `optctl` how to present resources/actions to
  agents
- `Seed` data for defaults/reference data that help teach agents and initialize
  useful pack state

Pack files are authored as YAML and normalized to canonical JSON for validation,
storage, diffing, and API responses; see [Pack Structure](pack-structure.md).
Pack files live in a strict convention-based directory structure. The root
`pack.yaml` should not enumerate relative paths. The CLI/server scans expected
directories and validates that referenced hook script file names exist in
`hooks/`.

Behavior scripts should normally be included as files in the pack directory or
as files in a multipart upload, referenced by file name from hook definitions,
hashed at apply time, stored in the database as part of an immutable config
revision, and recorded by digest for auditability. Multiline script strings in
JSON are not the primary upload format.

Pack upload should ultimately use the same HTTP multipart API whether initiated
by CLI, UI, or agent. The CLI can package a local directory/archive and submit
it to the API, allowing the server to validate that every hook references an
uploaded script file.

## Open Questions

- Should config support templating?
