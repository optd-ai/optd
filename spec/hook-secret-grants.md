# Hook-Secret Grants

## Purpose

Secrets are global encrypted system resources. A hook-secret grant authorizes
one pinned hook revision to receive one global secret through one declared
required slot. Grants authorize trusted code, not the human/agent invoking the
semantic action, and never transfer secret-read authority to that principal.

Project policy determines who may invoke an action in each project. Secret
selection does not vary by project. When separate external environments are
needed, packs define separate hooks/actions and grant each hook only its own
credential; automatic project-to-integration routing is deferred to a future
explicit integration model.

## Hook slots

A hook declares logical required credential slots rather than operator-specific
secret names:

```yaml
spec:
  secrets:
    - slot: salesforce_token
      env: SALESFORCE_TOKEN
```

Rules:

- Every declared slot is required; there is no optional-secret property.
- `slot` uses lowercase snake case and is unique within the hook.
- `env` uses an uppercase environment identifier and is unique within the hook.
- Secret env names cannot collide with declared non-secret env names.
- Staging/action input cannot override environment values.
- A slot identifies purpose within one hook; it is not a platform secret name.
- Multiple hook definitions may reference the same applied script while keeping
  independent identities, permissions, security digests, and grants.

## Global secrets

Secrets are globally named system resources and have no project/all-project
boundary:

```text
platform_secrets
- id                         UUIDv7 primary key
- name                       text unique
- description                text null
- ciphertext                 bytea not null
- nonce                      bytea not null
- algorithm                  text not null
- key_id                     text not null
- value_version              bigint not null
- status                     active | disabled
- created_auth_context_id     UUIDv7
- updated_auth_context_id     UUIDv7
- created_at                 timestamptz
- updated_at                 timestamptz
- disabled_at                timestamptz null
- disabled_auth_context_id    UUIDv7 null
```

Secret names use lowercase letters, digits, `_`, and `-`, begin with a letter or
digit, and are globally unique. Names are operator labels; grants and audit
references use UUIDv7 identities.

Values are opaque non-empty UTF-8 strings. Multiline values such as PEM are
allowed. NUL is rejected because environment injection cannot represent it.
Binary credentials are supplied as base64 by the operator. The maximum encoded
value size is configurable with a suggested 1 MiB default. Typed secret schemas
are deferred.

Plaintext is accepted only through authenticated create/rotate operations,
encrypted with AES-256-GCM before persistence, and never returned by read/list
APIs. `OPERANT_SECRET_MASTER_KEY` supplies the application master key as defined
in [Secret Encryption](secret-encryption.md).

## Grant model

```text
hook_secret_grants
- id                         UUIDv7 primary key
- hook_revision_id           UUIDv7
- hook_security_digest       text
- slot                       text
- secret_id                  UUIDv7 references platform_secrets(id)
- created_auth_context_id     UUIDv7
- inherited_from_grant_id     UUIDv7 null
- supersedes_grant_id         UUIDv7 null
- created_at                 timestamptz
```

Revocation is append-only:

```text
hook_secret_grant_revocations
- id                         UUIDv7 primary key
- grant_id                   UUIDv7 unique
- revoked_auth_context_id     UUIDv7
- reason                     text null
- revoked_at                 timestamptz
```

An effective grant:

- targets the exact executable hook revision and one declared slot;
- has no revocation;
- has not been superseded by an effective replacement;
- points to an active secret;
- matches the hook revision's current recorded security digest.

At most one effective grant exists per `(hook_revision_id, slot)`. The runner
never searches secrets by name and never credential-shops or unions grants.

## Authorization

Creating, replacing, carrying forward, or revoking a hook-secret grant is a
system-bound operation and requires both current policy capabilities:

```text
secret.grant
hook.secret.configure
```

One authenticated actor must satisfy both checks. `system:super_admin` is the
explicit policy bypass. Neither capability permits plaintext retrieval.

Secret creation/rotation/disable and metadata listing use their separately
policy-defined system actions. Secret resolution by a hook is authorized by the
effective hook-secret grant, not by impersonating the initiating actor or
calling a human-facing `secret.read` API.

