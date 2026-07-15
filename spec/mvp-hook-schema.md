# MVP Hook Schema v1

Hooks are trusted pack-provided Deno/TypeScript scripts executed by the platform
runner. They receive curated context as one JSON envelope on stdin, write exactly
one JSON object to stdout, and write human/agent-readable logs to stderr.

A pack author may use declared network access for stage-time validation and data
acquisition. Stage hooks must not intentionally create external side effects:
staging may fail, be repeated, or never commit. Intentional external effects
belong in `event.after_commit` hooks.

## Hook document

```yaml
kind: Hook
apiVersion: operant.dev/v1
metadata:
  name: validate_lead
spec:
  script: validate_lead.ts
  timeout: 45s
  permissions:
    net:
      - api.example-crm.com:443
    env:
      - CRM_API_BASE_URL
    read: false
    write: false
    run: false
  secrets:
    - slot: example_crm_api_key
      env: EXAMPLE_CRM_API_KEY
  effects:
    operations: []
  output:
    schema: validation.v1
  attachments:
    - phase: changeset.validate
      resource: operant/crm:lead
      order: 100
      condition: "active()"
      input:
        operation: "$operation"
        current: "$current"
        proposed: "$proposed"
```

`effects.operations` is a sorted unique array of:

```yaml
- resource: operant/crm:lead
  ops: [create, update]
```

`ops` is a non-empty unique subset of the seven frozen operation kinds. Local
resource identities are qualified at preview. Hooks that emit no operations use
`[]`; after-commit network effects are bounded by declared host/port and do not
claim Operant operation/API capability.

## Attachment phases

```text
changeset.before_stage
action.stage
changeset.validate
event.after_commit
```

Mapping:

- Normalization hooks use `changeset.before_stage` and output `patch.v1`.
- Action expansion hooks use `action.stage` and output
  `changeset.operations.v1`.
- Validation hooks use `changeset.validate` and output `validation.v1`.
- After-commit hooks use `event.after_commit`, output `delivery.v1`, and execute
  through the durable outbox.
- There is no `action.commit` hook phase. Commit applies the persisted immutable
  stage and never reruns stage hooks.

## Stage pipeline and ordering

One staging attempt executes phases in this order:

1. Run `action.stage` attachments, when the intent invokes an action.
2. Normalize every resulting direct/action-generated operation with
   `changeset.before_stage` attachments.
3. Freeze the normalized operation graph.
4. Run `changeset.validate` attachments against that graph.
5. Persist the immutable stage only if execution, validation, policy, schema,
   capability, and dependency checks succeed.

Within one phase, attachments run sequentially by:

1. `order` ascending, default `1000`;
2. canonical publisher-qualified hook identity ascending;
3. immutable attachment id ascending.

Normalization hooks chain: each accepted patch updates `$proposed` before the
next matching normalization attachment and its condition are evaluated.
Validation hooks all observe the same frozen normalized graph. All matching
validation hooks run so their warnings/errors can be accumulated unless a hook
execution itself fails.

Multiple `action.stage` hooks receive the same action input and declared reads;
they do not implicitly consume operations emitted by earlier action hooks. The
engine appends outputs in attachment order. Duplicate operation aliases or
otherwise conflicting generated operation identities fail staging.

A hook process failure, invalid output, timeout, schema/policy denial, or
validation denial returns a structured error/result and creates no stage.
Approval-required stages are valid stages and may be persisted awaiting
approval.

## Attachment fields

- `phase`: required.
- `resource`: optional publisher-qualified resource filter.
- `action`: optional publisher-qualified action filter.
- `event`: optional event type filter.
- `order`: optional integer; lower runs first, default `1000`.
- `condition`: optional SQL-lowerable expression evaluated against the phase's
  current context.
- `input`: mapping from hook input keys to curated context references/constants.

## Input mapping v0

Supported context references:

```text
$actor
$operation
$current
$proposed
$action.input
$reads.<name>
$event
$object_version
```

The hook envelope has invocation input; the immutable stage does not retain a
second raw request/input payload or a generic external-response payload. It
stores the canonical operations being staged plus required dependency,
execution, policy, warning, approval, and log metadata. A network response is
stored only when a hook deliberately includes a value in a staged operation or
writes explanatory text to stderr.

