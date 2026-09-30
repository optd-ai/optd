<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-project-management-pack; contract: 1; input: sha256:7be8a0236acaf41b05e690ab845b3e2fd6ef65d612783d34c0b33470bb734bac -->

# Project Management Proof-Pack Requirements

Generated exact-contract projection imported into project-model/model.json from the reviewed project-management-pack.md source.

## Exact migrated contract

<a id="obj-com-exact-project-management-pack-v1"></a>

### Exact v1 contract — Project Management Proof-Pack Requirements

**Migration provenance.** Exact normative contract imported from `spec/project-management-pack.md` at `sha256:899349a5c143cd03d41de97f390ed218a90aabd0197c6d22905566367dc140d3`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

> **Status:** normative proof-pack domain requirements. Runtime platform
> projects remain separate from the pack resource `optd/projects:project`;
> every pack object also carries an explicit platform project ID.

## Purpose

The MVP should include a second bundled pack inspired by Odoo's Project app to
prove that the platform is generic and not CRM-specific.

This pack should model projects, tasks, stages, milestones, tags, and timesheet
entries. It should be authored as normal pack files and must not require engine
special cases.

## Pack identity

```yaml
kind: Pack
apiVersion: optd.dev/v1
metadata:
  publisher: optd
  name: projects
  version: 0.1.0
spec:
  purpose: Project and task management resources for agent-operated work tracking.
  axi:
    home:
      resources: [optd/projects:project, optd/projects:task]
      help: ["optctl --project ${project} list optd/projects:task"]
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

AXI guidance should explain how agents create projects, find active work, and
inspect project health.

### `optd/projects:task`

Fields:

- `title`: string, required
- `description`: string, optional
- `work_project_id`: reference to `optd/projects:project`, required
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
- `work_project_id`: reference to `optd/projects:project`, required
- `deadline`: date, optional
- `status`: string enum, e.g. `planned|at_risk|done`

### `optd/projects:task_tag`

Seedable reference resource.

Fields:

- `name`: string, required
- `color`: string, optional

### `optd/projects:project_member`

Fields:

- `work_project_id`: reference to `optd/projects:project`, required
- `principal_id`: string with UUID format, required
- `member_role`: string enum `manager|member|viewer`, required

A project-scoped composite unique constraint covers
`work_project_id + principal_id`.

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

Project-to-task uses the required direct `task.work_project_id`; it is not also
duplicated as a relationship row. Membership is the explicit
`optd/projects:project_member` resource because membership carries domain
role, uniqueness, object history, and policy-visible lifecycle. The generic
relationship schema can target read-only `system:principal`; that capability is
not used as a substitute for this richer membership resource.

Use direct reference fields for required ownership links. Use relationship
tables when the link needs metadata, history, or policy.

## Lifecycle

`optd/projects:task` must have a lifecycle with states:

```text
todo -> in_progress -> blocked -> in_progress -> done
todo -> blocked
blocked -> done only when `blocked_reason` has been cleared; otherwise the
stage is rejected (a manager may first stage the corrective update)
```

The lifecycle field is `state` and initial state is `todo`. `stage_id` selects a
board column whose seeded `state` must match; action hooks set both atomically.
Done requires an absent `blocked_reason`, enforced by validation.

## Actions

Minimum one action is required; preferred set:

- `optd/projects:start_task`: moves a task from Todo/Blocked to In Progress.
- `optd/projects:block_task`: moves a task to Blocked and requires
  `blocked_reason`.
- `optd/projects:complete_task`: moves a task to Done and can optionally
  write spent-hours summary.

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
- `optd/projects:project_manager` can create/update/archive project-domain
  objects and tasks in platform projects where assigned.
- Project members can read project tasks and update tasks assigned to them.
- Assignees can start/block/complete their assigned tasks.
- Viewers can read visible projects/tasks.

Use RBAC/ABAC and one-hop ReBAC only. Deep ReBAC is out of scope.

## Seeds

Seed at least:

- task stages
- common task tags, e.g. Bug, Feature, Chore, Research

Seeds use the exact changeset-backed reconcile route and
`seed:optd/projects:<seed>` authorization contract.

## Acceptance

The project-management pack is accepted when:

1. It applies on a fresh MVP server without special-case code.
2. `optctl metadata resource optd/projects:task` exposes fields, lifecycle,
   policy hints, and AXI guidance.
3. A test creates a project, creates a task, starts it, blocks it, unblocks it,
   completes it, logs a timesheet entry, and reads history.
4. Policy prevents a non-member/non-assignee from updating the task.
5. The after-commit hook writes an outbox/hook execution record.
