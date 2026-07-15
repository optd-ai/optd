# Changeset Operation Schemas v1

## Purpose

`changeset.operations.v1` is Operant's single declarative write language for
public changeset requests, action-stage hook output, CLI commands, and future
agent protocols. `patch.v1` is the normalization-hook language applied to one
proposed resource data document.

Staging executes hooks once, resolves and normalizes these schemas, generates
all platform identities, and persists an immutable canonical operation graph.
Commit applies that exact graph without rerunning hooks.

## Identity

All server-generated opaque entity/record identifiers are UUIDv7 values
conforming to RFC 9562. This includes object, relationship, comment,
object-version, stage, commit, audit, event, outbox, and similar row identities.
Human-readable usernames, pack component identities, and pack-defined business
keys are names/fields rather than generated row IDs.

Callers, packs, and hooks cannot choose platform IDs for newly created entities.
Semantically meaningful identifiers belong in pack-defined fields, which may
have uniqueness constraints:

```yaml
fields:
  customer_number:
    type: string
    unique: true
```

An authored create operation therefore omits `object_id`; the staged canonical
operation contains the generated UUIDv7. UUIDs are lowercase canonical strings.

## Authoring envelope

A public changeset staging request contains:

```json
{
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "operations": []
}
```

`project_id` is optional only as single-project inheritance context; operations
may instead carry explicit `project_id` values for a cross-project graph. An
`action.stage` hook writes:

```json
{
  "operations": [],
  "warnings": [],
  "errors": []
}
```

Rules:

- `operations` is required for hook output; public staging requests require it
  to be non-empty and use the same operation array without hook-only
  warnings/errors. An action hook may return empty operations, producing the
  `no_changes` behavior below.
- Warnings/errors use the platform validation-message shape: `path`, `code`,
  `message`, and optional `details`.
- Any error prevents stage creation and generated operations are ignored.
- An empty successful graph returns `no_changes` and creates no stage.
- `summary` is not part of the schema; AXI guidance and persisted stderr logs
  provide explanation.
- Unknown properties are rejected at every schema level.

## Common authoring fields

Operations preserve authored array order and may contain:

- `op`: required operation discriminator.
- `key`: optional operation-local identifier. It is required when another
  operation references an ID this operation will produce.
- `project_id`: optional UUIDv7 inherited from a single-project staging/action
  request context when omitted. A request spanning projects must set it on every
  operation. The canonical stage always stores it explicitly.

`key` values are unique within one staging attempt. They are not platform IDs
and exist only for graph authoring/provenance. Unkeyed operations receive stable
ordinal labels such as `op_000001` during normalization.

Public requests use publisher/pack-qualified component identities such as
`operant/crm:lead`. A hook may use a local component name such as `lead`; the
engine resolves it relative to the hook's pinned owning pack revision. The
persisted stage always uses qualified identities. Pack identity and project
identity are independent.

## Operations

V1 supports exactly:

```text
create
update
transition
archive
link
unlink
comment
```

Deferred operations include hard delete, restore, attach, relationship update,
and query/bulk mutation.

### `create`

Authored:

```json
{
  "op": "create",
  "key": "company",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:company",
  "fields": {
    "name": "Acme",
    "customer_number": "ACME-001"
  }
}
```

Canonical staged form:

```json
{
  "op": "create",
  "key": "company",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:company",
  "object_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "fields": {
    "name": "Acme",
    "customer_number": "ACME-001"
  }
}
```

Rules:

- `resource` and `fields` are required.
- `object_id` is forbidden in authored creates and generated during staging.
- Platform fields such as IDs, versions, timestamps, archive fields, actor
  fields, project ownership, and current-version pointers are forbidden inside
  `fields`.
- Field values may contain structured operation references.

### `update`

```json
{
  "op": "update",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:lead",
  "object_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "expected_version": 7,
  "set": {
    "score": 42,
    "phone": null
  },
  "unset": ["temporary_note"]
}
```

Rules:

