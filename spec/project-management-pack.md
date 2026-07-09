# Project Management Pack

## Purpose

The MVP should include a second bundled pack inspired by Odoo's Project app to
prove that the platform is generic and not CRM-specific.

This pack should model projects, tasks, stages, milestones, tags, and timesheet
entries. It should be authored as normal pack files and must not require engine
special cases.

## Pack identity

```yaml
kind: Pack
apiVersion: operant.dev/v1
metadata:
  namespace: default
  name: project_management
  version: 0.1.0
spec:
  purpose: Project and task management resources for agent-operated work tracking.
```

Dotted IDs use the `default` namespace, e.g. `default.task`.

## Minimum resources

### `default.project`

Fields:

- `name`: string, required
- `description`: text/string, optional
- `status`: string enum, e.g. `active|on_hold|done|archived`
- `owner_id`: string, required
- `visibility`: string enum, e.g. `private|members|internal`
- `start_date`: date/datetime, optional
- `target_date`: date/datetime, optional

AXI guidance should explain how agents create projects, find active work, and
inspect project health.

### `default.task`

Fields:

- `title`: string, required
- `description`: text/string, optional
- `project_id`: reference to `default.project`, required
- `stage_id`: reference to `default.task_stage`, required
- `assignee_id`: string, optional
- `priority`: string enum, e.g. `low|normal|high|urgent`
- `deadline`: date/datetime, optional
- `blocked_reason`: text/string, optional
- `estimated_hours`: number, optional
- `spent_hours`: number, optional or derived later

### `default.task_stage`

Seeded reference resource.

Fields:

- `name`: string, required
- `state`: string enum: `todo|in_progress|blocked|done`
- `sequence`: integer, required
- `folded`: boolean, optional

Required seed records:

- Todo
- In Progress
- Blocked
- Done

### `default.project_milestone`

Fields:

- `name`: string, required
- `project_id`: reference to `default.project`, required
- `deadline`: date/datetime, optional
- `status`: string enum, e.g. `planned|at_risk|done`

### `default.task_tag`

Seedable reference resource.

Fields:

- `name`: string, required
- `color`: string, optional

### `default.timesheet_entry`

Fields:

- `task_id`: reference to `default.task`, required
- `actor_id`: string, required
- `hours`: number, required
- `description`: text/string, optional
- `entry_date`: date/datetime, required

## Relationships

Minimum relationships:

- `default.project_task`: project to task if not represented only by
  `task.project_id`.
- `default.task_milestone`: task to milestone.
- `default.task_tag_assignment`: task to tag.
- `default.project_member`: project to actor/user id or actor-like member object
  if an actor resource exists later.

Use direct reference fields for required ownership links. Use relationship
tables when the link needs metadata, history, or policy.

## Lifecycle

`default.task` must have a lifecycle with states:

```text
todo -> in_progress -> blocked -> in_progress -> done
todo -> blocked
blocked -> done only if validation permits or manager override exists
```

The initial stage is Todo. Done tasks require either no blocking reason or a
validation hook that confirms the block was resolved.

## Actions

Minimum one action is required; preferred set:

- `default.start_task`: moves a task from Todo/Blocked to In Progress.
- `default.block_task`: moves a task to Blocked and requires `blocked_reason`.
- `default.complete_task`: moves a task to Done and can optionally write
  spent-hours summary.

Actions should use the same action/hook contract as CRM actions: previewable,
policy-checked, hook-validated, and commit through changesets.

## Hooks

Minimum hooks:

- `validate_task`: before changeset/action validation. Rejects invalid stage
  transitions, missing block reasons, or impossible timesheet hours.
- `notify_project_change`: after commit. Demonstrates outbox execution without
  requiring an external network call in tests.

Hooks must be Deno/TypeScript scripts with paired Hook YAML.

## Policies

Minimum policy rules:

- `super_admin`/admin can do everything.
- Project managers can create/update/archive projects and tasks in projects they
  manage.
- Project members can read project tasks and update tasks assigned to them.
- Assignees can start/block/complete their assigned tasks.
- Viewers can read visible projects/tasks.

Use RBAC/ABAC and one-hop ReBAC only. Deep ReBAC is out of scope.

## Seeds

Seed at least:

- task stages
- common task tags, e.g. Bug, Feature, Chore, Research

Seeds must be applied through ordinary auditable changesets or the
implementation's changeset-backed seed path.

## Acceptance

The project-management pack is accepted when:

1. It applies on a fresh MVP server without special-case code.
2. `optctl metadata resource default.task` exposes fields, lifecycle, policy
   hints, and AXI guidance.
3. A test creates a project, creates a task, starts it, blocks it, unblocks it,
   completes it, logs a timesheet entry, and reads history.
4. Policy prevents a non-member/non-assignee from updating the task.
5. The after-commit hook writes an outbox/hook execution record.
