# History / Audit / Events / Outbox Prototype

This prototype validates the committed-write record model:

- generated resource table as mutable current projection
- `object_versions` as immutable JSON snapshot log, including current state
- `current_object_version_id` invariant on current rows
- `audit_events` pointing to object versions for accountability
- `events` pointing to object versions for committed facts
- `outbox` rows created for after-commit hook work
- `hook_executions` recorded by workers processing outbox rows

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/history-outbox/history-outbox-prototype.test.ts
```
