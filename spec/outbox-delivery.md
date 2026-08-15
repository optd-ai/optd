<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-outbox-delivery; contract: 1; input: sha256:c18fc1d675001dae4022bcbb2f2408b65b1fd409e085789a1f28556069aeeee7 -->

# Durable Outbox Delivery

Generated exact-contract projection imported into project-model/model.json from the reviewed outbox-delivery.md source.

## Exact migrated contract

<a id="obj-com-exact-outbox-delivery-v1"></a>

### Exact v1 contract — Durable Outbox Delivery

**Migration provenance.** Exact normative contract imported from `spec/outbox-delivery.md` at `sha256:37566cb3182a77dd82ec69c54d040b96568e5754693af48a79504cc76db16124`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Purpose and guarantee

Intentional external effects run only after the domain transaction commits. That
transaction atomically inserts immutable events and durable outbox delivery
rows. The main Operant server then runs one asynchronous polling loop in the
same process/container to claim and execute after-commit hooks.

The MVP guarantee is **durable at-least-once delivery attempts**, not
exactly-once external effects. A hook may complete an external request and the
server may crash before recording success. Recovery repeats the attempt. Operant
supplies a stable idempotency key, but exactly-once provider behavior requires
the pack hook to pass that key to an external API that honors it.

There is no Redis, Kafka, daemon, separate worker container, or LISTEN/NOTIFY
correctness dependency. Future server replicas or Kubernetes worker containers
may use the same Postgres claim protocol without changing delivery identity.

Executable real-Postgres evidence is in `prototypes/outbox-delivery/`.

## Atomic enqueue

Commit selects active `event.after_commit` attachments and inserts one delivery
for each `(event_id, hook_attachment_identity)` in the same transaction as:

- domain rows and object versions;
- commit record;
- audit records;
- committed events.

A unique database constraint on `(event_id, hook_attachment_identity)` prevents
duplicate enqueue if commit result recovery repeats internal logic. If commit
rolls back, no event or delivery exists.

The delivery pins:

- event ID and immutable object-version references;
- logical hook and attachment identities;
- exact hook/pack revision;
- script and hook-security digests;
- output/envelope schema versions;
- declared capability/effect scope;
- hook-secret grant IDs/slots selected at enqueue;
- minimal immutable routing/input references.

It contains no secret plaintext, unrestricted bearer token, database credential,
full mutable object snapshot, local process evidence, or actor role authority.
New events use the active hook revision; queued work never redirects to a newer
revision.

## Identities

Every delivery and attempt has a server-generated UUIDv7.

```text
delivery_id  stable for the complete delivery lifetime
attempt_id   unique to one claimed execution
```

`delivery_id` is also the external idempotency key. It remains unchanged across:

- transient retries;
- expired-lease recovery;
- manual retry generations;
- server restart;
- pack upgrade.

The hook envelope includes:

```json
{
  "metadata": {
    "delivery": {
      "delivery_id": "019b...",
      "idempotency_key": "019b...",
      "attempt_id": "019c...",
      "retry_generation": 0,
      "attempt_number": 1,
      "total_attempt_number": 1
    }
  }
}
```

Pack authors must pass `idempotency_key` to providers that support idempotency.
Operant cannot enforce provider behavior.

## Delivery and attempt records

`outbox_deliveries` is the mutable aggregate state and pinned execution
contract:

```text
id                         UUIDv7 primary key
(event_id,attachment_id)   unique
hook_identity
hook_revision_id
script_digest
security_digest
attachment_id
envelope_schema
envelope_json
pinned_grant_ids
status
retry_generation
attempts_in_generation
total_attempts
max_attempts
available_at
lease_owner
lease_attempt_id
lease_expires_at
last_error_code
last_error_message          redacted
created_at
updated_at
```

`outbox_attempts` is append-only execution history:

```text
id                         UUIDv7 primary key
delivery_id
retry_generation
attempt_number
total_attempt_number
worker_instance_id
hook_revision_id
grant IDs / secret value-version evidence
idempotency_key
started_at
lease_expires_at
completed_at
outcome
error_code
error_message               redacted
external_id                 optional non-secret provider reference
hook_execution_id
unique(delivery_id,retry_generation,attempt_number)
```

Hook executions retain script logs, duration, digests, and exact secret/grant
evidence; attempts reference them instead of duplicating those records. Audit
records administrative retry/cancel/disable actions. Events remain the canonical
committed facts.

## States

```text
pending
running
retry_wait
succeeded
dead_letter
cancelled
```

Transitions:

