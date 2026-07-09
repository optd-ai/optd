# Extensions

## Summary

Extensions let agents and integrations add metadata without requiring database
migrations for every new field.

Example for `task`:

- `github`
- `forecasting`
- `sales-agent`
- `jira-sync`

## Principles

- Extension fields live in namespaces.
- Only declared fields are queryable/indexed.
- Undeclared metadata may be stored if allowed, but should not participate in
  policy/index/search without declaration.
- Extension fields must still obey audit, changeset, policy, and resource
  constraint rules.

## Extension Definition

An extension field declaration should include:

- Namespace.
- Field key.
- Type.
- Validation.
- Default behavior.
- Indexing/queryability.
- Search/summarization participation.
- Permission/policy visibility.
- Version/deprecation metadata.

## Storage Direction

Initial storage can use JSONB for extension payloads plus generated columns or
side indexes for declared queryable fields.

## Open Questions

- Should extension schemas be pack-scoped, app-scoped, user-local, or globally
  published?
- How are extension field migrations/version changes handled?
- Can two extensions define fields with the same semantic purpose?