## Pack revisions and security equivalence

Grants remain revision-specific. Pack apply automatically carries a grant to a
new hook revision only when its hook security digest is unchanged.

The security digest includes security-relevant normalized hook behavior:

- script digest;
- secret slots and env mappings;
- network allowlist;
- named non-secret environment access;
- attachment phases, conditions, input mappings, and targets;
- output schema;
- declared Operant reads;
- declared effects/capabilities.

AXI guidance, display text, unrelated pack definitions, and runtime timeout
adjustments do not alter this digest.

A carried-forward grant is a new append-only row for the new revision and records
`inherited_from_grant_id` plus the pack-apply auth context. Any security-relevant
change requires explicit authorization for the new revision.

Pack preview/apply reports:

```text
preserved/carry-forward grants
grants requiring reauthorization
new ungranted slots
old grants retained for pinned outbox work
unused grants
```

Pack apply is allowed with missing grants. New or changed secret-bearing hooks
fail closed before execution until configured; unrelated pack behavior remains
usable.

## Secret creation and execution

Typical flow:

```text
create encrypted global secret
→ apply hook declaring a required slot
→ grant secret to active hook revision slot
→ invoke semantic action
→ resolve/decrypt/inject immediately before hook execution
```

Before a hook starts, the runner:

1. Loads the pinned hook revision and verifies its security digest.
2. Resolves exactly one effective grant for every declared slot.
3. Verifies the secret is active and the master key is available.
4. Decrypts the current ciphertext in memory.
5. Injects only the declared environment names.
6. Grants narrow Deno `--allow-env` access to those names.
7. Executes the hook.
8. Removes plaintext references/environment with the child process lifetime.
9. Records grant ID, secret ID, `value_version`, slot, and env name in execution
   evidence without recording plaintext/ciphertext/nonce.

A missing, revoked, superseded, disabled, undecryptable, or digest-mismatched
required grant returns `hook_secret_unavailable` before hook execution. A stage
hook failure creates no stage.

Ordinary callers see only hook identity and slot. They do not receive concrete
secret name, decryption detail, corrective grant commands, role suggestions, or
escalation guidance. Authorized system administrators may inspect detailed
non-plaintext metadata.

## Staging and commit

Synchronous hook-secret authorization is consumed when the stage hook executes.
The stage records the hook revision, security digest, grant ID, secret ID, and
`value_version` as immutable execution evidence.

Commit does not recheck that grant or secret because it never executes the hook
or accesses plaintext. Rotation, disablement, replacement, or revocation after
staging does not invalidate an otherwise valid staged operation graph. Explicit
stage/hook-revision invalidation, if needed for compromised code, belongs to
commit revalidation rather than secret resolution.

## Rotation

Rotation keeps one mutable encrypted value per stable secret identity:

```text
same secret ID
same hook grants
new ciphertext/nonce
value_version + 1
```

The server transaction locks the row, encrypts the new non-empty value with a
fresh nonce, replaces ciphertext metadata, increments `value_version`, updates
auth/time provenance, writes audit evidence, and commits atomically. Hooks see a
complete old or new row, never mixed encryption fields.

A running invocation retains the already injected old value. Future invocations
use the newly committed value. No historical secret-value table, rollback,
overlapping activation window, or version-specific grant is in MVP.

Rotating a disabled secret with a new value also returns it to active status and
audits `secret.rotated_and_enabled`. There is no direct enable action that could
restore a compromised old value.

## Disablement and purge

Normal lifecycle is:

```text
active → disabled
```

Disablement prevents future injection while preserving encrypted data, grant
references, and audit evidence. Normal APIs do not hard-delete secrets. A future
privileged retention/purge operation may destroy ciphertext while preserving a
tombstoned identity and audit references.

Grant revocation is irreversible. Restoring access requires a new or replacement
grant.

## Atomic grant replacement

Switching a slot to a different semantic secret is not rotation. Replacement
requires the expected effective grant ID and atomically:

