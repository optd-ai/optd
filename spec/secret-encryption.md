# Secret Encryption Model

Secrets should be encrypted at the application layer before they are written to
Postgres. Do not rely only on Postgres/database-level encryption at rest.

## Decision direction

Use envelope-style application encryption:

- Server reads a master key from an environment variable mounted at runtime,
  e.g. `OPERANT_SECRET_MASTER_KEY`.
- Secret plaintext is accepted only through privileged APIs/CLI commands.
- Server encrypts plaintext before insert/update.
- Postgres stores ciphertext, nonce/iv, algorithm metadata, and key id/version.
- Secret values are not returned through normal read APIs after set, except to
  the hook runner at execution time when explicitly authorized.

## Why not only Postgres encryption at rest?

Database/disk-level encryption protects against stolen disks/volumes, but it
does not protect secrets from:

- SQL dumps,
- accidental query exposure,
- overly broad DB access,
- application bugs that select rows,
- backups copied outside the encrypted volume.

Application-level encryption keeps the database from holding plaintext secret
values.

## Minimal MVP table shape

```sql
create table platform_secrets(
  name text primary key,
  description text,
  ciphertext bytea not null,
  nonce bytea not null,
  algorithm text not null,
  key_id text not null,
  created_by text not null,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

## MVP key behavior

- `OPERANT_SECRET_MASTER_KEY` is required before creating/reading secrets.
- If encrypted secrets exist and the key is missing, server startup should fail
  or secret subsystem should fail closed.
- Key rotation can be deferred, but schema should include `key_id` so rotation
  can be added later.
- Audit records include secret name and action, never plaintext or ciphertext.
- Super admin bootstraps the admin role; normal permission checks control secret
  management after bootstrap.

## Hook injection

Hook config declares secret refs and env var names. Runner decrypts only the
referenced secrets immediately before spawning the hook, injects only those env
vars, grants narrow `--allow-env=...`, and never logs values.
