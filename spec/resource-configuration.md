<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-resource-configuration; contract: 1; input: sha256:c155074e376775736e323fb7c9495f514955c27d144a738f8ab1abd4a518d4e1 -->

# Resource Configuration

Generated exact-contract projection imported into project-model/model.json from the reviewed resource-configuration.md source.

## Exact migrated contract

<a id="obj-com-exact-resource-configuration-v1"></a>

### Exact v1 contract — Resource Configuration

**Migration provenance.** Exact normative contract imported from `spec/resource-configuration.md` at `sha256:f4c5f9b83e394d586a518df842041043e1bcb9bdc1cec45eb39a7c5f3ea8bd7a`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Summary

The system has a Kubernetes-like strict pack configuration model. Bundled proof
packs are ordinary inspectable source. Forks use a publisher identity controlled
by the operator; they do not silently replace another publisher's pack.

## Resource Definition

A resource definition describes its lowercase snake-case name, display metadata,
fields/schema, supported database constraints/index/search configuration, and
AXI/CLI guidance. Relationship, lifecycle, action, policy, hook, and seed
children are separate strict pack definitions that reference the resource; they
are not arbitrary inline resource subdocuments. Storage mappings and revision
IDs are server-generated normalized metadata, not author-selected table names.

See [Pack Definition Schemas](pack-definition-schemas.md) for the normative v1
vocabulary; the CRM fixture is the concrete executable example.

## Declarative Apply

Executable prototype evidence for pack upload and resource-to-SQL compilation
lives in `prototypes/pack-sql/`.

Operators preview and apply complete publisher-qualified pack revisions through
the CLI/API. Preview validates schema/config changes and live-data constraints;
apply activates the exact reviewed migration plan transactionally and records
immutable definition revisions. There is no independent mutable-resource apply
endpoint.

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

## Proof and future packs

The MVP bundled proof packs are CRM and project management. Helpdesk and other
Odoo-inspired packs are future examples, not MVP acceptance requirements.

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

Pack preview uses the same HTTP multipart API whether initiated by CLI, a future
UI, or another client. MVP CLI packages a local directory (archive input is
deferred) and submits it to the API, allowing the server to validate every
referenced script/file.

## Deferred beyond MVP

Configuration templating is not supported. Strict explicit pack YAML remains the
single authoring contract.
