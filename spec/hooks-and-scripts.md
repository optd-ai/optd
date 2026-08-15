<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-hooks-and-scripts; contract: 1; input: sha256:7ca5927f3387ff4282d56543dfc092cac0072124d9dd577f612ee85c89181e4d -->

# Hooks, Scripts, and Runtime Behavior

Generated exact-contract projection imported into project-model/model.json from the reviewed hooks-and-scripts.md source.

## Exact migrated contract

<a id="obj-com-exact-hooks-and-scripts-v1"></a>

### Exact v1 contract — Hooks, Scripts, and Runtime Behavior

**Migration provenance.** Exact normative contract imported from `spec/hooks-and-scripts.md` at `sha256:b371e08514baf02ac6628f871dcbe24ab57b0bdd97cc6f1b4c47661bb78458db`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Summary

The platform should behave like Kubernetes in spirit: defaults that work, plus
user-defined resources and user-defined behavior layered on top. Odoo-inspired
examples should be default configuration, not special code.

Executable prototype evidence lives in `prototypes/hooks/`. It runs real Deno
hook scripts as subprocesses, passes JSON envelopes on stdin, validates JSON
stdout output schemas, captures stderr logs, enforces timeouts, translates
permissions to Deno flags, and applies global permission policy.

Resources can define lifecycle hooks that execute scripts. Scripts make it
possible for an agent to build a headless CRM using only API/CLI configuration
plus executable behavior.

## Hook Language Direction

Decision: **Deno/TypeScript is the only hook runtime.**

Reasons:

- Built-in `fetch` for HTTP.
- Strong JSON ergonomics via `JSON.parse/stringify`.
- No compile step for single-file scripts.
- Script text can be executed by the platform through Deno.
- Explicit host/port network and named-environment permissions.
- Dates, entropy, and ordinary in-process computation without a compile step.
- Agents are generally strong at TypeScript/JavaScript.

Operational implications:

- The container/runtime ships Deno.
- Hook config does not specify a language/runtime.
- The platform may typecheck scripts during pack preview/apply.
- MVP scripts are single-file: static/dynamic, URL, JSR, and npm imports are
  rejected during pack preview/apply.
- Pack hooks never receive filesystem, subprocess, system-information, FFI,
  direct-database, or initiating-token capabilities.

## Runtime Selection

Decision: hooks are always executed by the platform hook runner using Deno.

Do not require shebangs in hook scripts. Do not require users to specify
`runtime`. A hook script is TypeScript/JavaScript text plus hook metadata. The
platform decides how to invoke Deno, applies permissions, passes stdin,
validates stdout, enforces timeout, and records audit metadata.

Recommended rule:

1. Hook scripts are treated as Deno/TypeScript by default.
2. `runtime` is not part of normal hook configuration.
3. Shebangs are optional comments for local developer convenience only; the
   platform does not rely on them.
4. The hook runner always controls Deno flags, permissions, env, stdin/stdout,
   timeout, working directory, and audit.

## Including Scripts in Packs

Every Hook uses exactly one paired metadata/script basename under `hooks/`:

```text
hooks/validate_lead.yaml
hooks/validate_lead.ts
```

The Hook YAML declares `metadata.name: validate_lead` and
`spec.script: validate_lead.ts`. Script values are basenames only: absolute
paths, parent traversal, nested paths, pack includes, inline scripts, and
script-only Hooks are rejected. Hook identity is the owning publisher/pack plus
`metadata.name`; persisted references are publisher-qualified and dotted aliases
are invalid.

During multipart pack preview/candidate-revision creation, the server must:

1. Pair each Hook YAML with the same-basename TypeScript part in `hooks/`.
2. Validate Hook metadata and Deno-compatible script text.
3. Hash script content.
4. Store the script content and digest with the applied config revision.
5. Record the digest in Hook execution audit records.

The editable paired files remain the source during development. The applied
config revision stored by the platform is the source for execution, audit, and
reproducibility.

## Pack Preview Upload, Storage, and Execution

### Upload Transport

Decision: pack source preview uses **HTTP multipart** as the canonical
transport; migration-plan apply uses JSON with no repeated source upload. Local
pack directories use the strict layout defined in
[Pack Structure](pack-structure.md).

MVP CLI accepts one local directory (`optctl pack apply ./packs/crm`), packages
its regular files, and submits the same multipart preview request any future
UI/client uses. Archive input is deferred to avoid a second extraction/security
contract. `optctl pack apply` then applies the returned exact migration ID
through the JSON migration route. This lets the server validate that every
referenced hook script/resource file is present before candidate revision
creation.