```text
pending     → running       claim and fixed lease
running     → succeeded     acknowledged delivery.v1 success
running     → retry_wait    retryable failure below max attempts
running     → dead_letter   permanent failure or generation exhausted
running     → pending       expired lease reclaimed
retry_wait  → pending       available_at reached
pending     → cancelled     administrative cancellation before claim
retry_wait  → cancelled     administrative cancellation before claim
dead_letter → pending       manual retry starts a new generation
```

Terminal rows are `succeeded`, `dead_letter`, and `cancelled`, except that an
authorized manual retry may reopen `dead_letter` as a new generation.

## No delivery ordering guarantee

MVP provides no ordering guarantee between deliveries, even when they reference
the same object, project, event type, or hook. Independent rows may execute and
complete in any order.

This avoids head-of-line blocking and hidden coordination before real pack usage
demonstrates a concrete need. Events and envelopes include immutable object
version/event identities so integrations can reject, reconcile, or tolerate
reordering. A future explicit ordering/partition contract may be added without
changing delivery identity.

## In-process polling loop

The main Operant server starts one asynchronous delivery loop after database
readiness. It polls Postgres on a short configurable interval (suggested default
one second), drains ready rows, and sleeps when idle. Server shutdown stops
claiming new work and allows a bounded graceful period for the current hook.

Correctness uses polling only. `LISTEN/NOTIFY` may be added later as a latency
hint but is not in MVP. `optctl outbox drain` remains an audited administrative
and testing trigger that invokes the same claim/process path; it is not a
separate production deployment mode.

A worker instance ID is an opaque server-start identity for lease diagnosis. It
contains no PID/hostname/user process evidence requirement and grants no
authority.

## Claim and fixed lease

A short transaction:

1. marks expired running attempts `lease_expired` and returns their deliveries
   to `pending`;
2. selects ready `pending`/`retry_wait` rows ordered by `available_at,id` using
   `FOR UPDATE SKIP LOCKED`;
3. increments `attempts_in_generation` and `total_attempts` without changing
   `retry_generation`; only an authorized manual retry starts a new generation;
4. inserts an append-only `running` attempt;
5. writes `lease_owner`, `lease_attempt_id`, and `lease_expires_at`;
6. commits before any hook or network call.

The fixed lease duration is the pinned hook execution timeout plus a
configurable server margin (suggested 30 seconds). There is no heartbeat in MVP.
The runner must kill a timed-out hook before its normal lease expires.
Server/process crash leaves the row running until expiry, then polling creates a
new attempt with the same delivery/idempotency key.

Completing an attempt updates the delivery only when its `attempt_id` still owns
the active lease. A late result after expiry is retained as `late_succeeded` or
`late_failed` evidence but cannot overwrite a newer attempt's aggregate state.
Duplicate external execution remains possible and is why the stable key exists.

## Pinned execution and secrets

Each attempt loads exact immutable hook source/config by pinned revision and
verifies script/security digests. It never resolves the currently active hook by
name.

Before execution it checks:

- pinned revision exists and is executable for queued work;
- pinned script/security/attachment digests match;
- current global runtime policy permits pinned capabilities;
- every pinned hook-secret grant remains effective;
- every required secret is active and decryptable.

Pack upgrade does not revoke old revision grants. Old queued work executes old
code while using the stable secret identity's current `value_version` at that
attempt. Explicit old-revision disablement or grant revocation prevents future
attempts. Initiating user roles are not re-evaluated; immutable auth context
preserves provenance while the system outbox executor supplies only the pinned
implementation capability.

## `delivery.v1` hook output

An `event.after_commit` hook writes exactly one JSON object to stdout.

Success:

```json
{
  "outcome": "succeeded",
  "summary": "Customer synchronized.",
  "external_id": "provider-reference"
}
```

Retryable:

```json
{
  "outcome": "retry",
  "code": "provider_unavailable",
  "message": "Salesforce returned 503.",
  "retry_after": "30s"
}
```

Permanent:

```json
{
  "outcome": "dead_letter",
  "code": "invalid_destination",
  "message": "Configured destination no longer exists."
}
```

`summary`, `message`, and `external_id` are bounded, redacted operational
metadata and must not contain secrets. `retry_after` is an optional positive
duration. The server honors it subject to a configurable deployment safety
maximum; otherwise it computes backoff.

Unknown/invalid output is a permanent pinned-code failure. Process timeout,
unexpected nonzero exit, or ambiguous runner interruption is retryable because
an external effect may already have occurred.

## Retry policy

Defaults:

```text
max attempts per generation: 10
initial backoff ceiling:      5 seconds
multiplier:                   2
maximum backoff ceiling:      1 hour
jitter:                       full jitter [0, ceiling)
```

All are operator-configurable. A hook's valid `retry_after` overrides computed
backoff for that attempt. Claim increments the attempt before execution. A
retryable result at the generation maximum becomes `dead_letter`.

