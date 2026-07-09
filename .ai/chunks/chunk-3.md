# Chunk 3: Resource and relationship SQL compilation

## Deliverable
Apply pack definitions into actual Postgres resource and relationship tables.

## Scope
- Implement table-per-resource DDL generation for current projection tables with platform columns, declared fields, required constraints where appropriate, archive/version columns, timestamps, and `current_object_version_id`.
- Implement first-class relationship table DDL generation for `rel_*` tables.
- Integrate first-install DDL plan into pack apply.
- Persist generated table names and DDL/migration metadata.
- Ensure previews fail before mutation for invalid field types, duplicate identifiers, or unsafe generated SQL.

## Validation requirements
- Apply CRM pack against real Postgres.
- Introspect actual Postgres system catalogs/information_schema for `res_lead`, `res_opportunity`, and at least one `rel_*` table; do not rely only on stored metadata.
- Live scenario after `optctl pack apply` verifies expected tables exist through a scenario-only DB assertion or a public metadata/migration response.
- Negative test: invalid field type or duplicate SQL identifier fails preview and leaves no partial generated table behind.

## Notes
- Keep SQL helpers small, parameterized, and under the Postgres adapter.