Multipart shape:

- One root `pack.yaml` part.
- Zero or more strict child-definition parts from every allowed directory in
  `pack-structure.md`.
- One paired Deno script part for every Hook YAML.
- Hook config references scripts by filename; directory is implied.

Inline/multiline script properties and script-only hooks are rejected, including
for tests. Tests construct the same paired pack input contract.

### Storage Model

Store validated candidate and applied packs as immutable config revisions:

- Pack metadata.
- All normalized strict child definition revisions.
- Script content as bounded text/bytea source records (not domain attachments).
- Script digest, size, path, and media type.
- UUIDv7 config revision ID.
- Activation timestamp and auth context.

The filesystem is an input/source format, not the runtime source of truth. Once
applied, hooks execute from the database-backed config revision. This makes
one-container deployments, backups, audit, and horizontal scale simpler.

A local cache directory may be used at runtime to materialize scripts for Deno
execution, but it is disposable and keyed by digest. If missing, it can be
recreated from the database.

### Execution Model

When a hook runs:

1. Resolve hook definition from active config revision.
2. Load script content by digest from the database or local digest cache.
3. Materialize script to a temporary/cache file if Deno requires a file path.
4. Compute Deno permission flags from hook config and global policy.
5. Execute Deno with JSON envelope on stdin.
6. Capture stdout as JSON result and stderr as logs.
7. Record hook execution metadata, script digest, permissions, duration, exit
   code, and result summary.

## Prototype Evidence

`prototypes/hooks/hook-runner.ts` validates these assumptions:

- Hooks do not need shebangs or runtime metadata.
- Hook input is exactly one JSON envelope on stdin.
- Hook stdout must be exactly one JSON object.
- Hook stderr is captured as logs and kept separate from structured output.
- `validation.v1`, `patch.v1`, and `changeset.operations.v1` outputs are
  distinguishable and schema-checked by the runner.
- Hook permissions can be expressed as metadata, translated to Deno flags, and
  globally constrained.
- If a hook tries to use a permission it was not granted, Deno fails closed and
  the runner captures the failure.
- If a hook requests a permission disabled by global policy, the runner rejects
  it before execution.
- Timeouts kill long-running hooks and return a structured error.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/hooks/hook-runner.test.ts
```

## Hook Types

Hooks are explicit and attach through their Hook document to resource/action
filters or committed event types. Scheduled hooks are not in MVP.

MVP attachment phases are:

- `action.stage`
- `changeset.before_stage`
- `changeset.validate`
- `event.after_commit`

There is no `action.commit` hook phase. Action staging expands operations once;
commit applies the immutable stage without rerunning hooks.

## Important Safety Boundary

Stage hooks are trusted pack application code. They may use dates, entropy,
declared secrets/environment, and declared network hosts for validation or data
acquisition. They must not intentionally create external side effects because a
staging attempt may fail, be repeated, or never commit. This is a pack-authoring
contract: network access cannot prove that a remote request is read-only.

Intentional effects such as sending messages, charging, reserving inventory, or
writing another CRM belong in `event.after_commit` hooks. After-commit failures
become delivery failures rather than transaction rollbacks.

A stage hook executes once per staging attempt. Successful output is normalized
into and persisted with the stage; commit never reruns it. Hook failure or
validation denial returns an error/result and creates no stage. Running the
stage command again is a new attempt, not a platform retry operation.

## Action vs Hook Boundary

- `Action` is the user/agent-facing business operation: `convert_lead`,
  `close_won`, `create_follow_up`, `merge_contacts`.
- `Hook` is executable implementation or lifecycle behavior: validate input,
  normalize data, generate changeset operations, send notification.

Actions define input schema, availability, declared reads/context, policy,
stage/commit semantics, documentation, and events. Hooks define code path or
stored script artifact, timeout, permissions, input schema, output schema, and
failure mode.

A complex action may be implemented by one or more hooks, but hooks are not
themselves the public business API.

Hooks do not decide when they run. They run only through their own explicit
`spec.attachments` in one of the four frozen phases. Actions are invocable
buttons; hooks are callbacks. Schedules are not an MVP attachment phase.

## Script input contract

Each attachment maps named input keys from the finite curated context vocabulary
or JSON constants. Operant validates reference availability/type at pack preview
and materializes the selected values at invocation; hooks cannot request opaque
raw context.

```yaml
kind: Hook
apiVersion: operant.dev/v1
metadata:
  name: require_primary_contact