- `resource` and `object_id` are required.
- `object_id` may be a UUIDv7 string or structured reference to a create.
- `expected_version` is an optional positive integer checked during staging.
  Staging records the actual immutable base object-version dependency even when
  this property is omitted.
- At least one effective `set` or `unset` is required.
- Explicit `null` in `set` sets a nullable field to null.
- `unset` removes/resets an optional field; it cannot target required fields.
- A field cannot occur in both `set` and `unset`.
- Platform-managed metadata cannot be updated through these maps.

### `transition`

```json
{
  "op": "transition",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:opportunity",
  "object_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "expected_version": 4,
  "to": "won",
  "set": {
    "probability": 100,
    "won_reason": "Product fit"
  },
  "unset": ["lost_reason_id"]
}
```

Rules:

- `resource`, `object_id`, and `to` are required.
- `set`/`unset` are optional and have update semantics.
- State validation, required transition fields, and approvals apply to the
  complete proposed result.
- Transition and associated data changes occur in one object mutation and one
  atomic commit; no second changeset is required.

### `archive`

```json
{
  "op": "archive",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:lead",
  "object_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "expected_version": 3
}
```

Archive actor and timestamp are commit metadata generated by the engine, not
staged values. Archive has no field mutation map. Restore is deferred.

### `link`

Authored:

```json
{
  "op": "link",
  "key": "contact-company",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "relationship": "operant/crm:contact_company",
  "from": {"$ref": "contact.object_id"},
  "to": {"$ref": "company.object_id"},
  "fields": {
    "role": "buyer",
    "primary": true
  }
}
```

The staged form adds a server-generated `relationship_id` UUIDv7 and resolves
both endpoints to UUIDs.

Rules:

- `relationship`, `from`, and `to` are required.
- `from`/`to` accept existing endpoint UUIDv7 values or structured references.
  A `system:principal` endpoint accepts only an existing active principal UUID
  and cannot be a create reference.
- `relationship_id` is forbidden in authored links and generated at staging.
- `fields` contains only fields declared by the relationship definition.
- Active-duplicate behavior follows relationship uniqueness constraints.

### `unlink`

```json
{
  "op": "unlink",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "relationship": "operant/crm:contact_company",
  "relationship_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "expected_version": 2
}
```

Unlink archives the relationship row; it does not hard-delete it. V1 requires
the relationship ID and does not support ambiguous endpoint-based unlink.

### `comment`

Authored:

```json
{
  "op": "comment",
  "key": "follow-up-comment",
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource": "operant/crm:lead",
  "object_id": "019bef41-7d8e-7abc-8def-0123456789ab",
  "body": "Called and agreed on next steps."
}
```

The staged form adds a server-generated `comment_id` UUIDv7.

Rules:

- `resource`, target `object_id`, and non-blank `body` are required.
- `comment_id` is forbidden in authored comments and generated at staging.
- Comments are append-only records and do not mutate or increment the target
  object's version.
- The comment records the target object version observed during staging for
  provenance.
- Multiple comments on one target in a stage are allowed.

## Structured operation references

References are exact one-property JSON objects:

```json
{"$ref": "company.object_id"}
```

Rules:

- The left side names an explicit operation `key`.
- V1 result properties are `object_id` from create, `relationship_id` from link,
  and `comment_id` from comment.
- References may appear recursively in resource/relationship field values and
  in operation target/endpoint properties that permit them.
- Forward references are allowed. The engine allocates all generated IDs before
  resolving references.
- Unknown keys/properties fail staging.
- A reference field or relationship endpoint must resolve within the consuming
  operation's project; cross-project references/links fail `project_conflict`.
- Persisted canonical operations contain resolved UUIDs and no `$ref` objects.
- Strings such as `@company` have no special meaning.

## Combining authored mutations

Callers and independent hooks may emit compatible operations against the same
object. Normalization groups them by resolved `(project_id, resource, object_id)`
and produces at most one canonical create/update/transition/archive mutation per
object.

Merge rules:

