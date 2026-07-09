# Pagination + Policy Filtering Prototype

This prototype validates agent-friendly pagination where user filters and authorization policies are pushed into SQL before pagination.

It uses a Deno HTTP server backed by PGlite.

## What it proves

- Query/list uses `POST /queries`, not GET bodies.
- Filters use a small CEL-like SQL-lowerable subset.
- Policy predicates are SQL-pushed before pagination.
- One-level ReBAC policy filtering compiles to a SQL join.
- Keyset/cursor pagination uses deterministic ordering with `id` tie-breaker.
- Cursors are bound to filter/sort/actor-policy digest and rejected if reused with different query context.
- Default list fields come from pack/resource AXI list guidance.
- Explicit fields can reduce response size for agent context.
- `include_archived` requires permission.
- Limit is capped.
- Unsupported fields/sorts are rejected.
- Responses include page/filter/policy/help metadata.

## Run server

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/pagination/pagination-server.ts
```

## Test

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/pagination/pagination-server.test.ts
```

## Query endpoint

```text
POST /queries
```

Example body:

```json
{
  "actor": {
    "id": "alice",
    "roles": ["sales_rep"],
    "team_ids": ["team_west"]
  },
  "resource": "lead",
  "fields": ["id", "name", "status", "score"],
  "where": "status == \"qualified\" && score >= 50",
  "sort": [
    { "field": "updated_at", "direction": "desc" },
    { "field": "id", "direction": "desc" }
  ],
  "limit": 25,
  "cursor": null
}
```

## Response shape

Responses include:

- `items`: compact projected rows.
- `page`: limit, returned count, `has_more`, `next_cursor`, sort.
- `fields`: whether fields came from request or AXI defaults.
- `filter`: user filter summary.
- `policy`: policy summary.
- `help`: next-step hints for agents.