spec:
  script: require_primary_contact.ts
  timeout: 2s
  permissions: { net: false, env: false, read: false, write: false, run: false }
  secrets: []
  effects: { operations: [] }
  output: { schema: validation.v1 }
  attachments:
    - phase: changeset.validate
      resource: opportunity
      order: 100
      input:
        opportunity: "$proposed"
        primary_contact: "$reads.primary_contact"
```

The owning action/resource definition must declare any `$reads.<name>` object
read. Missing optional reads omit that input key; empty string/list/object
values remain present values. Exact sources and phase availability are frozen in
`mvp-hook-schema.md`.

## Canonical Parameter Transport

Decision: use exactly one canonical parameter transport: **JSON envelope on
stdin**.

Do not pass hook inputs as CLI args. CLI args are awkward for nested data and
require escaping rules that are easy to get wrong.

Do not pass hook inputs through environment variables. Env vars are reserved for
true environment configuration and secret references/values.

Do not pass hook inputs through magic files. Pack hooks never receive runtime
filesystem access. Inputs must fit configured JSON guardrails; a future blob
reference contract is out of MVP and cannot be assumed.

Canonical execution contract:

- Platform executes hook process.
- Platform writes one JSON envelope to stdin.
- Hook reads all stdin and parses JSON.
- Hook writes one JSON result to stdout.
- Hook writes logs/debug output to stderr.
- Non-zero exit means hook execution failure.

The envelope contains exactly the version, phase, validated curated `input`, and
bounded non-secret invocation metadata frozen in `mvp-hook-schema.md`. When a
permitted phase explicitly maps `$actor`, `input` may contain that phase's
minimal server-derived actor DTO. The envelope never includes ambient actor
roles, raw auth context, initiating credentials, bearer/authorization tokens,
process information, secret references/values, or ambient environment. Secret
values exist only in exact granted child env names.

Deno example:

```ts
const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const { opportunity, primary_contact } = envelope.input;