- Multiple updates merge.
- One transition may merge with updates.
- Updates targeting a create reference merge into that create's fields.
- Identical assignments are harmless.
- Different values assigned to the same field return `operation_conflict`.
- Setting and unsetting the same field returns `operation_conflict`.
- Multiple transitions for one object return `operation_conflict`.
- Archive cannot combine with update or transition.
- Expected versions, when repeated, must agree.
- Comments and relationship operations remain independent.

This supports composable hooks without creating multiple object versions or
requiring multiple commits.

## `patch.v1`

Normalization hooks return an RFC 6902 JSON Patch subset applied to the proposed
pack-defined resource data document:

```json
{
  "patches": [
    {"op": "replace", "path": "/email", "value": "a@example.com"},
    {"op": "add", "path": "/address/country", "value": "CA"},
    {"op": "remove", "path": "/temporary_note"},
    {"op": "test", "path": "/status", "value": "new"}
  ],
  "warnings": []
}
```

Rules:

- Supported RFC 6902 operations are `add`, `remove`, `replace`, and `test`.
  `move` and `copy` are deferred.
- `path` is an RFC 6901 JSON Pointer relative to the proposed resource data.
- The first path segment must name a mutable pack-defined resource field.
- Nested object/array paths follow RFC 6902 semantics.
- Pack-defined fields named `metadata` are ordinary patchable data. Platform
  identity/version/project/actor/timestamp/archive metadata is outside the
  patch document and cannot be reached.
- Duplicate paths within one hook output are rejected.
- Later ordered normalization hooks may patch a path changed by an earlier hook.
- Failed `test` or invalid path/application fails staging.
- A patch cannot change operation kind, resource, project ID, target ID, expected
  version, relationship endpoints, or any platform-managed metadata.
- The engine recompiles the final proposed state into canonical operation
  `fields`, `set`, and `unset` properties.

## Strict vocabulary

V1 rejects prototype compatibility spellings:

```text
id                  (use object_id/relationship_id/comment_id)
fields.id           (created IDs are server generated)
expectedVersion     (use expected_version)
project             (use project_id)
as                  (use key)
"@company"          (use structured $ref)
update.fields       (use set/unset)
set/unset patch ops (use the RFC 6902 subset)
```

This is an API/schema freeze, not a promise to migrate old development
databases. There is no deployed compatibility requirement.

## Normalization

The staging engine:

1. Validates operation-specific schemas and rejects unknown properties.
2. Resolves hook-local component identities against the pinned pack revision.
3. Inherits/resolves a single-project request context and writes explicit `project_id`.
4. Assigns missing ordinal operation labels.
5. Generates all new entity IDs as UUIDv7.
6. Resolves every structured reference.
7. Loads base objects and checks optional expected versions.
8. Groups and merges compatible mutations.
9. Builds complete proposed resource states.
10. Runs ordered `changeset.before_stage` RFC 6902 patches.
11. Recompiles canonical operations and rejects no-ops/conflicts.
12. Runs schema, lifecycle, relationship, hook, policy, capability, and approval
    checks.
13. Qualifies all identities and canonicalizes the resolved graph.
14. Computes the operation graph digest and persists the successful stage.

## Operation graph digest

The operation graph digest is:

```text
sha256:<lowercase hexadecimal SHA-256>
```

It hashes this fully resolved document:

```json
{
  "schema": "changeset.operations.v1",
  "operations": []
}
```

Canonicalization follows RFC 8785 JSON Canonicalization Scheme. Operation array
order remains semantic; object keys and JSON numbers follow RFC 8785. The graph
contains no unresolved references or compatibility aliases. Explicit null is
distinct from omission.

The graph digest excludes logs, warnings, policy decisions, approvals,
dependencies, and timestamps. The larger stage digest defined with commit
revalidation combines the graph digest with dependencies and pinned runtime
configuration.

## Operational limits

Limits are configurable health guardrails rather than small application-schema
constraints. Suggested deployment defaults are:

```text
maximum operations after expansion: 10,000
maximum JSON nesting depth: 64
maximum canonical operation graph: 64 MiB
maximum individual string: 8 MiB
```

Pack resource schemas may impose smaller domain limits. Exceeding an operational
limit returns `changeset_too_large` and creates no stage.
