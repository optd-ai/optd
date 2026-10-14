<!-- generated-by: pi-dag-workflow/project-model; view: view-queries-policy-history; contract: 1; input: sha256:59f1ccd10a2c31d036e69e2f6b5639c673b0cd2628a82793a578c6a11737b864 -->

# Queries, policy, and history

Canonical queries, policy, and history decisions and contracts projected from project-model/model.json.

## Concepts

<a id="obj-con-policy-query"></a>

### SQL-lowered policy/query

A fixed CEL subset lowers to parameterized SQL. Policy filters run before keyset sorting, limiting, cursoring, and exact counts.

## Decisions

<a id="obj-dec-semantic-search-deferred"></a>

### Defer semantic and vector search

Semantic/vector search, generated summaries, and MCP tools are outside current scope until they have explicit schemas, authorization behavior, storage, and acceptance tests. Current AI/API scope is strict permission-filtered query/object/history reads through REST and compiled CLI.

**Rationale.** No current route, schema, storage, or implementation supports semantic search; claiming it as built in is misleading.

## Commitments

<a id="obj-com-query-cursors"></a>

### Bind keyset cursors to canonical query and policy context

Query/history/outbox pagination uses signed canonical cursors bound to filters, ordering, Workspace, actor policy/root, and generation where relevant; mismatch fails rather than silently restarting.

<a id="obj-com-history"></a>

### Preserve versions, comments, audit, events, and compensation boundaries

Current objects are mutable projections of immutable object versions. Audit records attempts/decisions, events record committed facts, and compensation uses new changes rather than generic undo.