if (!primary_contact) {
  console.log(JSON.stringify({
    allow: false,
    errors: [{
      path: "/primary_contact",
      code: "required",
      message: "Opportunity requires a primary contact",
    }],
    warnings: [],
    required_approvals: [],
  }));
} else {
  console.log(JSON.stringify({
    allow: true,
    errors: [],
    warnings: [],
    required_approvals: [],
  }));
}
```

Deno/TypeScript is the only supported hook runtime.

## Script Output Contract

Scripts return exactly the strict phase schema declared by the hook:

- `action.stage`: `changeset.operations.v1` with required `operations` and
  optional `warnings`/`errors`.
- `changeset.before_stage`: `patch.v1` with required `patches` and optional
  `warnings`.
- `changeset.validate`: `validation.v1` with required `allow`, `errors`,
  `warnings`, and `required_approvals`.
- `event.after_commit`: `delivery.v1` with one delivery outcome.

`validation.v1` errors/warnings use the standard `path`, `code`, `message`, and
optional `details` shape. `required_approvals` uses
[Changeset Approval Contract](changeset-approvals.md). If `allow` is false at
least one error is required; if errors are non-empty `allow` must be false.
Unknown fields are rejected. Custom event output is not a stage-hook schema in
v1: committed object/action events are derived by the engine from the canonical
graph/action identity. Explanations belong in bounded stderr or warning/error
messages, not an untyped `summary` property.

Exit codes:

- `0`: valid structured result.
- Non-zero: hook failure. For validation hooks, fail closed by default.

## Permissions, Sandboxing, and Operational Limits

Packs are trusted application extensions, while Deno permissions provide
capability disclosure, hygiene, and containment rather than proof of semantic
correctness.

Allowed declarations are:

- `net`: `false` or a host/port allowlist translated to Deno `--allow-net`.
- `env`: `false` or explicitly named non-secret names using the operator
  allowlist/reserved-prefix contract in [MVP Hook Schema](mvp-hook-schema.md).
- `secrets`: explicit secret-resource-to-environment mappings.

Unrestricted network permission is never emitted. Operators may further narrow
network/environment policy. Redirect destinations must independently satisfy
Deno's network permission check.

Filesystem read/write and subprocess execution are permanently forbidden for all
pack hooks. Subprocesses are forbidden because they would bypass filesystem
hygiene. Hooks also receive no system-information, FFI, direct database,
initiating bearer token, or remote-import permission. Internal materialization
of the applied entry script does not grant script filesystem access.

Runtime guardrails are operationally configurable rather than intentionally
small application limits. A hook may request a timeout subject to the server's
configurable default/maximum. Suggested defaults are 30 seconds and 10 minutes,
with configurable stdout/stderr byte limits (suggested 16 MiB/4 MiB). Stdout
overflow and timeout fail staging; stderr overflow truncates retained logs and
sets a marker. Container/server limits control concurrency and memory.

The platform does not automatically retry stage hooks. It audits each execution,
versions scripts, records script/input/output digests, and persists bounded
redacted stderr with a successful stage or failed-attempt audit record.

## CRM Workflow Examples

A headless CRM can be assembled from resource configuration plus scripts:

- Lead capture hook normalizes email/domain.
- Lead validation hook requires email or company website.
- Assignment hook routes lead by territory or round robin.
- Scoring hook computes lead score from firmographic fields.
- Transition hook prevents `qualified -> proposal` unless contact and company
  are linked.
- Approval hook requires manager approval for discounts over threshold.
- After-commit hook sends Slack/email notification or creates a task.
- Scheduled hook marks stale opportunities and creates follow-up tasks.

## Hook Authority and Preview

Users authorize semantic operations/actions, not hook implementation details. A
principal allowed to invoke `action.convert_lead` does not separately need raw
create permissions for every declared company/contact/opportunity effect of that
action. Hook/action attachments declare reviewed resource/action effects and
runtime capabilities. Pack preview/install validates those declarations.

For each invocation the platform creates a constrained internal capability bound
to hook revision/script digest, invocation and causation ids, affected project
boundary, declared API/resource/action effects, and short invocation lifetime.
System executors authorize mechanics only and never imply super-admin. An
undeclared effect fails closed.

Changeset/action staging executes synchronous hooks once, expands all effects,
and checks runtime restrictions, API scope, secret grants/availability, and
declared effects. Dates, entropy, and network responses are allowed because the
normalized output is persisted in the immutable stage. Commit compares and
applies that graph and cannot add unseen effects or rerun hooks.

After-commit work pins code/config/effect scope at enqueue, stores only minimal
references/routing data, and injects secrets only in worker memory. One polling
loop inside the main server process claims Postgres rows; no separate worker
container is required. Each attempt checks pinned revision/grants and current
global runtime restrictions but does not re-evaluate initiating roles.
`delivery.v1` classifies success, retry, and permanent dead-letter. MVP delivery
is at-least-once and unordered; the stable delivery UUID is the provider
idempotency key. Cancellation is explicit and only possible before claim.
Delivery status remains separate from changeset commit success. See
[Durable Outbox Delivery](outbox-delivery.md).

## Hook Data Access and Secrets

Hooks receive curated ephemeral context in their stdin envelope and must not
connect directly to the database. Stage hooks cannot call Operant's own HTTP API
or receive the initiating human/agent bearer token; Operant objects are supplied
through current/proposed context and declared object-by-id reads whose immutable
versions become stage dependencies. Arbitrary collection queries are deferred.

The immutable stage contains the canonical operations being staged, not a second
raw request payload or a generic bag of external API responses supplied only for
validation. A hook may write explanatory external-validation details to stderr.
Any external value that affects a write must be present in the canonical
operation graph.

Secrets use a built-in platform resource type, not normal pack resources. Hook
configs reference secrets by name and map them to explicit environment variable
names:

Relevant Hook `spec` fragment:

```yaml
spec:
  secrets:
    - slot: clearbit_api_key
      env: CLEARBIT_API_KEY
  permissions:
    net:
      - api.clearbit.com:443
    env: false
    read: false
    write: false
    run: false
```

Runner requirements:

- Resolve every required slot through one effective revision-specific
  hook-secret grant before execution.
- Fail closed if a grant or secret is missing, revoked, disabled, superseded, or
  undecryptable.
- Inject only declared env vars.
- Use narrow Deno env permissions such as `--allow-env=CLEARBIT_API_KEY`.
- Record grant/secret/value-version IDs and slot/env names, never values.
- Follow the normative [Hook-Secret Grants](hook-secret-grants.md) contract.

## MVP Contract Reference

Exact phases, declared object reads, ordering/chaining, permission fields, logs,
failure behavior, runtime guardrails, and output schemas are normative in
[MVP Hook Schema](mvp-hook-schema.md).
