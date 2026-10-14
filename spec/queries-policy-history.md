# Queries, policy, and history

Canonical queries, policy, and history decisions and contracts.

## Concepts

<a id="obj-con-policy-query"></a>

### SQL-lowered policy/query

A fixed CEL subset lowers to parameterized SQL. Policy filters run before keyset
sorting, limiting, cursoring, and exact counts.

## Decisions

<a id="obj-dec-semantic-search-deferred"></a>

### Defer semantic and vector search

Semantic/vector search, generated summaries, and MCP tools are outside current
scope until they have explicit schemas, authorization behavior, storage, and
acceptance tests. Current AI/API scope is strict permission-filtered
query/object/history reads through REST and compiled CLI.

**Rationale.** No current route, schema, storage, or implementation supports
semantic search; claiming it as built in is misleading.

## Commitments

<a id="obj-com-query-cursors"></a>

### Bind keyset cursors to canonical query and policy context

Query/history/outbox pagination uses signed canonical cursors bound to filters,
ordering, Workspace, actor policy/root, and generation where relevant; mismatch
fails rather than silently restarting.

<a id="obj-com-history"></a>

### Preserve versions, comments, audit, events, and compensation boundaries

Current objects are mutable projections of immutable object versions. Audit
records attempts/decisions, events record committed facts, and compensation uses
new changes rather than generic undo.
