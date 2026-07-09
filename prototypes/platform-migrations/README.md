# Platform DB Migrations Spike

Validates app/platform schema migration behavior separate from pack migrations:

- `platform_schema_migrations` table
- idempotent migration application
- per-migration transaction
- checksum drift detection

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/platform-migrations/platform-migrations-spike.test.ts
```
