# Pack Definition Schemas v1

## Decision

This file freezes the strict top-level/component vocabulary used by pack preview.
TypeBox schemas must set `additionalProperties: false` at every modeled object.
Custom tags, non-string mapping keys, duplicate keys, non-finite numbers, and
implicit timestamps are rejected before canonical JSON validation. Anchors,
aliases, and merge keys are allowed only as bounded authoring sugar and are fully
expanded before canonical validation as defined in `pack-structure.md`; cycles
and expansion beyond configured guardrails fail.

Every file has exactly:

```yaml
kind: <allowed kind>
apiVersion: operant.dev/v1
metadata:
  name: <lowercase snake_case child name>
spec: {}
```

Only root `Pack` metadata additionally has `publisher` and `version`; child
identity is inherited from that pack. Metadata labels/annotations and namespace
aliases are not supported in v1.

Child and pack names match `[a-z][a-z0-9_]{0,62}`. Publisher names match
`[a-z][a-z0-9-]{0,62}`. Version is strict SemVer without an implicit `v` prefix.

## `Pack`

```yaml
metadata:
  publisher: operant
  name: crm
  version: 0.1.0
spec:
  purpose: Headless CRM operating resources.
  axi: {}
```

`spec` allows exactly required bounded `purpose` and required `axi`. Child paths
are discovered from the strict directory tree and are never listed here.

## Reusable field schema

Resource fields, relationship payload fields, and action input fields use one
strict descriptor with required `type`:

| type | allowed properties |
|---|---|
| `string` | `required`, `enum`, `minLength`, `maxLength`, `format`, `ref`, `unique` |
| `integer` | `required`, `minimum`, `maximum`, `unique` |
| `decimal` | `required`, `minimum`, `maximum`, `precision`, `scale`, `unique` |
| `boolean` | `required` |
| `date` | `required`, `minimum`, `maximum`, `unique` |
| `timestamp` | `required`, `minimum`, `maximum`, `unique` |

- `required` is boolean and defaults false; there is no nullable value type.
  Optional means omitted. JSON `null` is rejected as a stored field value.
- `enum` is a non-empty unique array of bounded strings and only valid for
  `string`.
- `format` is one of `email|uri|uuid` and only valid for `string`.
- `ref` is a pack-local or publisher-qualified resource identity. A reference is
  stored as UUID, must target an object in the same project, and cannot also have
  `enum`/`format`.
- `unique: true` creates a project-scoped unique constraint including archived
  rows. Active-only or multi-field uniqueness uses a named `unique` constraint
  with `where: active()` below.
- `default` is intentionally absent: omitted write values are not silently
  invented by DDL. Normalization hooks/actions/seeds author derived values.
- Arbitrary regex patterns are not supported in v1. Integer values are JSON safe
  integers only. Decimal values are canonical base-10 strings (no exponent or
  leading plus/zeroes) so Deno/JSON/RFC 8785 never round financial values;
  minimum/maximum are the same string form and Postgres `numeric` enforces
  precision/scale. Date is `YYYY-MM-DD`; timestamp is RFC 3339 normalized to UTC.

Platform fields (`id`, `project_id`, version/current-version, created/updated/
archive/auth metadata) are reserved and cannot be pack fields.

## `Resource`

```yaml
spec:
  fields: {name: {type: string, required: true}}
  constraints:
    - name: customer_number_unique
      kind: unique
      fields: [customer_number]
      where: "active()"
  indexes:
    - name: active_owner_idx
      fields: [owner_id, updated_at]
      where: "active()"
  search: {fields: [name, email]}
  axi: {}
```

- `fields` is required/non-empty.
- `constraints` defaults empty and supports exactly `unique|check|foreign_key`.
  Unique has `fields` and optional frozen CEL `where`; check has `expression`;
  foreign-key behavior is normally represented by field `ref` and the advanced
  form additionally names local fields, target resource/fields, and
  `onDelete: restrict` only. Constraint names are unique.
- `indexes` defaults empty and supports ordered field lists plus optional CEL
  `where`; pack index fields may include platform `updated_at|archived_at`.
  Expression indexes/arbitrary SQL are forbidden.
- `search.fields` is a unique list of string fields. Postgres-native full-text is
  used; semantic/vector configuration is absent.
