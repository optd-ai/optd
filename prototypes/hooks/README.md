# Deno Hook Runner Prototype

This prototype validates the hook execution contract with real Deno subprocesses
behind a small Deno HTTP server.

It proves:

- Hooks are Deno/TypeScript scripts with no shebang or runtime metadata
  required.
- The platform runner passes one JSON envelope on stdin.
- Hooks write exactly one JSON object to stdout.
- Hook logs go to stderr and are captured separately.
- Output schemas are validated by the runner:
  - `validation.v1`
  - `patch.v1`
  - `changeset.operations.v1`
- Hook permissions are explicit and translated into Deno flags.
- Global permission policy can reject a hook before execution.
- Deno permission failures are captured as hook failures.
- Declared secret refs are injected as narrowly scoped environment variables.
- Missing secret refs fail closed before executing the hook.
- Timeouts kill long-running hooks.
- Stable JSON error envelopes are returned by the HTTP runner.

## Run server

```bash
deno run --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/hooks/hook-runner.ts
```

Server defaults to `http://127.0.0.1:8788`.

## Test

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/hooks/hook-runner.test.ts
```

## Endpoints

- `GET /health`
- `GET /hooks`
- `POST /hooks/:name/run`

## Example request

```json
{
  "phase": "before_preview",
  "input": {
    "operation": {
      "op": "create",
      "resource": "lead",
      "fields": {
        "name": "Ada",
        "email": " ADA@EXAMPLE.COM "
      }
    }
  }
}
```

## Prototype hooks

- `normalize_lead`: returns `patch.v1` patches.
- `validate_lead`: returns `validation.v1` errors/warnings.
- `convert_lead`: returns `changeset.operations.v1` operations.
- `bad_json`: validates invalid stdout handling.
- `permission_env_denied`: validates Deno permission failure capture.
- `permission_env_blocked_by_policy`: validates global policy denial before
  execution.
- `use_secret`: validates declared secret env injection.
- `missing_secret`: validates missing secret fail-closed behavior.
- `timeout`: validates timeout handling.
