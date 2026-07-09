# Expression Language

## Decision

Use a small, hardcoded CEL subset for declarative predicates.

The allowed expression language is platform behavior, not pack metadata. Packs
cannot configure or extend the allowed expression language. `optctl` should
include built-in help/validation commands that teach agents the supported
subset.

## Why Expressions Exist

Expressions are for small, deterministic predicates where a Deno hook would be
too heavy, too opaque, or unsuitable for database enforcement.

Expressions describe decisions such as:

- whether a row satisfies a constraint
- whether a partial index applies
- whether a lifecycle transition is available
- whether an action should be shown/invocable
- whether a hook attachment should run
- whether contextual `optctl` help should be shown

Expressions must not perform side effects, execute user code, call HTTP, mutate
objects, or query arbitrary data.

## Expression Contexts

### Resource constraints

Purpose: validate object shape and cross-field invariants.

Examples:

```cel
present(email) || present(phone)
amount >= 0
status != "open" || present(due_at)
```

Used by:

- resource validation
- preview error explanations
- database check constraints when safely lowerable

### Conditional database constraints and partial indexes

Purpose: describe when a unique constraint or index applies.

Examples:

```cel
present(email)
active()
status == "open" && active()
stage in ["qualified", "proposal", "negotiation"] && active()
```

Used by:

- Postgres partial indexes
- Postgres partial unique indexes

For partial indexes, expressions must compile safely to SQL or config preview
fails. Do not silently fallback to runtime-only enforcement for partial indexes.

See [CEL-to-SQL Partial Indexes](cel-sql-partial-indexes.md).

### Lifecycle transition guards

Purpose: describe when a transition is allowed without a hook.

Examples:

```cel
present(amount) && present(expected_close_date)
present(lost_reason_id)
```

Used by:

- lifecycle preview
- commit revalidation
- available action/transition display

### Action availability

Purpose: decide whether an action appears as an invocable headless button.

Examples:

```cel
status == "qualified"
stage == "negotiation" && present(primary_contact_id)
```

Used by:

- metadata API
- `optctl actions <resource>`
- `optctl view <resource> <id>`

### Hook attachment conditions

Purpose: conditionally run hook attachments.

Example:

```cel
discount_percent > 20
```

Used by:

- hook attachment config
- preview explanation

### AXI/help display conditions

Purpose: show contextual CLI guidance at the right time.

Examples:

```cel
status == "qualified"
!present(primary_contact_id)
```

Used by:

- `optctl` contextual `help[]`
- metadata output

### Query/list filters

Purpose: let users and agents express compact filters that can be lowered to SQL
before pagination.

Examples:

```cel
status == "qualified" && score >= 50 && active()
```

Used by:

- `POST /queries`
- `optctl query`

### Policy predicates

Policy uses the same expression direction for contextual authorization and
approval requirements, but with a stricter SQL-lowerable subset.

## Allowed CEL Subset v1

### Variables

For row/resource-local contexts such as constraints and partial indexes, allow
only fields on the current resource row.

Canonical style: use bare field names.

Allowed:

```cel
email
status
amount
archived_at
created_at
updated_at
```

Disallowed in database-lowerable predicates:

```cel
actor.role
related.company.status
input.foo
self["dynamic_field"]
```

Other contexts may expose context-specific variables later, but each context
must define them explicitly in platform code.

### Helpers

Allowed initially:

```cel
present(field)
active()
archived()
```

Meanings:

- `present(field)` means the field is present for expression purposes; for SQL
  lowering this maps to `field IS NOT NULL`.
- `active()` means the built-in archive field `archived_at` is absent; for SQL
  lowering this maps to `archived_at IS NULL`.
- `archived()` means `archived_at` is present; for SQL lowering this maps to
  `archived_at IS NOT NULL`.

Do not add `empty(field)` initially. Empty string semantics should be handled by
explicit validation if needed.

### Operators

Allowed:

```cel
&&
||
!
==
!=
<
<=
>
>=
in
(...)
```

### Literals

Allowed:

```cel
"open"
42
true
false
["new", "contacted"]
```

Disallowed initially:

- maps/objects
- bytes
- regex
- arbitrary function calls
- method calls
- dynamic field access
- cross-resource traversal
- host/application calls

## Built-in Archival Semantics

Archive/soft-delete is a built-in platform capability.

Every resource should get generated archival fields:

- `archived_at`
- `archived_by`

Expression helpers:

```cel
active()
archived()
```

This lets packs write default active-only indexes and action availability rules
without defining archive mechanics themselves.

## SQL Lowering

For database-enforced expressions, the platform must:

1. Parse CEL with a real parser.
2. Typecheck against the resource schema.
3. Validate the expression is in the allowed context subset.
4. Lower the AST to SQL.
5. Quote identifiers and literals safely.
6. Reject expressions that cannot be lowered safely.

Never concatenate raw expression strings into SQL.

Partial index predicates must be fully SQL-lowerable. If not, preview fails.

## CLI Support

Expression documentation and validation are built into `optctl`, not
pack-provided metadata.

Commands:

```text
optctl expression help
optctl expression help partial-index
optctl expression validate crm.lead --context partial-index 'status == "open" && active()'
```

`optctl expression help` should show:

- allowed helpers
- allowed operators
- allowed literals
- context-specific variables
- unsupported constructs
- examples

`optctl expression validate` should combine:

- hardcoded expression rules
- selected expression context
- resource field/type metadata

Resource metadata should expose field names/types and existing configured
expressions, but not define the language rules.

## Error UX

Expression validation errors should be structured and corrective.

Example:

```toon
error: function not allowed: matches
code: EXPRESSION_UNSUPPORTED
help[3]:
Run `optctl expression help partial-index`
Use only supported helpers: present(field), active(), archived()
Run `optctl expression validate crm.lead --context partial-index '<expr>'`
```

## Open Questions

- Which CEL implementation will the server use?
- Which CEL implementation, if any, should `optctl` use client-side?
- Can we reuse an existing CEL-to-SQL compiler, or implement a tiny lowerer for
  our subset?
- Should CEL expressions use only bare fields, or also allow `self.field` as an
  alias?
- How much policy logic should share this expression language later?
