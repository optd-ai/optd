# MVP API Routes

Decision: use Proposal A for MVP server routes.

The server API is JSON-only. `optctl` is the primary agent interface and renders
TOON by default. Historical Proposal B is retained below only as rejected design
context; implementation subagents should use Proposal A.

## Proposal A: resource-oriented routes

This proposal uses stable nouns and explicit subresources.

```text
GET  /health

GET  /metadata/home
GET  /metadata/packs
GET  /metadata/packs/{namespace}/{name}
GET  /metadata/resources/{namespace}/{resource}
GET  /metadata/actions/{namespace}/{action}
GET  /metadata/hooks/{namespace}/{hook}
GET  /metadata/policies/{namespace}/{policy}

POST /packs/preview
POST /packs/apply

GET  /migrations/{migration_id}
GET  /migrations/{migration_id}/violations
GET  /migrations/{migration_id}/sql
POST /migrations/{migration_id}/validate
POST /migrations/{migration_id}/apply
POST /migrations/{migration_id}/confirm

POST /queries
GET  /objects/{namespace}/{resource}/{id}
GET  /objects/{namespace}/{resource}/{id}/history

POST /changesets/preview
POST /changesets/commit
GET  /changesets/{changeset_id}
POST /changesets/{changeset_id}/commit

POST /actions/{namespace}/{action}/preview
POST /actions/{namespace}/{action}/commit

GET  /outbox
POST /outbox/drain
POST /outbox/{id}/retry

GET  /secrets
POST /secrets
DELETE /secrets/{name}
```

Pros:

- Familiar REST-ish shape.
- Clear nouns and subresources.
- Easy for external clients to understand.
- Good fit for future OpenAPI.

Cons:

- More path parameters.
- Dotted CLI identifiers need conversion to path segments.
- Actions are separate from objects even when object-scoped.

## Proposal B: command-oriented routes with dotted identifiers

This proposal mirrors `optctl` and keeps identifiers as dotted strings in JSON
bodies.

```text
GET  /health

GET  /metadata/home
POST /metadata/get          { "kind": "resource", "id": "default.lead" }
POST /metadata/list         { "kind": "resource" }

POST /pack/preview
POST /pack/apply

POST /migration/inspect     { "migration_id": "..." }
POST /migration/validate    { "migration_id": "..." }
POST /migration/apply       { "migration_id": "...", "mode": "safe|reviewed|confirm" }

POST /query
POST /object/view           { "resource": "default.lead", "id": "lead_123" }
POST /object/history        { "resource": "default.lead", "id": "lead_123" }

POST /changeset/preview
POST /changeset/commit
POST /changeset/get         { "changeset_id": "..." }

POST /action/preview        { "action": "default.convert_lead", "input": {} }
POST /action/commit         { "action": "default.convert_lead", "input": {} }

POST /outbox/status
POST /outbox/drain
POST /outbox/retry          { "id": "..." }

POST /secret/list
POST /secret/set
POST /secret/delete
```

Pros:

- Very close to `optctl` command model.
- Dotted identifiers remain unchanged between CLI and API.
- Fewer route patterns.
- Easier to evolve bodies without changing paths.

Cons:

- Less idiomatic for HTTP clients.
- Harder to browse manually.
- OpenAPI/resource docs look less conventional.

## Recommendation

Prefer **Proposal A** for MVP server routes because it gives clearer external
HTTP contracts and a better future OpenAPI path. `optctl` can keep dotted
identifiers and translate them to path segments.

Keep request/response schemas explicit either way.
