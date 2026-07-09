# Chunk 11: Project-management pack and genericity validation

## Deliverable
Add and validate a second bundled Odoo-inspired project-management pack proving the engine is generic.

## Scope
- Add `packs/project-management/` or `prototypes/project-management-pack/` per final convention.
- Implement resources/actions/hooks/policies/seeds from `spec/project-management-pack.md`.
- Add Deno hook scripts such as `validate_task.ts` and `notify_project_change.ts` plus action hooks if action-backed.
- Add AXI guidance for home/resource/action metadata.
- Do not add project-specific server code.

## Validation requirements
- Live project scenario: apply project pack, create project, create task, start task, block task, unblock task, complete task, log timesheet entry, query tasks, read history, drain outbox.
- Negative scenario: non-member/non-assignee cannot update task.
- Verify same engine paths as CRM are used and no project-specific server code exists.
