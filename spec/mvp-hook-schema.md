# MVP Hook Schema v0

Hooks are Deno/TypeScript scripts executed by the platform runner. They receive
curated context on stdin and write exactly one JSON object to stdout. Logs go to
stderr.

## Hook document

```yaml
kind: Hook
apiVersion: operant.dev/v1
metadata:
  name: validate_lead
spec:
  script: validate_lead.ts
  timeout: 2s
  permissions:
    net: false
    read: false
    write: false
    env: false
    run: false
  secrets: []
  output:
    schema: validation.v1
  attachments:
    - phase: changeset.before_preview
      resource: default.lead
      order: 100
      condition: "active()"
      input:
        operation: "$operation"
        actor: "$actor"
```

## Attachment phases

```text
changeset.before_preview
changeset.validate
action.preview
action.commit
event.after_commit
```

Initial mapping:

- Normalization hooks use `changeset.before_preview` and output `patch.v1`.
- Validation hooks use `changeset.validate` and output `validation.v1`.
- Action hooks use `action.preview` or `action.commit` and output
  `changeset.operations.v1`.
- After-commit hooks use `event.after_commit` and are executed through outbox.

## Attachment fields

- `phase`: required.
- `resource`: optional dotted resource filter.
- `action`: optional dotted action filter.
- `event`: optional event type filter.
- `order`: optional integer; lower runs first, default `1000`.
- `condition`: optional SQL-lowerable expression evaluated against available
  context.
- `input`: mapping from hook input keys to curated context references/constants.

## Input mapping v0

Supported context references:

```text
$actor
$operation
$current
$proposed
$action.input
$event
$object_version
```

Constants are allowed as JSON scalars/objects/arrays. Arbitrary path expressions
are intentionally deferred. Add them only after real hooks need them.

## Secret refs

```yaml
spec:
  secrets:
    - name: clearbit_api_key
      env: CLEARBIT_API_KEY
```

Rules:

- Secrets are built-in platform resources, not pack resources.
- Missing/unauthorized secret refs fail closed before script execution.
- Only declared env vars are injected.
- Runner grants narrow env permission, e.g. `--allow-env=CLEARBIT_API_KEY`.
- Secret values are never written to audit logs.

## Hook envelope

```json
{
  "hook": "validate_lead",
  "phase": "changeset.validate",
  "input": {},
  "metadata": {
    "pack_revision": "default.crm@0.1.0:abc",
    "script_digest": "fnv1a32:...",
    "attachment_id": "..."
  }
}
```

## Output schemas

MVP output schemas:

- `validation.v1`
- `patch.v1`
- `changeset.operations.v1`

The runner validates output shape before returning success.

## API access

Hooks may call platform HTTP APIs if granted `net` permission and given an API
token/context by the platform. Hooks must not receive database credentials or
connect directly to the database.
