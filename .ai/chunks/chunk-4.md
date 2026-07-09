# Chunk 4: Changesets, object versions, audit/history, and seeds

## Deliverable
Make the write path real: preview/commit changesets, persist object history, and apply seeds through the auditable changeset-backed path.

## Scope
- Implement changeset v0 schemas and services for create, update, archive, transition, link, unlink, and comment.
- Implement preview validation: resources/fields/relationships, aliases, diffs, required/type validation, expected version checks.
- Implement commit transaction: current projection writes, relationship rows, immutable `object_versions`, `current_object_version_id`, `audit_events`, `events`, comments, stable response envelopes.
- Implement history/view routes and `optctl changeset preview/commit`, `optctl view`, `optctl history`.
- Implement seed lowering to ordinary changeset operations or an equivalent changeset-backed/audited path, with idempotent reapply.

## Validation requirements
- Unit tests for alias resolution, stable error mapping, optimistic version conflicts, and idempotent seed planning.
- Integration test proves commits create rows in resource tables, object_versions, audit_events, events, and comments.
- Live CRM scenario: apply CRM pack, seed reference data, create/update/comment/archive a lead through `optctl`, inspect `optctl view` and `optctl history`, and assert immutable versions/current projection.
- Reapply CRM pack and assert seed rows are not duplicated.

## Notes
- Changeset commit must be all-or-nothing and transaction controlled.
