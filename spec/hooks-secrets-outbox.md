<!-- generated-by: pi-dag-workflow/project-model; view: view-hooks-secrets-outbox; contract: 1; input: sha256:2afe48beea1bf4ca2b70feb7bf0bf6c9a9d9181d16dfa634c98456a7a28ec287 -->

# Hooks, secrets, and outbox

Canonical hooks, secrets, and outbox decisions and contracts projected from project-model/model.json.

## Concepts

<a id="obj-con-hook"></a>

### Capability-bounded hook

A single-file Deno/TypeScript program run through a trusted wrapper with curated input and declared capabilities, producing strict output and logs.

<a id="obj-con-secret-grant"></a>

### Secret and hook grant

A global AES-256-GCM encrypted secret value is injected only through an exact hook-revision/slot grant; initiating credentials are never exposed.

<a id="obj-con-outbox-delivery"></a>

### Pinned outbox delivery

An at-least-once unordered delivery pins event, hook, attachment, secret grant, and idempotency context; attempts and retry generations are durable.

## Scenarios

<a id="obj-scn-hook-denied"></a>

### Fail a hook that attempts forbidden capability

A pack hook tries filesystem, subprocess, import, DB, self-API, undeclared environment/network, or initiating bearer access. The trusted runtime executes it. Capability access fails, bounded evidence/logs are retained, child/cache state is cleaned, and no stage or side effect is accepted.

**Context.** A pack hook tries filesystem, subprocess, import, DB, self-API, undeclared environment/network, or initiating bearer access.

**Action.** The trusted runtime executes it.

**Expected outcome.** Capability access fails, bounded evidence/logs are retained, child/cache state is cleaned, and no stage or side effect is accepted.

<a id="obj-scn-outbox-recreate"></a>

### Recover delivery across container recreation

Deliveries are pending, retry_wait, or leased/running when optd is recreated. Only the optd container is recreated while PostgreSQL persists. Pending/retry work resumes; running work is not reclaimed before lease expiry; stable idempotency and attempt evidence are preserved.

**Context.** Deliveries are pending, retry_wait, or leased/running when optd is recreated.

**Action.** Only the optd container is recreated while PostgreSQL persists.

**Expected outcome.** Pending/retry work resumes; running work is not reclaimed before lease expiry; stable idempotency and attempt evidence are preserved.

## Decisions

<a id="obj-dec-hook-boundary"></a>

### Run curated capability-bounded Deno hooks

Hooks receive only mapped input and declared network/environment/secrets. They have no filesystem, subprocess, import, database, self-API, initiating bearer, FFI, or ambient-system access.

<a id="obj-dec-global-secrets"></a>

### Keep encrypted secrets global with exact revision-slot grants

Secrets are global resources encrypted with AES-256-GCM fresh nonce and row/version AAD; exact hook revision/slot grants govern injection and pinned outbox work.

<a id="obj-dec-at-least-once-outbox"></a>

### Use durable at-least-once unordered delivery

Commit atomically enqueues pinned delivery. Fixed leases, append-only attempts, retry_wait, dead-letter, cancel, and manual retry generations support recovery; provider effects are not claimed exactly once.

<a id="obj-dec-hook-actor-dto"></a>

### Expose only phase-specific curated actor DTOs to Hooks

A Hook receives $actor only when its phase permits the reference and its input mapping explicitly requests it. action.stage receives id and principal_type; event.after_commit receives id, non-null human_user_id, and auth_context_id; changeset.before_stage and changeset.validate receive no actor. No Hook actor DTO contains roles, credentials, tokens, ambient authority, or caller-provided identity.

**Rationale.** This preserves required actor attribution while minimizing disclosed identity and keeping authorization exclusively server-side.

<a id="obj-dec-hook-source-pairing"></a>

### Use strict paired Hook YAML and TypeScript basenames

Each Hook is authored as hooks/<name>.yaml plus hooks/<name>.ts with matching metadata name and basename script reference. Paths, traversal, includes, inline scripts, nested script paths, and script-only Hooks are rejected.

**Rationale.** This is the single strict source format already enforced by pack ingestion.

<a id="obj-dec-outbox-attempt-counters"></a>

### Separate outbox attempts from manual retry generations

Claim increments attempts_in_generation and total_attempts, never retry_generation. Only authorized manual retry increments retry_generation, resets attempts_in_generation, and preserves total_attempts plus append-only history.

**Rationale.** This matches repository fencing and avoids conflating delivery attempts with operator retry epochs.

## Commitments

<a id="obj-com-hook-timeouts"></a>

### Use bounded per-hook timeout contracts

Hook declarations carry an explicit duration. Platform default is 30 seconds and maximum is 10 minutes; proof-pack hooks deliberately retain 2-second declarations. Timeout terminates execution and creates no stage.

<a id="obj-com-secret-readiness"></a>

### Fail closed on secret-key mismatch

The master key is a 32-byte base64 environment secret. Missing or fingerprint-mismatched key with encrypted rows fails startup/readiness; plaintext and initiating credentials never enter durable hook evidence.

<a id="obj-com-outbox-recovery"></a>

### Recover pending, running, and retry-wait delivery across restart

Outbox state is authoritative in PostgreSQL. Lease expiry and generation fencing recover work; retries reuse stable idempotency identity; container recreation proves pending/running/retry_wait behavior.
