<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-expression-language; contract: 1; input: sha256:00aaf9cdc07b6cff6d3ad79eea340b9d29ede192c1bbb15fef3639a0363528ea -->

# Expression Language

Generated exact-contract projection imported into project-model/model.json from the reviewed expression-language.md source.

## Exact migrated contract

<a id="obj-com-exact-expression-language-v1"></a>

### Exact v1 contract — Expression Language

**Migration provenance.** Exact normative contract imported from `spec/expression-language.md` at `sha256:4f7ffb261098a1ab28b4d6157bdbb7e6eb8b0d08b288a453a0a222086e0841f2`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

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
- staging error explanations
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

- lifecycle staging/availability
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
- staging explanation

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

### Query filters

Query `where` exposes only declared resource fields plus platform
`id|created_at|updated_at|archived_at` and helpers. It cannot reference actor,
relationships, action input, or arbitrary JSON paths; authorization policy is
compiled separately and ANDed by the server.

### Policy predicates

Policy `where` exposes the same protected-object row fields plus exactly
`actor.id`, `actor.principal_type`, and nullable `actor.human_user_id`. Roles
and assignments select rules outside CEL; `actor.role`, arbitrary metadata,
arrays, environment, and relationship traversal are not CEL variables. One-hop
ReBAC is the structured policy `relation` clause, not expression traversal.

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

The policy context adds only the three actor fields above. Action/hook/AXI
conditions remain row-local in v1. Packs cannot introduce variables.

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

### Literals and scalar typing

Allowed literals are bounded strings, JSON-safe integers, booleans, and
homogeneous non-empty arrays of those scalars:

```cel
"open"
42
true
false
["new", "contacted"]
```

There are no null or fractional numeric literals in v1. Optionality uses
`present`. Decimal fields (stored/input as canonical decimal strings) may
compare to safe integer literals or another compatible decimal field; lowering
casts the integer to Postgres numeric and targeted stage/policy evaluation uses
Postgres, never IEEE-754 arithmetic. Date/timestamp fields compare to validated
string literals coerced to their declared type. `in` requires a type-compatible
array.

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

Every resource gets generated archival fields:

- `archived_at`
- `archived_by_auth_context_id`

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
optctl expression validate operant/crm:lead --context partial-index 'status == "open" && active()'
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
Run `optctl expression validate operant/crm:lead --context partial-index '<expr>'`
```

## Frozen implementation decisions

- The server parses CEL with `@bufbuild/cel` and lowers the hardcoded supported
  AST subset through Operant's auditable typed SQL lowerer. Unsupported AST
  forms fail closed; no general third-party CEL-to-SQL compiler is used.
- `optctl` does not maintain a competing CEL evaluator/parser. It sends source
  to server validation and exposes server-authored subset help/examples.
- Bare fields are canonical and `self.<field>` is an accepted alias. Actor
  values use `actor.<field>` only in contexts that declare actor fields.
- Resource constraints, partial indexes, lifecycle/action/hook conditions, query
  filters, and policy `where` clauses share this exact subset with
  context-specific fields/functions. Packs cannot extend it.
