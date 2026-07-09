# Chunk 7: Metadata-driven hooks and actions

## Deliverable
Run CRM hooks/actions from pack metadata without hardcoded names, and enqueue after-commit work.

## Scope
- Implement Deno hook runner adapter: stdin envelope, stdout schema validation, stderr capture, timeout, Deno permission flags, global permission policy, script digest audit, no imports initially.
- Implement hook attachment discovery and hook input mapping/schema validation.
- Integrate resource validation/normalization hooks into changeset preview/commit flow.
- Implement action hooks returning `changeset.operations.v1` and routes `POST /actions/{namespace}/{action}/preview|commit`.
- Implement `optctl action preview/commit`.
- Enqueue after-commit hook work into outbox rows; worker execution is chunk 8.

## Validation requirements
- Adapter tests for permission failures, timeout, bad JSON, invalid output schema, and stderr capture.
- Integration tests for CRM `normalize_lead` and `validate_lead` modifying/validating proposed data.
- Live CRM scenario: create lead with normalization, attempt invalid lead rejected by hook, preview/commit `default.convert_lead`, verify contact/company/opportunity rows and history.
- Verify action authorization from chunk 6 runs before action commit.
