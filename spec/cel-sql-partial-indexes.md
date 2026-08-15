<!-- generated-by: pi-dag-workflow/project-model; view: view-disposition-cel-sql-partial-indexes; contract: 1; input: sha256:43340deaa716e6450279f1804e6fab86b76cdb8a6fbc84ef9ecce59c0017a556 -->

# CEL-to-SQL Partial-Index Prototype Evidence

Generated non-normative disposition view preserving the complete reviewed legacy source for auditability.

## Migration disposition

<a id="obj-com-disposition-cel-sql-partial-indexes"></a>

### Disposition — CEL-to-SQL Partial-Index Prototype Evidence

**Migration disposition.** This source is preserved literally below for auditability at `sha256:f782a2b70469350cf6f138a6a5d627a6c21f1e889b3bd943ef28d4513da1d512`, but remains non-normative historical, supporting research, prototype evidence, roadmap, or superseded planning material. Only separately accepted current project-model objects carry product authority.

> **Status:** supporting design/prototype evidence. `expression-language.md` and
> `pack-definition-schemas.md` are normative where wording differs.

## Purpose

Prototype how resource config can define partial indexes using the
[Expression Language](expression-language.md), how the platform could lower
those expressions to safe Postgres SQL, and what tests should try to break
correctness or security.

## Default Archival Behavior

Decision direction: archive/soft-delete should be a default platform capability,
like history/audit.

Every resource should get a built-in archival field unless explicitly disabled
later:

- `archived_at`
- `archived_by`

Derived expression helper:

- `archived()` means `present(archived_at)`
- `active()` means `!present(archived_at)`

This avoids every pack reinventing archive semantics. Packs can still expose
domain-specific lifecycle states such as `lost`, `won`, `closed`, etc.

## Config Examples

### Optional unique contact email

```yaml
indexes:
  - name: contact_email_unique_when_present
    type: unique
    fields: [email]
    where: present(email)
```

SQL:

```sql
CREATE UNIQUE INDEX contact_email_unique_when_present
ON crm_contacts (email)
WHERE email IS NOT NULL;
```

### Optional unique company domain

```yaml
indexes:
  - name: company_domain_unique_when_present
    type: unique
    fields: [domain]
    where: present(domain)
```

SQL:

```sql
CREATE UNIQUE INDEX company_domain_unique_when_present
ON crm_companies (domain)
WHERE domain IS NOT NULL;
```

### Unique active deal name per company

```yaml
indexes:
  - name: opportunity_company_name_unique_active
    type: unique
    fields: [company_id, name]
    where: active()
```

SQL:

```sql
CREATE UNIQUE INDEX opportunity_company_name_unique_active
ON crm_opportunities (company_id, name)
WHERE archived_at IS NULL;
```

### Fast open activities

```yaml
indexes:
  - name: activity_open_owner_due_idx
    fields: [owner_id, due_at]
    where: status == "open" && active()
```

SQL:

```sql
CREATE INDEX activity_open_owner_due_idx
ON crm_activities (owner_id, due_at)
WHERE status = 'open' AND archived_at IS NULL;
```

### Fast active opportunities

```yaml
indexes:
  - name: opportunity_active_stage_owner_idx
    fields: [stage, owner_id]
    where: stage in ["qualified", "proposal", "negotiation"] && active()
```

SQL:

```sql
CREATE INDEX opportunity_active_stage_owner_idx
ON crm_opportunities (stage, owner_id)
WHERE stage IN ('qualified', 'proposal', 'negotiation') AND archived_at IS NULL;
```

### Leads needing follow-up

```yaml
indexes:
  - name: lead_followup_idx
    fields: [owner_id, next_followup_at]
    where: status in ["new", "contacted", "qualified"] && active() && present(next_followup_at)
```

SQL:

```sql
CREATE INDEX lead_followup_idx
ON crm_leads (owner_id, next_followup_at)
WHERE status IN ('new', 'contacted', 'qualified')
  AND archived_at IS NULL
  AND next_followup_at IS NOT NULL;
```

