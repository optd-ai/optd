# Events, Audit, History, and Outbox

## Status

This is the canonical spec for object history, audit events, committed events,
and outbox work. These concepts are related but intentionally separate.

## Core Boundary

Stage/commit persistence is frozen in
[Immutable Staged Changeset Storage](staged-changeset-storage.md). A committed
changeset can additionally create four kinds of evidence/delivery records:

1. `object_versions`: immutable committed object states, including the current
   state.
2. `audit_events`: accountability/explanation records.
3. `events`: committed facts for automation/subscriptions.
4. `outbox`: durable async hook work created from committed events.

Only `object_versions` stores full object snapshots. Other tables point to
object versions and store purpose-specific metadata.

## Authentication contexts

Every successfully authenticated HTTP request creates one immutable
`auth_contexts` row:

```sql
auth_contexts
- id                       uuid primary key
- request_id               uuid not null
- principal_type           text not null
  -- human_user | agent_user | system
- principal_id             uuid not null
- human_user_id            uuid null
- agent_user_id            uuid null
- auth_session_id          uuid null
- authorization_id         uuid null
- root_authorization_id    uuid null
- credential_kind          text not null
  -- human_session | agent_authorization | authorization_request | password_login | internal
- auth_method              text not null
  -- bearer | password | internal
- created_at               timestamptz not null default now()
```

Bounded roles used by the credential are snapshotted separately:

```sql
auth_context_role_assignments
- auth_context_id          uuid references auth_contexts(id)
- role_id                  uuid not null
- boundary_type            text not null
  -- project | all_projects | system
- project_id               uuid null
```

These are server-derived query dimensions, not client assertions. An auth
context describes the authenticated credential, not one target boundary. Login,
status, and authorization-request operations therefore need no artificial
boundary, while one multi-project changeset can use the same context. The
changeset/audit `policy_summary_json` records per-operation project, action,
matched bounded roles, policies/rules, and allow/deny result. The changeset is
committed or denied atomically; no separate per-boundary authorization-decision
resource is required.

An authorization-request bearer is represented as the associated `human_user`
principal with `credential_kind = authorization_request` and no effective role
assignments. Its narrow endpoint allowlist is enforced before normal policy
evaluation.

The server does not receive or persist local process evidence, cwd, OS user,
hostname, command summary, local binding id, or model/harness metadata.

`principal_id` identifies who authenticated. `human_user_id` identifies the
human authority anchoring an agent. Effective-actor display is derived from
structured principal and bounded roles rather than a flattened string.

Auth contexts are immutable. Core identity, role, boundary, decision, executor,
and causation provenance cannot be rewritten. There is no special provenance
redaction workflow for MVP; intentionally supplied auth-request reason/friendly
name live on auth workflow records rather than auth contexts.

Pre-auth databases may be invalidated when this schema is introduced. Operant
has no deployed auth users requiring `actor_id` backfill or compatibility. New
code moves directly to `auth_context_id`; legacy `actor_id` is not a second
authoritative identity source.

## Current Objects and Object Versions

Every committed object state, including the current state, has an
`object_versions` row.

Generated resource tables are mutable, query-optimized current projections.
`object_versions` is the immutable state log.

Generated resource tables should include:

```sql
project_id uuid not null references projects(id)
current_object_version_id uuid references object_versions(id)
```

Object UUIDv7 values are globally unique, but `project_id` remains explicit on
current rows, versions, policies, queries, events, and audit evidence.

After every committed changeset:

```text
res_<resource>.current_object_version_id
  points to object_versions.id
  whose snapshot_json represents the current row
```

This invariant is maintained in the same transaction as the object write.

## `object_versions`

Purpose: canonical immutable object history.

It stores historical snapshots as JSON so old object history does not need to
remain schema-compatible after resource migrations.

Proposed fields:

```sql
object_versions
- id                    uuid primary key
- project_id            uuid not null references projects(id)
- definition_kind       text not null       # resource | relationship
- resource_identity     text not null
- object_id             uuid not null        # object or relationship UUID
- version               integer not null
- previous_version_id   uuid null references object_versions(id)
- changeset_commit_id   uuid not null references changeset_commits(id)
- operation             text not null
  -- create | update | archive | transition | link | unlink
- resource_revision     uuid not null
- snapshot_json         jsonb not null
  -- resource: {"data": {...}, "archived_at": ...}
  -- relationship: {"from": uuid, "to": uuid, "fields": {...}, "archived_at": ...}
- changed_fields        text[] not null default '{}'
- auth_context_id       uuid not null references auth_contexts(id)
- created_at            timestamptz not null default now()

unique(project_id, resource_identity, object_id, version)
```

