<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-query-api; contract: 1; input: sha256:1da2a74f1147e72dbaf6744486ed9ea07aaffc9e4e70035433b6db2354c3cb86 -->

# Query and Object Read API v1

Generated exact-contract projection imported into project-model/model.json from the reviewed query-api.md source.

## Exact migrated contract

<a id="obj-com-exact-query-api-v1"></a>

### Exact v1 contract — Query and Object Read API v1

**Migration provenance.** Exact normative contract imported from `spec/query-api.md` at `sha256:551ee5b8c344c7624e274adc5034e804cd8676349e562a16e12217a660e439d9`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Read DTOs

A resource object uses:

```json
{
  "kind": "object",
  "id": "019b7a2e-7c10-7000-8000-000000000001",
  "project_id": "019b7a2e-7c10-7000-8000-000000000002",
  "resource": {
    "publisher": "optd",
    "pack": "crm",
    "name": "lead",
    "revision_id": "019b7a2e-7c10-7000-8000-000000000003"
  },
  "version": 4,
  "object_version_id": "019b7a2e-7c10-7000-8000-000000000004",
  "data": { "name": "Acme", "status": "qualified" },
  "archived_at": null,
  "created_at": "2026-07-14T12:00:00.000Z",
  "updated_at": "2026-07-14T13:00:00.000Z"
}
```

Pack fields exist only under `data`; platform fields cannot collide.

A relationship row uses:

```json
{
  "kind": "relationship",
  "id": "019b...",
  "project_id": "019c...",
  "relationship": {
    "publisher": "optd",
    "pack": "crm",
    "name": "contact_company",
    "revision_id": "019d..."
  },
  "version": 2,
  "object_version_id": "019e...",
  "from": "019f...",
  "to": "019a...",
  "fields": { "role": "buyer" },
  "archived_at": null,
  "created_at": "2026-07-14T12:00:00.000Z",
  "updated_at": "2026-07-14T13:00:00.000Z"
}
```

`optctl` may flatten selected `data`/`fields` in default TOON tables but
`--json` preserves these DTOs.

## Query request

`POST /api/v1/queries` accepts exactly:

```json
{
  "project_id": "019b7a2e-7c10-7000-8000-000000000002",
  "definition": {
    "kind": "resource",
    "publisher": "optd",
    "pack": "crm",
    "name": "lead"
  },
  "where": "status == 'qualified' && active()",
  "fields": ["name", "status", "owner_id"],
  "sort": [
    { "field": "updated_at", "direction": "desc" }
  ],
  "limit": 50,
  "cursor": null,
  "include_archived": false,
  "include_total": false
}
```

- Project/definition are required and explicit. `definition.kind` is
  `resource|relationship`.
- `where` is optional and defaults `true`; it uses the frozen CEL query subset.
  Relationship context exposes payload fields plus `from` and `to` UUID fields.
- `fields` is optional. If absent, server resolves the definition AXI list
  fields; if AXI has none it uses a bounded platform default. Unknown or
  duplicate fields fail. Field-level policy is not an MVP feature. Platform
  identity/version/timestamps are always in the outer DTO and are not projection
  names.
- `sort` is optional and resolves AXI default then `updated_at desc`. It is a
  non-empty bounded array of declared scalar pack fields (plus relationship
  `from|to`) or `created_at|updated_at|archived_at`; direction is `asc|desc`.
  The server always appends `id` in the final direction as a unique tie-breaker
  and reports the resolved sort.
- `limit` defaults 50, minimum 1, configurable maximum default 500.
- `cursor` is null/omitted on the first page.
- `include_archived` defaults false and adds an implicit active-row predicate
  regardless of `where`. True removes only that implicit predicate and requires
  exact `read_archived` in addition to `read`; explicit `active()` still filters
  active rows. Single-object archived reads require the same.
- `include_total` defaults false. True returns a policy-filtered exact count
  from the same single SQL statement/CTE snapshot as the page, including empty
  pages; it never counts hidden rows.
- Unknown request properties fail `bad_request`.

## Response

```json
{
  "ok": true,
  "data": {
    "items": [],
    "resolved_fields": ["name", "status", "owner_id"],
    "resolved_sort": [
      { "field": "updated_at", "direction": "desc" },
      { "field": "id", "direction": "desc" }
    ]
  },
  "meta": {
    "request_id": "019b...",
    "next_cursor": null,
    "has_more": false,
    "total": null,
    "policy_context_digest": "sha256:..."
  }
}
```

`items` use the matching object/relationship DTO with projected `data`/`fields`.
Relationship endpoint UUIDs remain present regardless of projection. Empty pages
are successful and explicit. `total` is integer only when requested, otherwise
null.

## Policy and pagination ordering

Applicable project/boundary policy is lowered into the SQL `WHERE` before
sorting, keyset predicates, limiting, and counting. Application-side
post-filtering and offset pagination are forbidden.

The opaque cursor is base64url of bounded RFC 8785 canonical JSON containing
only schema version, query-shape digest, policy-context digest, resolved sort,
last typed sort values, and last UUID. It contains no SQL, token, roles, object
payload, or secrets. Cursor content is untrusted and fully schema/type/size
validated; policy is always reapplied. A server secret is unnecessary because a
forged cursor can only change keyset position within currently authorized rows.

The query-shape digest binds project/definition revision, normalized CEL AST,
projection, resolved sort, limit semantics, and archive/count flags. The policy
context digest binds principal/authorization root plus active role/policy
assignment/revision context. Any mismatch returns `invalid_cursor`; callers
start a new query. Cursors do not promise a snapshot across pages: committed
inserts/updates may appear according to ordinary keyset semantics.

## Object/relationship/history reads

Object and relationship GET routes resolve explicit project/definition/row ID
and apply `read` (and `read_archived` when needed) before returning the matching
DTO. Definition or project mismatch returns safe `not_found`/`project_conflict`
without existence leak.

History GET returns one cursor-paginated timeline newest first by
`created_at,id`. Entries have discriminator `object_version|comment`.
Object-version entries contain version ID/number, operation, commit/auth
provenance safe for the caller, changed fields, and full historical `data`;
comment entries contain comment ID/body, target version ID, commit/auth
provenance, and timestamp. Comments never masquerade as object versions. History
access uses `read` plus `history.read`; archived history also requires
`read_archived`.
