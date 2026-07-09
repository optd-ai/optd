# Changeset HTTP + PGlite Prototype

This prototype exercises the proposed changeset operation schema against a real in-memory PGlite database behind a Deno built-in HTTP server.

It is intentionally small, but it runs the same shape of flow expected in the platform:

1. HTTP request payload validation.
2. Changeset operation parsing.
3. Normalization/patch behavior.
4. Preview diff generation using SQL reads.
5. Schema/business validation.
6. Optimistic version checks.
7. Persisted preview followed by commit-by-id with revalidation.
8. Transactional commit with SQL writes.
9. Idempotency-key handling backed by a SQL table, including conflict detection.
10. Minimal policy checks.
11. Audit event writes.
12. Action endpoint that generates `changeset.operations.v1` operations.

## Covered operations

- `create`
- `update`
- `archive`
- `transition`
- `link`
- `comment`

## Run server

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/changesets/changeset-server.ts
```

Server defaults to `http://127.0.0.1:8787`.

## Test end to end

The tests start the HTTP server on an ephemeral port and submit real HTTP requests.

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/changesets/changeset-server.test.ts
```

## Useful endpoints

- `GET /health`
- `GET /meta`
- `GET /objects/:resource/:id`
- `POST /changesets/preview`
- `POST /changesets/commit`
- `POST /changesets/:id/commit`
- `POST /actions/convert_lead/preview`
- `POST /actions/convert_lead/commit`

## Example preview request

```json
{
  "actor": "agent_1",
  "operations": [
    {
      "op": "create",
      "resource": "lead",
      "as": "lead",
      "fields": {
        "name": "Jane Agent",
        "email": "JANE@EXAMPLE.COM"
      }
    }
  ]
}
```

The prototype normalizes lead emails to lowercase and defaults missing lead status to `new` during preview.

## Stable error shape

Transport/request errors use:

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

Validation failures are successful HTTP responses with `ok: false`, `committed: false` for commit attempts, and structured validation details:

```json
{
  "ok": false,
  "validation": {
    "errors": [
      { "level": "error", "path": "/operations/0", "code": "version_conflict", "message": "expected version 1, found 2" }
    ],
    "warnings": []
  }
}
```

## Archive behavior decision

The prototype treats archive as a universal platform field (`archived_at`) on resource tables.

Initial behavior:

- Archived objects cannot be updated.
- Archived objects cannot be linked through relationships.
- Archived objects are hidden from default object reads.
- Archived objects remain readable with `include_archived=true` for audit/recovery workflows.
- Archiving itself is policy-protected in the prototype: only `admin` may archive.