`id` is the globally unique object-version identifier used by foreign keys.
`version` is the human-friendly per-object sequence used for optimistic locking
and history display.

`changed_fields` is a cached lightweight diff for common history views. It does
not need to be a full structural diff. Agents can inspect adjacent snapshots
when they need exact before/after values.

History is immutable through the API. The only supported destructive operation
is purging an object and all of its history, which should be special/admin-only.
Signed/tamper-evident digests can be added later if needed; they are not
required for v1.

Restore is not a special platform operation. Agents can inspect an old
`object_versions` row and submit a normal changeset, optionally with a
comment/note that it is restoring or reverting prior state.

## `audit_events`

Purpose: accountability log.

Audit answers:

> Who attempted or committed what, through which changeset, with what
> policy/validation/hook decision?

Audit events point to object history records when an object version exists. They
do not duplicate full snapshots.

Proposed fields:

```sql
audit_events
- id                       uuid primary key
- stage_id                 uuid null references staged_changesets(id)
- changeset_commit_id      uuid null references changeset_commits(id)
- object_version_id        uuid null references object_versions(id)
- auth_context_id          uuid null references auth_contexts(id)
- executor_type             text null
  -- human_user | agent_user | system
- executor_id               uuid null
- causation_audit_event_id  uuid null references audit_events(id)
- authentication_failure_code text null
- event_type               text not null
  -- changeset.staged
  -- changeset.committed
  -- changeset.denied | cancelled
  -- object.created
  -- object.updated
  -- object.archived
  -- hook.executed
  -- policy.denied
  -- auth.recovery.initiated | completed | cancelled | expired
  -- secret.created | rotated | disabled | rotated_and_enabled
  -- hook_secret_grant.created | carried_forward | replaced | revoked
  -- hook_secret_resolution.failed
- project_id              uuid null references projects(id)
- resource_identity       text null
- object_id               uuid null
- action                  text null
  -- read | create | update | archive | transition | action:operant/crm:convert_lead
- decision                 text null
  -- allowed | denied | warning | committed | failed
- policy_summary_json      jsonb null
- validation_summary_json  jsonb null
- hook_execution_ids       uuid[] not null default '{}'
- request_metadata_json    jsonb not null default '{}'
  -- evolving server/protocol metadata only; no local process evidence
- created_at               timestamptz not null default now()
```

Comments are append-only records with their own UUIDv7, project/target identity,
body, target object-version provenance, commit/auth context, and timestamp. They
do not create or increment a target `object_versions` row.

Why audit is separate from object versions:

- denied staging/commit attempts have no object version but need audit records.
- hook/policy validation may happen during staging before any object version
  exists.
- audit records explain decisions; object versions store committed state.

An authenticated authorization denial has an auth context. A failure before
authentication completes uses the same audit table with `auth_context_id = null`
and an `authentication_failure_code` such as `credential_missing`,
`credential_invalid`, `session_revoked`, or `authorization_ancestor_invalid`. No
principal is invented when authentication did not establish one. The server does
not store IP, user-agent, or client fingerprinting for these failures.

This is one audit provenance model with an optional context for pre-auth
failures, not two competing lookup systems. Rejected operations never create
committed `events`; successful committed events reach provenance through their
changeset's committed auth context.

## Execution and causation

The initiating auth context and actual executor are separate. For synchronous
work, executor normally equals the authenticated principal. For background hook
work, `auth_context_id` preserves the initiating request while `executor_type`
and `executor_id` identify a system actor such as `system:outbox_worker`.
`causation_audit_event_id` links derived work to the audit event that caused it.

`staged_changesets.created_auth_context_id` and
`changeset_commits.committed_auth_context_id` are separate because stage and
commit are different requests. Object versions and comments reference the committing auth context.
Hook executions reference the initiating auth context plus their system executor
and causation record.

## `events`

Purpose: committed facts for automation and subscriptions.

Events answer:

> What committed fact happened that hooks/subscribers may react to?

Events should point to object history when relevant. They do not store policy
explanations, validation details, delivery state, or full snapshots.