1. locks/checks that current grant;
2. creates the new append-only grant with `supersedes_grant_id`;
3. makes the prior grant ineffective;
4. writes audit evidence;
5. commits.

A stale expected grant returns conflict. This avoids revoke/create gaps and
concurrent replacement races.

## Pinned outbox work

Outbox rows pin the hook revision, script/security digests, attachment, envelope
schema, and grant context selected when work was enqueued. Pack upgrade does not
automatically revoke old revision grants. New events use the active revision;
already queued work may execute only its pinned old revision.

Pinned old execution uses the stable granted secret identity's current
`value_version`, not retained historical plaintext. Current global runtime policy,
secret status, grant revocation, and explicit old-revision disablement still
apply. Operators may revoke old grants. Retry/cancellation/dead-letter behavior
is frozen in [Durable Outbox Delivery](outbox-delivery.md).

## Shared scripts and multiple environments

Multiple hooks may reference one script without sharing credentials:

```text
validate_salesforce_sandbox + salesforce_token → salesforce-sandbox
validate_salesforce_production + salesforce_token → salesforce-production
```

Actions name the destination explicitly, and production actions may have stricter
policy. Each hook gets only its own slot grant even when script content is
identical. Domain data should record external environment alongside external
IDs. Automatic project-based selection is intentionally not inferred.

## Logs and redaction

The runner performs best-effort exact-value replacement of injected plaintext
with `[REDACTED_SECRET]` before retaining stderr and records whether replacement
occurred. It never persists an environment block. Pack authors must not log,
transform-and-log, or otherwise disclose secrets; redaction is not a correctness
or security proof.

## Audit

Audit event types:

```text
secret.created
secret.rotated
secret.disabled
secret.rotated_and_enabled
hook_secret_grant.created
hook_secret_grant.carried_forward
hook_secret_grant.replaced
hook_secret_grant.revoked
hook_secret_resolution.failed
```

Successful hook execution evidence records hook revision, grant ID, secret ID,
`value_version`, slot, and environment name. Audit never records plaintext,
ciphertext, nonce, master-key material, or environment contents.

## API

```text
GET  /api/v1/secrets
POST /api/v1/secrets
POST /api/v1/secrets/{secret_id}/rotate
POST /api/v1/secrets/{secret_id}/disable

GET  /api/v1/hook-secret-grants
POST /api/v1/hook-secret-grants
POST /api/v1/hook-secret-grants/{grant_id}/replace
POST /api/v1/hook-secret-grants/{grant_id}/revoke
```

Create/rotate accepts plaintext only in the authenticated request body over the
normal protected server transport. Responses never echo it. Replace includes the
expected current grant ID and replacement secret ID. Grant creation includes the
explicit hook revision ID, expected security digest, slot, and secret ID to
prevent pack-upgrade races.

## CLI

```nu
optctl secret list
optctl secret create <name> --stdin
optctl secret rotate <name> --stdin
optctl secret disable <name>

optctl secret grants
optctl secret grant <secret> --hook <hook> --slot <slot>
optctl secret replace-grant <grant-id> --secret <secret>
optctl secret revoke-grant <grant-id>
```

Secret values are accepted through stdin or an interactive no-echo prompt, never
as positional arguments or ordinary flags. Noninteractive use without stdin
fails rather than prompting.

Before grant confirmation, CLI output displays secret name/status, hook identity,
revision/security/script digests, slot/env, phases, network hosts, reads, and
effects. It never displays the value.

## Listing DTOs

`secret list` exposes authorized non-plaintext metadata:

```text
id
name
description
status
value_version
created_at
updated_at
grant_count
```

`secret grants` exposes:

```text
grant_id
secret_id
secret_name
hook_identity
hook_revision_id
hook_security_digest
slot
env
status
created_at
inherited_from_grant_id
supersedes_grant_id
revoked/superseded reason
pending_pinned_outbox_count
```

Neither listing returns values, ciphertext, nonce, encryption key IDs/material,
or environment contents.