Constants are allowed as JSON scalars/objects/arrays. No caller may append an
opaque hook-validation context to a staging request.

## Declared Operant reads

Resource operation hooks automatically receive the current operation,
`$current`, and `$proposed` when applicable. Action definitions may declare
object reads needed by their stage hooks:

```yaml
spec:
  reads:
    lead:
      resource: operant/crm:lead
      idFrom: $action.input.lead_id
      fields: [id, status, company_id]
      required: true
    company:
      resource: operant/crm:company
      idFrom: $current.company_id
      fields: [id, name]
      required: false
```

MVP rules:

- Reads resolve one object by an explicit id obtained from action input or the
  current/proposed object context.
- Arbitrary collection queries and reads derived from another declared read are
  deferred.
- Only declared fields enter `$reads.<name>`; absent optional objects omit that
  key.
- Each resolved object records its immutable `object_version_id` as a stage
  dependency.
- Commit requires that version to remain current; otherwise it returns
  `stage_stale` and never reruns hooks.
- The semantic action's reviewed internal capability authorizes declared reads;
  the initiating user does not receive general read authority from a hook.
- Stage hooks cannot call Operant's own HTTP API, receive the initiating bearer
  token, or connect directly to Postgres. This prevents recursive writes and
  bypasses of changeset/policy invariants.

## Permissions

Deno provides native host/port network allowlists. `permissions.net` is either
`false` or a non-empty list translated to `--allow-net=host[:port],...`:

```yaml
permissions:
  net:
    - api.bankofcanada.ca:443
    - api.example-crm.com:443
```

Every network connection, including a redirect destination, must satisfy the
Deno permission check. Unrestricted `--allow-net` is not emitted for pack hooks.
Operators may narrow all pack networking with `OPERANT_HOOK_NET_ALLOW`, a
comma-separated exact host[:port] ceiling with no wildcards. When unset, declared
endpoints are eligible; when set (including empty), every declared endpoint must
be included or invocation fails `hook_capability_denied`.

Environment access is explicit-only:

- `permissions.env` is `false` or a sorted unique list of uppercase non-secret
  names matching `[A-Z][A-Z0-9_]{0,127}`.
- Operator configuration `OPERANT_HOOK_ENV_ALLOW` is a comma-separated exact
  allowlist; absent/empty allows no non-secret names. At invocation, only names
  declared by the hook, present in this allowlist, and present in the server
  process environment are copied into the
  child environment.
- Names beginning `OPERANT_`, `DENO_`, `LD_`, or `DYLD_` are reserved and cannot
  be declared/allowed. Values have a configurable size guardrail. Confidential
  values must use required secret slots/grants instead.
- A declared name that is not operator-allowed/present fails stage with
  `hook_env_unavailable`. Pack preview validates syntax/reserved names but does
  not require a deployment value.
- `spec.secrets` declares secret slots and their injected env names.
- The runner passes only approved declared env names plus resolved secret-slot
  names and grants narrow `--allow-env` access to their union. Pack hooks never
  inherit the server environment.

Filesystem and subprocess capabilities are permanently unavailable to every
pack hook:

```text
read: false
write: false
run: false
```

Pack apply rejects any other value. `run` is forbidden because a child process
would bypass filesystem hygiene. Pack hooks also receive no `--allow-sys`,
`--allow-ffi`, remote-import, database, or initiating-token capability.

The runner may internally materialize applied script content in a digest-keyed
cache. Loading the entry script does not grant that script filesystem access.

## Scripts and imports

MVP hook scripts are single-file TypeScript/JavaScript. Static imports, dynamic
imports, URL imports, JSR imports, and npm imports are rejected during pack
preview/apply. Pack-local module graphs are deferred.

## Secrets

```yaml
spec:
  secrets:
    - slot: clearbit_api_key
      env: CLEARBIT_API_KEY
```

Rules:

- Secrets are global built-in system resources, not pack or project resources.
- Every declared slot is required; optional secret slots are not supported.
- A separate hook-secret grant maps one pinned hook revision slot to one concrete
  global secret.