Proposed fields:

```sql
events
- id                    uuid primary key
- changeset_commit_id   uuid not null references changeset_commits(id)
- project_id            uuid null references projects(id)
- object_version_id     uuid null references object_versions(id)
- schema_version        integer not null default 1
- event_type            text not null
  -- object.created
  -- object.updated
  -- object.archived
  -- object.transitioned
  -- comment.added
  -- relationship.created
  -- changeset.committed
- resource_identity  text null
- object_id           uuid null
- occurred_at        timestamptz not null default now()
- payload_json       jsonb not null default '{}'
```

`payload_json` should be minimal routing/context data, such as:

```json
{
  "changed_fields": ["status"],
  "from_state": "qualified",
  "to_state": "converted"
}
```

Consumers can load `object_versions.snapshot_json` through `object_version_id`
if they need full state.

## `outbox`

Purpose: internal durable queue for after-commit hook execution.

The outbox is not history and not a user-facing activity feed. It stores
retryable work that should happen after a transaction commits.

All after-commit side effects should be powered by hooks. The outbox queues hook
invocations derived from committed events.

Examples powered by outbox hook work:

- after-commit hooks
- webhooks implemented by hooks or hook-returned side-effect intents
- Slack/email notifications implemented by hooks
- search indexing hooks
- embedding generation hooks
- cache/materialized-view refresh hooks
- external sync hooks

The normative schema and lifecycle are frozen in
[Durable Outbox Delivery](outbox-delivery.md). One mutable delivery aggregate
owns status, pinned execution identity, stable idempotency key, retry generation,
availability, and fixed lease. Append-only attempt rows own each claim's timing,
worker identity, outcome, and redacted error. Hook executions own logs/digests
and secret-version evidence.

The main server runs one in-process polling loop and claims ready rows using
`FOR UPDATE SKIP LOCKED`; no Redis/Kafka, daemon, LISTEN/NOTIFY dependency, or
second container is required. Delivery is durable at-least-once and deliberately
unordered in MVP. A stable delivery UUID is supplied as the external provider
idempotency key across retries, lease recovery, and manual retry generations.

Queued work pins immutable hook revision/script/security/attachment/grant
context. New events select the active revision; old queued work runs old code
with the secret's current value version. Configuration/security failures dead
letter immediately; transient structured outcomes use configurable full-jitter
backoff. Cancellation is allowed only before claim. All operational rows are
retained in MVP.

## Commit Transaction Flow

For an object update:

```text
begin

update res_lead ... version = version + 1
insert object_versions 019b7a2e-7c10-7000-8000-000000000201 snapshot_json = current row after update
update res_lead set current_object_version_id = 019b7a2e-7c10-7000-8000-000000000201
insert changeset_commits ... stage_id = 019b7a2e-7c10-7000-8000-000000000202
insert audit_events ... changeset_commit_id + object_version_id = 019b7a2e-7c10-7000-8000-000000000201
insert events ... changeset_commit_id + object_version_id = 019b7a2e-7c10-7000-8000-000000000201
insert outbox delivery rows for event.after_commit hooks subscribed to the event

commit
```

Outbox workers later process rows after commit. They should read immutable
`object_versions` through `events.object_version_id`, not race-read mutable
current resource rows.

## Boundary Summary

| Table             | Job                               | Full snapshot? | Used for                                   |
| ----------------- | --------------------------------- | -------------- | ------------------------------------------ |
| `auth_contexts`   | immutable request auth provenance | no             | principal/roles/boundary/session lookup    |
| `object_versions` | immutable committed object states | yes            | history, diff, agent-driven restore/revert |
| `audit_events`    | accountability/explanation        | no             | who/why/decision trail                     |
| `events`          | committed facts                   | no             | automation/subscriptions                   |
| `outbox`          | async after-commit hook queue     | no             | retryable side effects                     |

## Frozen v1 retention/versioning

- Every event stores `schema_version: 1`; event type plus schema version defines
  its minimal payload contract. Outbox rows pin their envelope schema separately.
  Incompatible future event payloads use a new integer version.
- MVP retains audit events, committed events, and object versions indefinitely.
  Operational outbox detail follows its own retain-all MVP contract.
- Object/history hard purge is not exposed in MVP. Archive plus compensating
  changesets are the supported lifecycle. A future purge design must preserve or
  tombstone referential audit/event provenance explicitly.