Automatic retry is appropriate for transient/ambiguous outcomes such as:

- hook timeout or process interruption;
- provider/network failure classified by hook as retryable;
- temporary platform runner failure;
- structured `outcome: retry`.

Immediate dead-letter without consuming repeated automatic attempts:

- missing pinned hook/code;
- explicit pinned revision disablement;
- script/security/attachment digest mismatch;
- missing, revoked, superseded, or mismatched hook-secret grant;
- disabled/undecryptable required secret;
- current global policy forbids the pinned capability;
- invalid `delivery.v1` output/schema;
- structured `outcome: dead_letter`.

These failures may be repaired and manually retried.

## Manual retry generations

Authorized manual retry applies only to `dead_letter`. It locks the delivery
and:

- increments `retry_generation`;
- resets only `attempts_in_generation`;
- preserves `total_attempts` and every append-only attempt;
- preserves `delivery_id` and provider idempotency key;
- clears aggregate last-error/lease fields;
- sets `pending` and `available_at=now()`;
- writes audit evidence with actor/auth context and optional reason.

It does not clone a new delivery or erase failure history.

## Cancellation

Cancellation is allowed only while `pending` or `retry_wait`. Cancellation and
claim lock the same delivery row, so exactly one wins:

```text
cancel lock first → cancelled; no hook starts
claim lock first  → cancel returns delivery_in_progress
```

Running external work cannot be recalled. MVP has no `cancel_requested` state or
pretended remote cancellation. Succeeded/dead-letter/cancelled outcomes return
their current terminal state. Cancellation does not alter the committed event.

## Retention

MVP retains all delivery, attempt, hook-execution, and dead-letter operational
rows. No automatic cleanup or retention job is required initially. This keeps
implementation and audit behavior simple while real volume is measured.

A future retention policy may remove old succeeded/cancelled operational detail
while preserving immutable event/audit provenance. It must never silently remove
unresolved dead letters.

## Authority and audit

System policy actions:

```text
outbox.inspect
outbox.retry
outbox.cancel
outbox.drain
```

Normal semantic action permission does not grant these administrative controls.
`system:super_admin` remains the explicit policy bypass. Retry, cancellation,
manual drain, pinned-revision disablement, and dead-letter state changes are
audited with auth context; automatic claims/retries are represented by attempts
and hook executions rather than noisy per-poll audit events.

Error/log text is bounded and secret-redacted. Ordinary project users do not
receive secret/grant internals or escalation coaching.

## API

```text
GET  /api/v1/outbox
GET  /api/v1/outbox/{delivery_id}
GET  /api/v1/outbox/{delivery_id}/attempts
POST /api/v1/outbox/{delivery_id}/retry
POST /api/v1/outbox/{delivery_id}/cancel
POST /api/v1/outbox/drain
```

List supports status, hook, event, and time filters plus cursor pagination.
Inspect returns pinned identities, aggregate state, safe last error, attempts
summary, event/object-version references, and contextual help. Attempts returns
append-only safe execution metadata.

## CLI

```nu
optctl outbox list --status dead_letter
optctl outbox inspect <delivery-id>
optctl outbox attempts <delivery-id>
optctl outbox retry <delivery-id> --reason 'credential repaired'
optctl outbox cancel <delivery-id> --reason 'destination retired'
optctl outbox drain --limit 25
```

TOON is default and `--json` is supported. Retry/cancel show the resulting
complete delivery representation. `delivery_in_progress` explains that an
already-running external effect cannot be recalled but does not suggest roles or
escalation commands.

## Stable errors

```text
delivery_not_found
delivery_in_progress
delivery_not_retryable
delivery_not_cancellable
pinned_hook_missing
pinned_hook_disabled
pinned_hook_digest_mismatch
hook_secret_grant_unavailable
hook_secret_unavailable
capability_unavailable
delivery_output_invalid
delivery_retry_exhausted
```

## Prototype evidence

`prototypes/outbox-delivery/outbox_delivery.ts` and its real-Postgres test
prove:

- concurrent `SKIP LOCKED` claims execute one row once at a time;
- fixed-lease crash recovery and append-only attempts;
- duplicate attempts use one stable key against a real HTTP provider, which
  applies one effect;
- structured success/retry/dead-letter outcomes and retry-after;
- immediate permanent configuration failure;
- cancellation/claim race;
- manual retry generation/history;
- pinned old revision plus current secret value version;
- in-process polling without NOTIFY;
- deliberately unordered completion.

Run:

```bash
nix-shell --run 'deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/outbox-delivery/outbox_delivery.test.ts'
```

Verified with PostgreSQL 18.4:

```text
1 passed | 0 failed
```
