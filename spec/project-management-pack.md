# Project Management Proof-Pack Requirements

Authoritative contract; edit this specification directly.

## Exact migrated contract

<a id="obj-com-exact-project-management-pack-v1"></a>

### Exact v1 contract — Project Management Proof-Pack Requirements

**Migration provenance.** Exact normative contract imported from
`spec/project-management-pack.md` at
`sha256:899349a5c143cd03d41de97f390ed218a90aabd0197c6d22905566367dc140d3`. Text
explicitly labeled historical, research, prototype evidence, or deferred remains
non-normative; all other versioned requirements below preserve the imported
contract semantics as maintained directly in these specifications.

> **Status:** normative proof-pack domain requirements. Runtime platform
> workspaces remain separate from the pack resource `optd/projects:project`;
> every pack object also carries an explicit platform workspace ID.

## Purpose

The MVP should include a second bundled pack inspired by Odoo's Workspace app to
prove that the platform is generic and not CRM-specific.

This pack should model workspaces, tasks, stages, milestones, tags, and
timesheet entries. It should be authored as normal pack files and must not
require engine special cases.

## Pack identity

```yaml
kind: Pack
apiVersion: optd.dev/v1
metadata:
  publisher: optd
  name: workspaces
  version: 0.1.0
spec:
  purpose: Workspace and task management resources for agent-operated work tracking.
  axi:
    home:
      resources: [optd/projects:project, optd/projects:task]
      help: ["optctl --workspace ${workspace} list optd/projects:task"]
```

The global pack identity is `optd/projects`; child definitions use canonical
identities such as `optd/projects:task`.

## Minimum resources

### `optd/projects:project`

Fields:

- `name`: string, required
- `description`: string, optional
- `status`: string enum, e.g. `active|on_hold|done|archived`
- `owner_id`: string with UUID format, required
- `visibility`: string enum, e.g. `private|members|internal`
- `start_date`: date, optional
- `target_date`: date, optional

AXI guidance should explain how agents create workspaces, find active work, and
inspect workspace health.

### `optd/projects:task`

Fields:

- `title`: string, required
- `description`: string, optional
- `project_id`: reference to `optd/projects:project`, required
- `stage_id`: reference to `optd/projects:task_stage`, required
- `state`: required string enum `todo|in_progress|blocked|done`; lifecycle field
- `assignee_id`: string with UUID format, optional
- `priority`: string enum, e.g. `low|normal|high|urgent`
- `deadline`: date, optional
- `blocked_reason`: string, optional
- `estimated_hours`: decimal, optional
- `spent_hours`: decimal, optional or derived later

### `optd/projects:task_stage`

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

### `optd/projects:project_milestone`

Fields:

- `name`: string, required
- `project_id`: reference to `optd/projects:project`, required
- `deadline`: date, optional
- `status`: string enum, e.g. `planned|at_risk|done`

### `optd/projects:task_tag`

Seedable reference resource.

Fields:

- `name`: string, required
- `color`: string, optional

### `optd/projects:project_member`

Fields:

- `project_id`: reference to `optd/projects:project`, required
- `principal_id`: string with UUID format, required
- `member_role`: string enum `manager|member|viewer`, required

A workspace-scoped composite unique constraint covers
`project_id + principal_id`.

### `optd/projects:timesheet`

Fields:

- `task_id`: reference to `optd/projects:task`, required
- `principal_id`: UUID string, required; references an authenticated platform
  principal identity by value (not a pack-object `ref`)
- `hours`: decimal, required and positive
- `description`: string, optional
- `entry_date`: date, required

## Relationships

Minimum relationships:

- `optd/projects:task_milestone`: task to milestone.
- `optd/projects:task_tag_assignment`: task to tag.

Workspace-to-task uses the required direct `task.project_id`; it is not also
duplicated as a relationship row. Membership is the explicit
`optd/projects:project_member` resource because membership carries domain role,
uniqueness, object history, and policy-visible lifecycle. The generic
relationship schema can target read-only `system:principal`; that capability is
not used as a substitute for this richer membership resource.

