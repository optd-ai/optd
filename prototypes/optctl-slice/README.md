# optctl Vertical Slice Command Surface Sketch

The vertical slice should include `optctl` as the agent-facing client. Output
should be TOON-style, compact, and include contextual `help[]` next steps.

## Pack commands

```text
optctl pack preview ./packs/crm
optctl pack apply ./packs/crm
```

Preview output should show discovered files, normalized objects, SQL/migration
plan summary, hooks/scripts/digests, seeds, and validation errors.

## Metadata commands

```text
optctl metadata
optctl metadata pack crm
optctl metadata resource crm.lead
optctl metadata action crm.convert_lead
optctl metadata hooks crm
```

Used when an agent is unsure what exists or how to use a resource/action.

## Query/list commands

```text
optctl query crm.lead --where 'status == "qualified" && active()' --fields id,name,status,score --limit 20
optctl query crm.lead --cursor <cursor>
```

Backed by `POST /queries`, not GET bodies. Output should include items, page
metadata, filter summary, policy summary, fields source, and help.

## Object view/history commands

```text
optctl view crm.lead lead_123
optctl history crm.lead lead_123
optctl history show <object_version_id>
```

History should read from `object_versions` and related audit/events/comments.
Restore is not a special command in v0; agents can create a normal changeset
from historical snapshots.

## Changeset commands

```text
optctl changeset preview --file change.json
optctl changeset commit <changeset_id>
optctl changeset commit --file change.json --idempotency-key <key>
```

Preview output should show normalized operations, diffs, validation, policy
decisions, hook executions, and events/outbox hooks that would be enqueued.

## Action commands

```text
optctl action preview crm.convert_lead --input '{lead_id: "lead_123"}'
optctl action commit crm.convert_lead --input '{lead_id: "lead_123"}' --idempotency-key <key>
```

Actions use hook-generated `changeset.operations.v1`, then reuse changeset
preview/commit.

## Migration commands

```text
optctl migration inspect <migration_id>
optctl migration validate <migration_id>
optctl migration apply <migration_id> --stage 1
optctl migration apply <migration_id> --confirm <token>
```

Cleanup/backfill uses ordinary changesets. Backups/exports are separate
commands, not migration commands.

## Backup/export commands

```text
optctl backup object crm.lead lead_123
optctl backup query crm.lead --where 'present(company_name)'
```

Backups are agent-discretionary operational commands
