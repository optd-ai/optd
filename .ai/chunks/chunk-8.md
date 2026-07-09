# Chunk 8: Durable outbox worker and hook execution records

## Deliverable
Process after-commit hooks durably with retries, dead-lettering, and observable execution records.

## Scope
- Implement outbox schema/statuses and repository: pending/running/succeeded/failed/dead_letter, attempts, available_at, locked_by, locked_at, last_error.
- Implement worker claim with `for update skip locked`.
- Implement retry/backoff and dead-letter behavior.
- Persist append-only `hook_executions`.
- Add routes `GET /outbox`, `POST /outbox/drain`, `POST /outbox/{id}/retry`.
- Add `optctl outbox status/drain/retry`.

## Validation requirements
- Integration test proves two drain/worker calls do not double-claim the same row.
- Live CRM scenario: commit operation that enqueues after-commit hook, run `optctl outbox status`, `optctl outbox drain`, verify hook_executions and outbox succeeded.
- Include a failing hook fixture if practical and verify retry/dead-letter behavior.
- Confirm after-commit hooks do not run inline inside the committing transaction.
