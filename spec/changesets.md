# Changesets

## Summary

Objects are not modified through raw CRUD. Every write is submitted as an
intention and processed through the same changeset engine.

Executable prototype evidence lives in `prototypes/changesets/`. It runs a Deno
HTTP server backed by PGlite and tests changeset preview/commit/action flows
through real HTTP requests and SQL reads/writes.

## Canonical Write Path

1. Receive intention.
2. Build changeset.
3. Preview diff.
4. Validate schema, database constraints, and business rules.
5. Run deterministic validation hooks/scripts.
6. Evaluate policy/RBAC/ABAC/ownership.
7. Evaluate state-transition rules.
8. Check optimistic locks and idempotency.
9. Execute transaction.
10. Write new immutable `object_versions` rows for every changed object and
    update current rows' `current_object_version_id`.
11. Write audit records and committed events pointing to object versions where
    relevant.
12. Enqueue after-commit hook work in `outbox`.
13. Commit and return result.

## Intentions

Examples:

- Create object
- Update fields
- Add comment
- Attach file
- Link objects
- Transition lifecycle state
- Soft delete object
- Submit for approval
- Approve/reject changeset
- Undo/compensate committed change

## Preview

A preview should show:

- Objects affected.
- Field-level diffs where meaningful.
- Relationship changes.
- State transitions.
- Required approvals.
- Policy allow/deny results.
- Validation errors/warnings.
- Conflicts and stale versions.
- Events/hooks that would be emitted/enqueued.

## Idempotency

Every commit-capable request should accept an idempotency key scoped by actor
and action endpoint. Replays should return the original committed result or a
safe conflict if the payload differs.

Previews are persisted by default. Clients may commit a persisted preview by id,
and the server must revalidate at commit time before writing.

The selected database should enforce idempotency with unique constraints. In
horizontally scaled deployments, app nodes must not coordinate with each other
outside Postgres.

## Conflict Detection

Use optimistic locking by object version. A changeset can include expected
versions for all touched objects. The commit fails or returns a conflict preview
when any expected version is stale.

## Approval Flow

A changeset can be valid but not immediately committable. In that case it
becomes a pending approval object with:

- Proposed diff.
- Actor and submitter.
- Required approvers.
- Expiration, if any.
- Revalidation behavior at approval time.

## Undo and Recovery

Undo is not a blanket guarantee. Supported cases should be explicit:

- Pure data changes may be reversible with inverse changesets.
- External side effects require compensation.
- Some actions are irreversible and should be labeled as such during preview.

## Hooks and Scripts

Changesets are the safest place to integrate executable behavior:

- Validation scripts can reject or warn during preview.
- Transition scripts can derive additional changes.
- After-commit scripts can perform external side effects through the outbox.

Pre-commit scripts should be deterministic, bounded, audited, and fail closed
unless configured otherwise.

## Prototype Evidence

`prototypes/changesets/changeset-server.ts` currently validates these
assumptions:

- HTTP payload validation can feed a canonical operation parser.
- Preview can normalize operations, generate diffs with SQL reads, and return
  validation errors without writes.
- Persisted previews can be committed later by id and are revalidated at commit
  time.
- Commit can run SQL writes transactionally, write history/audit/event records,
  and enforce idempotency with a SQL unique key.
- Idempotency key reuse with a different payload returns a stable conflict
  error.
- Optimistic version conflicts prevent partial commits.
- Minimal policy checks can participate in the same preview/commit validation
  result.
- Relationship aliases and missing references can be validated before any writes
  occur.
- Action endpoints can generate `changeset.operations.v1` operations and then
  reuse the same preview/commit engine.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/changesets/changeset-server.test.ts
```

## Error Shape

Transport/request errors should use a stable envelope:

```json
{
  "ok": false,
  "error": {
    "code": "bad_request | conflict | not_found | internal_error",
    "message": "human readable message",
    "details": []
  }
}
```

Validation failures should generally be successful HTTP responses with
`ok: false` and structured validation details so agents can repair payloads
without treating the request as a transport failure:

```json
{
  "ok": false,
  "validation": {
    "errors": [
      {
        "level": "error",
        "path": "/operations/0",
        "code": "version_conflict",
        "message": "expected version 1, found 2"
      }
    ],
    "warnings": []
  }
}
```

## Archive Behavior

Archive is a universal platform field on resource tables, initially represented
as `archived_at` and eventually paired with `archived_by`.

Initial decisions:

- Archived objects cannot be updated.
- Archived objects cannot be linked through relationships.
- Archived objects are hidden from default reads/lists.
- Archived objects remain explicitly readable for audit/recovery using an
  include-archived option.
- Archive is preferred over hard delete in normal changesets.

## Transaction Semantics

A changeset either commits completely or does not commit at all. Partial success
inside one changeset is not allowed. Validation failures return structured
validation results before writes. Runtime failures during commit roll back the
transaction and return a structured error.

One changeset may span multiple resource types and relationships when all
operations can commit in one transaction.

## Open Questions

- What is the exact v0 changeset JSON shape? The vertical slice should finalize
  this from the prototype shape.