### One primary contact per company

If `contact_company` is a relationship table:

```yaml
indexes:
  - name: one_primary_contact_per_company
    type: unique
    fields: [company_id]
    where: is_primary == true && active()
```

SQL:

```sql
CREATE UNIQUE INDEX one_primary_contact_per_company
ON crm_contact_companies (company_id)
WHERE is_primary = TRUE AND archived_at IS NULL;
```

## Lowering Model

### Input

- Resource definition with known fields and generated table name.
- Index definition with `fields[]` and optional `where` expression.
- CEL AST parsed by a real CEL parser, not by string concatenation.

### Output

- SQL DDL with safely quoted identifiers and parameter/literal rendering.
- Enforcement classification: `database` if expression is fully SQL-lowerable;
  otherwise reject for partial index use.

For partial indexes, do **not** silently fallback to runtime enforcement. A
partial index is a database object; if the predicate cannot compile safely to
SQL, fail config preview.

## Allowed CEL Subset for SQL-Lowerable Predicates

The canonical allowed subset is defined in
[Expression Language](expression-language.md). For SQL-lowerable predicates,
start with an even more deliberately small context subset.

### Variables

Allowed:

- field names on `self`, or bare field names if unambiguous.
- generated system fields: `archived_at`, `created_at`, `updated_at`, etc.

Not allowed:

- arbitrary nested objects
- `old`, `actor`, `related`, or `input` for database indexes
- dynamic object traversal

### Functions

Allowed:

- `present(field)` -> `field IS NOT NULL`
- `empty(field)` -> `(field IS NULL OR field = '')` for string fields only;
  consider deferring
- `active()` -> `archived_at IS NULL`
- `archived()` -> `archived_at IS NOT NULL`

Initially avoid regex/string functions in database predicates.

### Operators

Allowed:

- `&&` -> `AND`
- `||` -> `OR`
- `!` -> `NOT`
- `==`, `!=`
- `<`, `<=`, `>`, `>=` for numeric/date/timestamp fields
- `in` with literal arrays of strings/numbers/bools
- parentheses

### Literals

Allowed:

- string
- number
- boolean

Not allowed:

- bytes
- maps
- objects
- duration/timestamp literals until deliberately supported

## SQL Rendering Rules

### Never concatenate raw config into SQL

All identifiers and literals must come from validated AST nodes.

### Identifiers

- Field references must resolve to known resource fields.
- SQL identifiers are emitted with a quote-ident function.
- Index/table names are generated or validated against strict lowercase snake
  case.

Example:

```text
field ref email -> "email"
table crm_contacts -> "crm_contacts"
index contact_email_unique_when_present -> "contact_email_unique_when_present"
```

### Literals

- String literals are escaped by SQL literal renderer or emitted as safely
  quoted literals.
- Booleans render as `TRUE`/`FALSE`.
- Numbers render only after numeric parse/validation.

DDL generally cannot use bind parameters for identifiers, so rendering must be
strict and AST-driven.

### Type checking

Before SQL emission:

- `present(x)` works on any field.
- `empty(x)` only works on string/list-like fields if supported.
- Comparisons require compatible field/literal types.
- `in` list elements must match the field type.
- Unknown fields are hard errors.

## Prototype Compiler Sketch

Pseudo pipeline:

```text
parse CEL -> typecheck against resource schema -> validate allowed subset -> lower AST -> render SQL
```

Pseudo AST lowering:

```ts
lower(expr): SqlExpr {
  switch expr.kind:
    case 'call' if expr.fn == 'present': return isNotNull(lowerField(expr.args[0]))
    case 'call' if expr.fn == 'active': return isNull(identifier('archived_at'))
    case 'binary' &&: return and(lower(left), lower(right))
    case 'binary' ||: return or(lower(left), lower(right))
    case 'binary' ==: return compare('=', lowerField(left), lowerLiteral(right))
    case 'binary' in: return inList(lowerField(left), lowerLiteralArray(right))
    default: reject
}
```

