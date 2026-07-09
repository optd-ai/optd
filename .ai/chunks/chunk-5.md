# Chunk 5: Expression lowering, query/list, projection, pagination, and cursor safety

## Deliverable
Enable safe reads through SQL-lowered filters, projections, sorting, and cursor pagination.

## Scope
- Implement expression adapter using `@bufbuild/cel` AST and Operant-owned conservative SQL lowerer for the MVP subset.
- Implement `POST /queries`, `query_objects` service, and `optctl query`.
- Validate field projections against metadata.
- Implement sort and keyset/cursor pagination.
- Bind cursors to filter/sort/projection/actor-policy digest.
- Default to active rows; include archived only through the available permission/super_admin path until policy is integrated.

## Validation requirements
- Unit tests for unsupported functions, unknown fields, type mismatches, non-boolean roots, complexity limits, and parameterization.
- Integration test proves generated SQL uses parameters and returns expected CRM rows.
- Live CRM scenario: create multiple leads, query active leads by owner/status/email, paginate, project fields, and verify cursor mismatch errors when changing filter/sort.
- Scenario must use data created through chunk 4 changesets/seeds.