- Missing/revoked grants or unavailable secrets fail before execution.
- Initiating users need semantic operation/action permission, not permission to
  read hook secret values.
- Secret values exist only in runner memory/environment for the invocation.
- Slot/env, grant, secret, and value-version IDs may be audited; values never
  are.
- Logging a secret is a pack-author contract violation. The runner performs
  best-effort exact-value redaction before retaining stderr, but redaction is
  not a substitute for correct hook behavior.
- The complete normative lifecycle is
  [Hook-Secret Grants](hook-secret-grants.md).

## Hook envelope

```json
{
  "hook": "operant/crm:validate_lead",
  "phase": "changeset.validate",
  "input": {},
  "metadata": {
    "pack_revision": "operant/crm@0.1.0:abc",
    "script_digest": "sha256:...",
    "attachment_id": "..."
  }
}
```

## Output and logs

MVP stdout schemas are:

- `validation.v1`
- `patch.v1`
- `changeset.operations.v1`
- `delivery.v1`

`validation.v1` has exactly these required fields:

```json
{
  "allow": true,
  "errors": [],
  "warnings": [],
  "required_approvals": []
}
```

Messages use `path`, `code`, `message`, and optional `details`. `allow: false`
requires an error; any error requires `allow: false`. Approval entries use
[Changeset Approval Contract](changeset-approvals.md). Unknown fields are
rejected.

`patch.v1` is the `add`/`remove`/`replace`/`test` subset of RFC 6902 applied to
proposed pack-defined data. `changeset.operations.v1`, UUIDv7 ID generation,
structured references, merge rules, and graph hashing are normative in
[Changeset Operation Schemas](changeset-operation-schema.md). `delivery.v1`
success/retry/dead-letter outcomes, stable idempotency metadata, and retry
classification are normative in [Durable Outbox Delivery](outbox-delivery.md).

Stdout must contain exactly one JSON object and is schema-checked. Stderr is
arbitrary UTF-8 hook log text; there is no structured `external_checks` output.
Authors may log where external validation data came from, while every value
that affects a write must be represented in canonical staged operations.

For a successful stage, each invocation's redacted stderr, script/input/output
digests, duration, and truncation marker are retained in that stage aggregate
and returned by both stage and inspect. For a failed attempt, bounded redacted
logs are returned with the error and retained with the failed-attempt audit
record; no stage is created.

The **current global hook runtime policy** means these permanent denials plus the
current operator net/env ceilings and configured resource guardrail maxima. It
is platform/deployment policy, not initiating-user role policy. Stage invocation
and outbox delivery both fail closed when a pinned declaration exceeds it;
outbox follows its permanent-failure classification.

## Runtime guardrails

Guardrails protect operator health rather than impose a performance-oriented
application model:

- `spec.timeout` is optional and may request a positive duration.
- The server has configurable default and maximum hook durations. Suggested
  deployment defaults are 30 seconds and 10 minutes; operators may raise them.
- Stdout and retained stderr byte limits are configurable. Suggested defaults
  are 16 MiB stdout and 4 MiB stderr per invocation.
- Stdout overflow fails staging. Stderr overflow truncates retained logs and sets
  `logs_truncated: true`; it does not fail otherwise successful logic.
- Timeout kills the process, returns `hook_timeout`, and creates no stage.
- Concurrency and memory are controlled by server/container operational limits,
  not pack-portability rules.
- The platform never automatically retries a stage hook.

Running the stage command again after failure is a new staging attempt. Once a
stage exists, its hooks never run again. Retrying commit for the same stage uses
the persisted graph and the database's unique successful-commit constraint.
Stage creation itself has no idempotency requirement.

## Declared effects and invocation capability

Hooks that produce operations declare their maximum reviewed effects as sorted
unique `{resource, ops[]}` entries under `effects.operations`. Undeclared
resource/operation pairs fail staging. Users authorize the semantic action plus
its reviewed effect manifest; the invocation-bound runner capability is internal
and cannot call Operant's API. Pack hooks permanently receive no initiating token
or self-API capability. Exact operation names/schemas are defined in
[Changeset Operation Schemas](changeset-operation-schema.md).