## Break/Security Test Ideas

### SQL injection via string literal

Expression:

```cel
email == "x'); DROP TABLE crm_contacts; --"
```

Expected:

- Compiles to safe string literal comparison, not executable SQL.
- SQL contains escaped literal only.
- No extra statements.

### SQL injection via field name

Expression:

```cel
present(email); DROP TABLE crm_contacts; --)
```

Expected:

- CEL parse failure.
- Config preview fails.

Expression:

```cel
present(self["email); DROP TABLE crm_contacts; --"])
```

Expected:

- Dynamic field access not allowed for SQL-lowerable predicates.
- Config preview fails.

### Unknown field

```cel
present(secret_field)
```

Expected:

- Typecheck fails unless `secret_field` is declared in resource schema.

### Unknown function

```cel
sql("1=1")
```

Expected:

- Function not allowed.
- Config preview fails.

### Host/resource access

```cel
actor.role == "admin"
```

Expected for partial index:

- Rejected. Index predicates can only refer to row fields/system fields.

### Runtime-only expression in DB index

```cel
related.company.status == "active"
```

Expected:

- Rejected for partial index because predicate depends on another table/object.

### Regex DoS / expensive expression

```cel
matches(email, "(a+)+$")
```

Expected:

- Regex functions not allowed initially in DB-lowerable predicates.

### Giant `in` list

```cel
status in ["s1", "s2", ... 10000 items ...]
```

Expected:

- Reject or cap literal list length.
- Prevent huge generated SQL.

### Type mismatch

```cel
amount == "big"
```

Expected:

- Typecheck fails if `amount` is numeric.

```cel
status > 10
```

Expected:

- Typecheck fails if `status` is string.

### Boolean precedence

```cel
status == "open" || status == "pending" && active()
```

Expected:

- AST preserves CEL precedence.
- Render SQL with parentheses to avoid ambiguity:
  `(status = 'open' OR (status = 'pending' AND archived_at IS NULL))`

### Archive helper spoofing

If a resource defines a field named `active`, expression:

```cel
active()
```

Expected:

- Function call resolves to built-in helper, not field.

Expression:

```cel
active == true
```

Expected:

- Only valid if field `active` exists; not the archive helper.

### Identifier casing

Expression:

```cel
present(Email)
```

Expected:

- Unknown field. Field names are lowercase snake case.

### Multi-statement table/index name injection

Config:

```yaml
indexes:
  - name: "x; drop table crm_contacts; --"
```

Expected:

- Fails identifier validation before SQL rendering.

### Resource table spoofing

Config tries to set storage table:

```yaml
storage:
  table: "pg_catalog.pg_user"
```

Expected:

- Reject or require generated/owned table names only.
- Resource tables should be in an owned namespace/prefix.

## Findings

1. Partial indexes are valuable, especially for optional unique fields and
   active/non-archived records.
2. Archive should be a default platform capability with generated fields and
   helpers.
3. CEL is a good fit for authoring predicates, but only a small subset should be
   SQL-lowerable.
4. Partial index predicates should not fallback to runtime-only enforcement; if
   they cannot compile to SQL safely, reject them.
5. The security boundary is the AST/typechecker/subset validator. Never lower
   raw expression strings directly to SQL.
6. Most injection attempts become parse/typecheck/subset failures if dynamic
   field access, unknown functions, unknown fields, and raw SQL are forbidden.
7. The preview output should explain both the CEL expression and generated SQL
   so users/agents can inspect what will be created.

## Resolved and Remaining Questions

- Use `@bufbuild/cel` for AST parsing if compatibility remains good.
- Implement Operant's own conservative SQL lowerer for the supported subset.
- Keep `empty(field)` out of MVP until string/list semantics are unambiguous.
- MVP partial indexes target Postgres only.
- Remaining: how do we test generated SQL without applying it to production
  tables? Use migration preview DB/schema sandbox?
