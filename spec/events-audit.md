# Events, Audit, History, and Outbox

## Status

This is the canonical spec for object history, audit events, committed events,
and outbox work. These concepts are related but intentionally separate.

## Core Boundary

A committed changeset can create four kinds of records:

1. `object_versions`: immutable committed object states, including the current
   state.
2. `audit_events`: accountability/explanation records.
3. `events`: committed facts for automation/subscriptions.
4. `outbox`: durable async hook work created from committed events.

Only `object_versions` stores full object snapshots. Other tables point to
object versions and store purpose-specific metadata.

## Current Objects and Object Versions

Every committed object state, including the current state, has an
`object_versions` row.

Generated resource tables are mutable, query-optimized current projections.
`object_versions` is the immutable state log.

Generated resource tables should include:

```sql
current_object_version_id text references object_versions(id)
```

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
- id                    text primary key
- resource              text not null
- object_id             text not null
- version               integer not null
- previous_version_id   text null references object_versions(id)
- changeset_id          text not null references changesets(id)
- operation             text not null
  -- create | update | archive | transition | link | unlink | comment
- resource_revision     text not null
- snapshot_json         jsonb not null
- changed_fields        text[] not null default '{}'
- actor_id              text not null
- created_at            timestamptz not null default now()

unique(resource, object_id, version)
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
- id                       text primary key
- changeset_id             text null references changesets(id)
- object_version_id        text null references object_versions(id)
- actor_id                 text not null
- event_type               text not null
  -- changeset.previewed
  -- changeset.committed
  -- changeset.denied
  -- object.created
  -- object.updated
  -- object.archived
  -- hook.executed
  -- policy.denied
- resource                 text null
- object_id                text null
- action                   text null
  -- read | create | update | archive | transition | action.convert_lead
- decision                 text null
  -- allowed | denied | warning | committed | failed
- policy_summary_json      jsonb null
- validation_summary_json  jsonb null
- hook_execution_ids       text[] not null default '{}'
- request_metadata_json    jsonb not null default '{}'
- created_at               timestamptz not null default now()
```

Why audit is separate from object versions:

- denied changesets have no object version but need audit records.
- hook/policy validation may happen during preview before any object version
  exists.
- audit records explain decisions; object versions store committed state.

## `events`

Purpose: committed facts for automation and subscriptions.

Events answer:

> What committed fact happened that hooks/subscribers may react to?

Events should point to object history when relevant. They do not store policy
explanations, validation details, delivery state, or full snapshots.

Proposed fields:

```sql
events
- id                 text primary key
- changeset_id       text not null references changesets(id)
- object_version_id  text null references object_versions(id)
- event_type         text not null
  -- object.created
  -- object.updated
  -- object.archived
  -- object.transitioned
  -- comment.added
  -- relationship.created
  -- changeset.committed
- resource           text null
- object_id          text null
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

Proposed fields:

```sql
outbox
- id             text primary key
- event_id       text not null references events(id)
- hook_name      text not null
- hook_revision  text not null
- script_digest  text not null
- envelope_json  jsonb not null
- status         text not null
  -- pending | running | succeeded | failed | dead
- attempts       integer not null default 0
- available_at   timestamptz not null default now()
- locked_by      text null
- locked_at      timestamptz null
- last_error     text null
- created_at     timestamptz not null default now()
- updated_at     timestamptz not null default now()
```

Workers claim outbox rows with Postgres locking, run the hook, write
`hook_executions`, and update outbox status. No Redis/Kafka/external coordinator
is required for correctness.

## Commit Transaction Flow

For an object update:

```text
begin

update res_lead ... version = version + 1
insert object_versions ov_123 snapshot_json = current row after update
update res_lead set current_object_version_id = ov_123
insert audit_events ... object_version_id = ov_123
insert events ... object_version_id = ov_123
insert outbox rows for after_commit hooks subscribed to the event

commit
```

Outbox workers later process rows after commit. They should read immutable
`object_versions` through `events.object_version_id`, not race-read mutable
current resource rows.

## Boundary Summary

| Table             | Job                               | Full snapshot? | Used for                                   |
| ----------------- | --------------------------------- | -------------- | ------------------------------------------ |
| `object_versions` | immutable committed object states | yes            | history, diff, agent-driven restore/revert |
| `audit_events`    | accountability/explanation        | no             | who/why/decision trail                     |
| `events`          | committed facts                   | no             | automation/subscriptions                   |
| `outbox`          | async after-commit hook queue     | no             | retryable side effects                     |

## Open Questions

- Event schema versioning strategy.
- Webhook/after-commit hook ordering guarantees per object/resource.
- Retention period for audit records and event payloads.
- Exact purge semantics for object + history deletion.