- `axi` follows `optctl-axi.md` and is required for bundled proof resources.
- Lifecycle/actions/hooks/policies are separate files and cannot be inline.

## `Relationship`

```yaml
spec:
  from: {resource: contact}
  to: {resource: company}
  fields: {role: {type: string}}
  unique: [from, to]
  axi: {}
```

`from`/`to` contain exactly one resource identity. An endpoint may be a pack
resource or read-only built-in `system:principal`; the latter validates an active
principal UUID and enables direct one-hop ReBAC but is never created/updated by
pack operations. Pack-resource endpoints and the relationship row belong to one
project; cross-project links/references are forbidden even inside a
multi-project changeset. Cardinality is expressed by
`unique`: `[from]`, `[to]`, or `[from, to]`, avoiding ambiguous endpoint labels.
Relationship uniqueness is project-scoped and active-row-only
(`archived_at IS NULL`) so an explicitly unlinked row may later be relinked with
a new UUID/history. `fields` defaults empty
and cannot use names `from|to|from_id|to_id`. `unique` is optional and may contain
`from`, `to`, and relationship payload fields. Relationships are first-class
project rows with generated UUIDv7/history/policy; they do not point at arbitrary
resource field names.

## `Lifecycle`

```yaml
spec:
  resource: opportunity
  field: stage
  initial: new
  states:
    - name: new
    - name: won
      terminal: true
      required_fields: [amount]
  transitions:
    - name: win
      from: [proposal]
      to: won
      condition: "amount > 0"
      set: {probability: "100"}
      unset: []
  axi: {}
```

The lifecycle field must be a required string field. State names are unique;
`initial` exists and is nonterminal. Each transition has unique name, non-empty
unique `from`, existing `to`, optional frozen CEL condition, and schema-valid
constant `set`/`unset` fields. Transition graphs need not be fully connected but
unreachable states are preview errors. A resource has at most one lifecycle.
Hook attachments provide dynamic transition behavior/validation.

## `Action`

```yaml
spec:
  input:
    lead_id: {type: string, required: true, format: uuid}
  reads:
    lead:
      resource: lead
      id_from: input.lead_id
      required: true
  availability:
    resource: lead
    states: [qualified]
    condition: "active()"
  axi: {}
```

- `input` is a field-descriptor map and defaults empty.
- `reads` is a unique-name map. Each read has exact resource, `id_from` limited
  to `input.<field>`, and required boolean. MVP reads one object by UUID only;
  arbitrary query/list reads are forbidden.
- `availability` is optional. Resource/states must align with its lifecycle;
  condition uses the frozen CEL subset.
- `axi` is required for bundled proof actions.
- Action implementation is attached by one or more `action.stage` Hook
  attachments. An action with no matching active attachment fails pack preview.
  Actions cannot declare commit implementations.

## `Hook`, `Policy`, and `Role`

- `Hook` is exactly `mvp-hook-schema.md`; script filename equals metadata name
  plus `.ts`, and `output.schema` must match every attachment phase.
- `Policy` is exactly `mvp-policy-schema.md`.
- `Role` is exactly the identity/lifecycle/AXI-only schema in
  `authorization-assignments.md`; `allow`/permissions are forbidden.

## `Seed`

```yaml
spec:
  resource: lead_status
  key: name
  mode: changeset
  rows: [{name: new, label: New}]
  axi: {purpose: Seed lead statuses.}
```

Only these fields are allowed. Resource/key/row/reconcile behavior is frozen in
`pack-structure.md`. Rows contain only declared pack fields and never platform
IDs/project/version metadata.

## Canonicalization and references

Preview resolves every local child reference against the owning candidate pack,
qualifies identities, validates cross-file attachment/lifecycle/policy/AXI
references, sorts maps where semantics are unordered, preserves declared arrays
where order is semantic, and stores RFC 8785 canonical JSON plus SHA-256 source
and security digests.

The target implementation intentionally rejects current prototype aliases such
as pack `metadata.namespace`, dotted `default.*` IDs, inline resource lifecycle,
action `hook`, action `input` string arrays, policy `allow` arrays, relationship
endpoint `field`, and missing `apiVersion`. Fixtures must be migrated; no deployed
compatibility layer is required.
