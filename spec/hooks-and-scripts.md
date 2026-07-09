# Hooks, Scripts, and Runtime Behavior

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
- Built-in subprocess API via `Deno.Command`.
- Explicit permissions for filesystem, network, environment, and subprocess
  access.
- Agents are generally strong at TypeScript/JavaScript.

Operational implications:

- The container/runtime ships Deno.
- Hook config does not specify a language/runtime.
- The platform may typecheck scripts during pack preview/apply.
- Dependency imports require an explicit policy for reproducibility and
  supply-chain safety.

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

Behavior scripts should live inside the pack directory and be referenced by
relative path from hook definitions or pack includes.

Example layout:

```text
packs/crm/
  pack.yaml
  resources/lead.yaml
  actions/convert-lead.yaml
  hooks/validate-lead.ts
  hooks/normalize-email.nu
  hooks/convert-lead.ts
  seeds/pipeline-stages.yaml
```

Hooks should use explicit metadata namespaces for identity, while dotted names
are accepted as ergonomic references:

```yaml
metadata:
  namespace: crm
  name: validate_lead
```

```yaml
ref: crm.validate_lead
```

Internally, dotted refs parse to structured `(namespace, name)` identity.

At apply time, the platform should:

1. Resolve script paths relative to the pack root when applying from a local
   directory/archive.
2. Validate hook metadata and Deno-compatible script text.
3. Hash script content.
4. Store the script content and digest with the applied config revision.
5. Record the digest in hook execution audit records.

The editable pack file remains the source during development. The applied config
revision stored by the platform is the source for execution, audit, and
reproducibility.

## Pack Upload, Storage, and Execution

### Upload Transport

Decision: pack upload/apply uses **HTTP multipart** as the canonical transport.
Local pack directories use the strict layout defined in
[Pack Structure](pack-structure.md).

The CLI may accept a local directory or archive for developer ergonomics:

- `optctl pack apply ./packs/crm`
- `optctl pack apply crm.tar.gz`

But the CLI should package those files and submit the same multipart API request
that UI/agent clients use. This lets the server validate that every referenced
hook script/resource file is present in the upload.

Multipart shape:

- One root `pack.yaml` part.
- Zero or more resource/action/hook/seed config file parts from expected
  directories.
- Zero or more Deno script file parts from `hooks/`.
- Hook config references scripts by file name, not relative path. The directory
  is implied by pack structure.

Avoid making multiline script strings inside a large JSON payload the primary
upload format. Multiline JSON strings are awkward to edit, diff, escape, and
review. Inline scripts may be allowed for tiny tests/examples, but file uploads
or local files should be the normal path.

### Storage Model

Store applied packs in the database as immutable config revisions:

- Pack metadata.
- Normalized resource/action/hook/seed definitions.
- Script content as text/blob records.
- Script digest, size, path, and media type.
- Config revision id.
- Apply timestamp and actor.

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

Hooks should be explicit and attached to resource definitions, actions,
transitions, events, or schedules.

Candidate hooks:

- `before_validate`
- `validate`
- `before_preview`
- `after_preview`
- `before_commit`
- `after_commit`
- `on_transition`
- `on_approval_requested`
- `on_approved`
- `on_rejected`
- `on_event`
- `scheduled`

## Important Safety Boundary

Hooks that run before commit participate in correctness decisions. Hooks that
run after commit are side effects.

Recommended split:

- **Validation hooks:** deterministic, bounded, no durable side effects, return
  structured allow/deny/warnings/derived changes.
- **Commit hooks:** should not mutate data outside the transaction unless
  expressed as changeset operations.
- **After-commit hooks:** may call external systems, enqueue notifications, run
  enrichment, etc.; failures become retryable events, not transaction rollbacks.

## Action vs Hook Boundary

- `Action` is the user/agent-facing business operation: `convert_lead`,
  `close_won`, `create_follow_up`, `merge_contacts`.
- `Hook` is executable implementation or lifecycle behavior: validate input,
  normalize data, generate changeset operations, send notification.

Actions define input schema, availability, reads/context, policy, preview/commit
semantics, documentation, and events. Hooks define code path or stored script
artifact, timeout, permissions, input schema, output schema, and failure mode.

A complex action may be implemented by one or more hooks, but hooks are not
themselves the public business API.

Hooks do not decide when they run. They run because they are attached to a
resource operation, lifecycle transition, action phase, event, or schedule. The
attachment point maps available context into the hook's declared input schema.
Actions are invocable “buttons”; hooks are callbacks.

## Script Input Contract

Hooks should define their own input contract. The script is the implementation,
but the `Hook` config should declare the schema the platform validates before
execution.

The attachment point does not invent arbitrary inputs. It wires available
context into the hook's declared inputs.

Recommended model:

1. Hook declares named inputs and their schema.
2. Attachment point maps action input, current object, proposed object, related
   records, transition info, or constants into those hook inputs.
