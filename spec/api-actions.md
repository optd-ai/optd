# API Actions

## Philosophy

The API is action-oriented, not CRUD-oriented. It should guide agents through:

Read -> Reason -> Preview -> Commit -> Recover

## Candidate Actions

- Apply/preview resource configuration.
- Discover object types/resources and capabilities.
- Read object.
- Query objects.
- Search objects.
- Explain allowed actions.
- Create object intention.
- Update object intention.
- Link/unlink objects.
- Attach/comment/label.
- Transition state.
- Preview changeset.
- Commit changeset.
- Submit for approval.
- Approve/reject changeset.
- Undo/compensate supported changes.

## AI Interaction Contract

An AI agent should be able to ask:

- What object/resource types exist?
- What actions can I perform?
- What fields are required?
- What lifecycle transitions are allowed?
- What approvals are required?
- What would change if I committed this intention?
- Why was this denied?
- How can I recover from this conflict?

## REST Shape Sketch

Exact endpoints are undecided, but the API should avoid exposing raw row
mutation as the main path.

Structured query/list operations should use `POST /queries` with a JSON body
rather than GET request bodies. GET bodies are poorly supported by common
Fetch-compatible runtimes and tooling; `POST /queries` gives agents reliable
space for filters, field selection, sort, cursor, and pagination metadata.

Possible resources:

- `GET /resources`
- `POST /resources/preview`
- `POST /resources/apply`
- `GET /object-types`
- `GET /objects/{id}`
- `POST /queries`
- `POST /search`
- `POST /changesets/preview`
- `POST /changesets/commit`
- `POST /changesets/{id}/approve`
- `POST /changesets/{id}/reject`
- `POST /objects/{id}/actions/explain`

## Open Questions

- Should preview and commit be separate endpoints or one endpoint with modes?
- How should REST, CLI, and MCP share the same action model?
- What is the canonical error/explanation format?
