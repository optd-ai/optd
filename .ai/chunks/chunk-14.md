# Chunk 14: Full-system CRM end-to-end validation and release hardening

## Deliverable
Prove the MVP works as an actual platform through full CRM and project-management workflows.

## Scope
- Add final scenario `tests/scenarios/99_full_crm_e2e.ts` or equivalent.
- Run from clean data dir/container through compiled `optctl` against real server.
- Cover: startup, migrations, home, CRM pack preview/apply, seeds, metadata, changeset create/update/comment/archive, query filters/pagination, policy denial, convert lead action, linked contact/company/opportunity verification, activity/log/won-lost flow, outbox drain, history/audit/events, idempotency behavior, restart persistence, and migration fixture.
- Also run the project-management scenario from chunk 11.
- Harden docs/commands only where needed to make validation repeatable.

## Validation requirements
- This chunk is the validation gate and must not pass by only running unit tests.
- Execute real flows and inspect real persisted results.
- Keep artifacts/logs for failures.
- Final output should include exact scenario/container commands and pass/fail evidence.