3. Platform validates the mapped hook input.
4. Platform executes the script with a standard envelope containing the
   validated hook input plus invocation metadata.

Example hook declaration:

```yaml
kind: Hook
metadata:
  namespace: crm
  name: require_primary_contact
spec:
  path: hooks/require-primary-contact.ts
  input:
    schema:
      opportunity:
        type: object
        resource: opportunity
        required: true
      primary_contact:
        type: object
        resource: contact
        # Optional because required is omitted.
        # If unavailable, the key is absent from input.
  output:
    schema: hook.validation.v1
```

Missing optional values are omitted from hook input. Empty strings remain real
present values and can be validated independently.

Example lifecycle attachment wiring:

```yaml
hooks:
  before:
    - ref: crm.require_primary_contact
      with:
        opportunity: current
        primary_contact: related.primary_contact
```

Example action attachment wiring:

```yaml
validate:
  hooks:
    - ref: crm.require_primary_contact
      with:
        opportunity: reads.opportunity
        primary_contact: reads.primary_contact
```

## Canonical Parameter Transport

Decision: use exactly one canonical parameter transport: **JSON envelope on
stdin**.

Do not pass hook inputs as CLI args. CLI args are awkward for nested data and
require escaping rules that are easy to get wrong.

Do not pass hook inputs through environment variables. Env vars are reserved for
true environment configuration and secret references/values.

Do not pass hook inputs through magic files by default. Files can be used for
large blobs/artifacts referenced from the JSON envelope, but they are not the
canonical parameter transport.

Canonical execution contract:

- Platform executes hook process.
- Platform writes one JSON envelope to stdin.
- Hook reads all stdin and parses JSON.
- Hook writes one JSON result to stdout.
- Hook writes logs/debug output to stderr.
- Non-zero exit means hook execution failure.

The envelope should include:

- Hook identity and phase.
- Invocation metadata.
- Actor identity.
- Validated hook `input` object.
- Optional raw context for debugging only if allowed.
- Secret references or explicitly injected secret env var names, not accidental
  ambient secrets.
- Artifact/file references only for large payloads, if needed.

Deno example:

```ts
const envelope = JSON.parse(await new Response(Deno.stdin.readable).text());
const { opportunity, primary_contact } = envelope.input;

if (!primary_contact) {
  console.log(JSON.stringify({
    allow: false,
    errors: [{ message: "Opportunity requires a primary contact" }],
  }));
} else {
  console.log(JSON.stringify({ allow: true }));
}
```

Deno/TypeScript is the only supported hook runtime.

## Script Output Contract

Scripts should return structured JSON:

- `allow: true|false`
- `errors: []`
- `warnings: []`
- `patches: []` for derived changes, if allowed
- `required_approvals: []`
- `events: []`
- `summary` / explanation

Exit codes:

- `0`: valid structured result.
- Non-zero: hook failure. For validation hooks, fail closed by default.

## Permissions, Sandboxing, and Operational Limits

Because arbitrary code is powerful, hooks need guardrails. Deno permissions
should be explicit at the hook level and constrained by global policy.

Hook-level permissions can include:

- `net`: allowed hosts or disabled.
- `read`: allowed paths or disabled.
- `write`: allowed paths or disabled.
- `env`: allowed environment variables or disabled.
- `run`: allowed subprocess commands or disabled.

Global policy can further restrict what hooks are allowed to request. For
example, an installation may globally disable network access or subprocess
execution regardless of hook config.

Other guardrails:

- Timeout.
- Memory/process limits where possible.
- Working directory isolation.
- Minimal explicit environment variables.
- Secret injection by reference and permission.
- Audit every script execution.
- Version scripts and record script digest in changeset/audit logs.

The platform hook runner should translate hook permission config into Deno flags
and reject hooks that request permissions denied by global policy.

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

## Hook Data Access and Secrets

Hooks receive curated context in their stdin envelope. They must not connect
directly to the database. If a hook needs more data, it may call platform HTTP
APIs like any other client, subject to explicit network permissions, policy, and
audit.

Secrets use a built-in platform resource type, not normal pack resources. Hook
configs reference secrets by name and map them to explicit environment variable
names:

```yaml
kind: Hook
metadata:
  name: enrich_lead
spec:
  script: enrich_lead.ts
  secrets:
    - name: clearbit_api_key
      env: CLEARBIT_API_KEY
  permissions:
    net: true
```

Runner requirements:

- Resolve secret refs before execution.
- Fail closed if a secret is missing or unauthorized.
- Inject only declared env vars.
- Use narrow Deno env permissions such as `--allow-env=CLEARBIT_API_KEY`.
- Record secret names/env names in audit metadata, never values.

## Open Questions

- How are hook dependencies packaged?
- Should the runtime cache materialize scripts as files or use Deno APIs that
  can execute source another way?
- What multipart upload shape is most ergonomic for agents and clients?
