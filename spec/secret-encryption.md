<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-secret-encryption; contract: 1; input: sha256:f2eafc3ae4b7a9bfa6c3ec8b80d1ecc845e80c67835c1d9c71d0e8cf5c003a96 -->

# Secret Encryption Model

Generated exact-contract projection imported into project-model/model.json from the reviewed secret-encryption.md source.

## Exact migrated contract

<a id="obj-com-exact-secret-encryption-v1"></a>

### Exact v1 contract — Secret Encryption Model

**Migration provenance.** Exact normative contract imported from `spec/secret-encryption.md` at `sha256:245fc34ad2f90fef04c5a023d2dc626a70315d38c44ddd31a49860e81b7d15f7`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

Secrets are encrypted at the application layer before they are written to
Postgres. Do not rely only on Postgres/database-level encryption at rest.

## Decision

Use envelope-style application encryption:

- Server reads a master key from an environment variable mounted at runtime,
  `OPTD_SECRET_MASTER_KEY`.
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

Secrets have server-generated UUIDv7 identities and globally unique names. One
mutable encrypted value and monotonic `value_version` are retained per secret;
MVP does not retain historical ciphertext versions.

```sql
create table platform_secrets(
  id uuid primary key,
  name text not null unique,
  description text,
  ciphertext bytea not null,
  nonce bytea not null,
  algorithm text not null,
  key_id text not null,
  value_version bigint not null default 1,
  status text not null default 'active',
  created_auth_context_id uuid not null,
  updated_auth_context_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  disabled_auth_context_id uuid
);
```

## MVP key behavior

- `OPTD_SECRET_MASTER_KEY` is base64 for exactly 32 random bytes. Encryption
  is AES-256-GCM with a fresh 96-bit cryptographic nonce per value; `key_id` is
  a non-secret SHA-256 fingerprint of the key and algorithm/version.
- The key is required before secret create/rotate/decrypt. If no secret rows
  exist, the server may start without it and secret mutation/resolution returns
  `secret_key_unavailable` (503).
- If any encrypted secret exists, a missing/malformed key or key-ID mismatch is
  a fatal startup/readiness error. The server never starts a partially usable
  secret subsystem and never guesses another key.
- AES-GCM additional authenticated data is canonical UTF-8 JSON containing
  `schema: secret.value.v1`, secret UUID, value version, and key ID. This
  prevents ciphertext/nonce swapping between rows or versions; authentication
  failure fails closed and is audited without plaintext.
- Master-key rotation is deferred; a mismatched key fails rather than rewriting
  ciphertext. The schema retains `key_id` for explicit future rotation.
- Credential rotation atomically replaces ciphertext/nonce and increments
  `value_version`; existing hook-secret grants remain valid.
- Disabled secrets return to active only by rotating to a new value. Normal APIs
  do not hard-delete encrypted secrets.
- Audit records include secret name and action, never plaintext or ciphertext.
- Super admin bootstraps the admin role; normal permission checks control secret
  management after bootstrap.

## Hook injection

Hook config declares required logical slots and env names. A separate global,
revision-specific hook-secret grant maps each slot to one concrete secret.
Runner decrypts only effectively granted secrets immediately before spawning the
hook, injects only those env vars, grants narrow `--allow-env=...`, and never
logs values. The normative lifecycle, authorization, rotation, audit, API, and
CLI contract is [Hook-Secret Grants](hook-secret-grants.md).
