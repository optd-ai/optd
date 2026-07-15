# API Actions

## Philosophy

The API is action-oriented, not CRUD-oriented. It should guide agents through:

Read -> Reason -> Stage -> Commit -> Recover

## Frozen action surface

- Preview pack source and apply one exact migration plan atomically.
- Discover metadata/AXI/capability summaries.
- Read/query/search object data and history.
- Stage the seven frozen operations: create, update, transition, archive, link,
  unlink, and append-only comment.
- Stage semantic pack actions or seed reconciliation, inspect/cancel/approve/
  reject/commit the returned immutable stage.
- Recover through an explicitly supported reverse transition or ordinary
  compensating changeset.

Binary attachments, generic labels, hard delete/unarchive, automatic undo,
separate approval submission, and raw resource-definition CRUD are not MVP
operations.

## AI Interaction Contract

An AI agent should be able to ask:

- What object/resource types exist?
- What actions can I perform?
- What fields are required?
- What lifecycle transitions are allowed?
- What approvals are required?
- What exact staged transaction would this commit?
- Why was this denied?
- How can I recover from this conflict?

## REST boundary

Canonical paths are exclusively [MVP API Routes](mvp-api-routes.md). Structured
query/list/search uses `POST /queries` with [Query and Object Read API](query-api.md),
not GET bodies or a second search endpoint. Domain mutation is operation/action
staging; no public raw table or mutable resource-definition CRUD route exists.

## Frozen interface boundary

- Staging and commit are separate endpoints. There is no raw-intent
  stage-and-commit server endpoint; CLI direct commit sequences the two calls.
- HTTP JSON is canonical. `optctl` is a typed client/TOON renderer over the same
  application services and must not implement business semantics. MCP is not an
  MVP transport; a future adapter must call the same application services.

## Error/explanation contract

Query, staging, commit, pack/migration, hook, and outbox routes share
[API Response and Error Contract](api-errors.md). Policy denials additionally use
the safe no-escalation explanation fields frozen in the policy spec.
