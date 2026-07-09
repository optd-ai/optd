# Chunk 6: Policy engine integration

## Deliverable
Enforce authorization for queries, object reads, changesets, actions, metadata where sensitive, and secrets groundwork.

## Scope
- Implement policy schema loading from pack metadata.
- Implement actor context shape and CLI/API actor input convention.
- Integrate RBAC/ABAC/one-hop ReBAC SQL compiler/evaluator from prototypes.
- Push policy predicates into query/list before pagination.
- Add runtime checks for object reads and changeset operations.
- Add audited `super_admin` bypass and stable denial explanations/error codes.
- Prepare policy hooks for actions/secrets used by later chunks.

## Validation requirements
- Unit tests for SQL/runtime parity and deep ReBAC rejection.
- Integration test asserts policy SQL is applied before pagination.
- Live CRM scenario: create data owned by different actors/teams; query as sales_rep/manager/viewer/super_admin; attempt unauthorized update and assert stable denial plus audit evidence.
- Verify pagination cursors include actor/policy digest.