Use direct reference fields for required ownership links. Use relationship
tables when the link needs metadata, history, or policy.

## Lifecycle

`optd/projects:task` must have a lifecycle with states:

```text
todo -> in_progress -> blocked -> in_progress -> done
todo -> blocked
blocked -> done or todo only when `blocked_reason` is cleared in the same
transition; otherwise the stage is rejected
```

The lifecycle field is `state` and initial state is `todo`. `stage_id` selects a
board column whose seeded `state` must match; action hooks set both atomically.
Done requires no active `blocked_reason`, enforced by validation. Clear an
existing reason with `blocked_reason: ""` in the transition's field updates;
explicit null values are unsupported. Returning from blocked to todo likewise
requires clearing the reason atomically. Direct CLI transitions should set the
appropriate `stage_id` in the same input. `complete_task` already clears the
reason and selects the done stage atomically.

## Actions

Minimum one action is required; preferred set:

- `optd/projects:start_task`: moves a task from Todo/Blocked to In Progress.
- `optd/projects:block_task`: moves a task to Blocked and requires
  `blocked_reason`.
- `optd/projects:complete_task`: moves a task to Done and can optionally write
  spent-hours summary.

Actions use `action.stage`, are policy-checked/hook-validated, and commit only
through the returned immutable stage.

## Hooks

Minimum hooks:

- `validate_task`: `changeset.validate`. Rejects invalid state transitions,
  missing block reasons, or impossible timesheet hours.
- `notify_project_change`: `event.after_commit`. It returns `delivery.v1`
  success without network in deterministic tests, proving outbox execution.

Hooks must be Deno/TypeScript scripts with paired Hook YAML.

## Policies

Minimum policy rules:

- Built-in `system:super_admin` remains the platform bypass and is not a pack
  policy wildcard.
- `optd/projects:project_manager` can create/update/archive workspace-domain
  objects and tasks in platform workspaces where assigned.
- Workspace members can read workspace tasks and update tasks assigned to them.
- Assignees can start/block/complete their assigned tasks.
- Viewers can read visible workspaces/tasks.
- Administrators and managers can read archived Projects resources and task
  relationships within their Workspace boundary. Members and viewers do not gain
  archived-read authority.
- Administrators, managers, members and viewers can read active
  `task_tag_assignment` and `task_milestone` relationships and their history
  within their Workspace boundary. Relationship writes remain separately
  authorized.
- By-ID view/history automatically require `read_archived` for archived objects;
  queries additionally require explicit `--include-archived`. Hidden or
  unauthorized targets retain non-enumerating `not_found` responses.

These read-policy and unblock changes ship in Projects pack `0.2.1`. Upgrading
from `0.2.0` requires a reviewed migration; existing objects, history, seeds and
assignments are preserved. No automatic seed reconciliation is performed.

Use RBAC/ABAC and one-hop ReBAC only. Deep ReBAC is out of scope.

## Seeds

Seed at least:

- task stages
- common task tags, e.g. Bug, Feature, Chore, Research

Seeds use the exact changeset-backed reconcile route and
`seed:optd/projects:<seed>` authorization contract.

## Acceptance

The workspace-management pack is accepted when:

1. It applies on a fresh MVP server without special-case code.
2. `optctl metadata resource optd/projects:task` exposes fields, lifecycle,
   policy hints, and AXI guidance.
3. A test creates a workspace, creates a task, starts it, blocks it, unblocks
   it, completes it, logs a timesheet entry, and reads history.
4. Policy prevents a non-member/non-assignee from updating the task.
5. The after-commit hook writes an outbox/hook execution record.

## Onboarding and completion

Each Workspace explicitly initializes its reference data using seed commit
optd/projects --all. Projects administrators can initialize these seeds, import
historical objects with an audit reason, manage relationships and decide
approvals; seed execution does not require platform super-admin. An authorized
human or agent may complete its own task without a separate approval. Completion
hours and work_date are jointly optional; omitting both emits no timesheet,
while supplying one without the other is invalid. Required-field and action-read
metadata must be discoverable.
