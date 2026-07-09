# Pre-MVP Open Questions and Proposals

These items must be resolved before detailed MVP implementation planning.

## 1. App-managed Postgres decision

### Decision

Production deployment is container-only: Docker Compose or Kubernetes. The
production container bundles a Postgres binary, and app-managed Postgres is the
default when an external database URL is not provided.

Support two database modes:

1. **External Postgres** when `OPERANT_DATABASE_URL` is set.
2. **App-managed local Postgres** by default when `OPERANT_DATABASE_URL` is not
   set.

The default should be app-managed Postgres on localhost or a local Unix socket.
The app starts Postgres, waits until it is ready, then connects through the same
raw-SQL adapter used for external Postgres.

For development and integration tests, use a `direnv` + `shell.nix` pattern so
Deno, Postgres binaries, and related tooling are available as raw processes
without relying on a production container.

### Environment

```text
OPERANT_DATABASE_URL=postgres://...      # if set, use external Postgres and do not manage process
OPERANT_DATA_DIR=~/.local/share/operant  # default data root
OPERANT_PG_PORT=0                        # 0 means choose free port; explicit port allowed
OPERANT_PG_HOST=127.0.0.1                # localhost default when TCP is used
OPERANT_PG_BIN_DIR=...                   # optional override for postgres/initdb binaries
OPERANT_PG_LOG_LEVEL=warn
```

### Data layout

```text
$OPERANT_DATA_DIR/
  postgres/
    data/            # PGDATA
    run/             # socket/lock/pid files
    logs/
      postgres.log
    metadata.json    # managed version, port/socket, init status
  cache/
    hooks/           # materialized scripts by digest
  backups/
```

### Startup sequence

1. If `OPERANT_DATABASE_URL` is set, connect to it and run app migrations.
2. Otherwise locate bundled or configured Postgres binaries.
3. If `$OPERANT_DATA_DIR/postgres/data` is absent, run `initdb`.
4. Choose socket/port.
5. Start Postgres as a child process owned by the app.
6. Wait for readiness with bounded timeout.
7. Create database/user/schema if needed.
8. Run platform migrations.
9. Start Hono HTTP server.

### Shutdown

- On normal app shutdown, stop the managed Postgres child cleanly.
- If the app crashes, next boot detects stale pid/lock and recovers.
- External Postgres is never stopped by the app.

### Tests

MVP tests should use the same app-managed Postgres mode:

- Each test file or suite gets a fresh temporary `OPERANT_DATA_DIR`.
- Start app-managed Postgres through the same lifecycle code as production-local
  mode.
- Use unique ports or Unix sockets.
- Tear down child process and temp directory after tests.

This is slower than PGlite but validates the real deployment path. Focused unit
tests can mock ports, but integration tests should use managed Postgres.

### Open operational details

- Exact container packaging layout for the bundled Postgres binary.
- Whether Unix socket should be preferred over TCP where available.
- Backup command design.
- Safe local Postgres binary upgrades inside container-managed deployments.

## 2. Changeset JSON v0 decision

Freeze the v0 wire shape around the current prototype, with explicit versioning.

### Preview request

```json
{
  "apiVersion": "operant.dev/v1",
  "actor": { "id": "user_123", "roles": ["sales_rep"] },
  "idempotencyKey": "optional-preview-key",
  "reason": "why this change is being proposed",
  "operations": [
    {
      "op": "create",
      "resource": "default.lead",
      "as": "lead",
      "fields": { "name": "Ada", "email": "ada@example.com" }
    }
  ]
}
```

### Commit request

Commit can either commit a persisted preview by id or submit operations
directly:

```json
{
  "apiVersion": "operant.dev/v1",
  "actor": { "id": "user_123", "roles": ["sales_rep"] },
  "idempotencyKey": "required-for-agent-retries",
  "previewId": "csp_123"
}
```

or:

```json
{
  "apiVersion": "operant.dev/v1",
  "actor": { "id": "user_123", "roles": ["sales_rep"] },
  "idempotencyKey": "agent-run-abc-1",
  "reason": "captured inbound lead",
  "operations": []
}
```

Direct commit still performs preview/validation internally and commits only if
valid.

### Operations

#### create

```json
{
  "op": "create",
  "resource": "default.lead",
  "id": "optional-client-id",
  "as": "lead",
  "fields": {}
}
```

#### update

```json
{
  "op": "update",
  "resource": "default.lead",
  "id": "lead_123",
  "expectedVersion": 3,
  "fields": {}
}
```

#### archive

```json
{
  "op": "archive",
  "resource": "default.lead",
  "id": "lead_123",
  "expectedVersion": 3
}
```

#### transition

```json
{
  "op": "transition",
  "resource": "default.opportunity",
  "id": "opp_123",
  "expectedVersion": 5,
  "to": "won",
  "fields": { "close_date": "2026-07-09T00:00:00Z" }
}
```

#### link

```json
{
  "op": "link",
  "relationship": "default.contact_company",
  "from": "@contact",
  "to": "@company",
  "as": "contact_company",
  "fields": { "role": "buyer", "primary": true }
}
```

#### unlink

```json
{
  "op": "unlink",
  "relationship": "default.contact_company",
  "id": "rel_123",
  "expectedVersion": 1
}
```

#### comment

```json
{
  "op": "comment",
  "resource": "default.lead",
  "id": "lead_123",
  "body": "Called customer; requested quote."
}
```

### References and aliases

- `as` creates an alias for later operations in the same changeset.
- Alias references use `@alias` string values.
- Aliases can be used in relationship `from`/`to` and field values.
- Resource identifiers may be dotted (`default.lead`) in API/CLI; server
  normalizes to namespace/resource.

### Response shape

```json
{
  "ok": true,
  "previewId": "csp_123",
  "changesetId": "cs_123",
  "status": "previewed|committed|validation_failed",
  "operations": [],
  "diffs": [],
  "validation": { "errors": [], "warnings": [] },
  "policy": { "decision": "allowed", "checks": [] },
  "hooks": [],
  "eventsPreview": [],
  "outboxPreview": [],
  "help": []
}
```

Errors use the stable envelope:

```json
{
  "ok": false,
  "error": { "code": "bad_request", "message": "...", "details": {} }
}
```

## 3. Expression/CEL SQL lowering proposal

### External library scan and spike finding

Found JS/TS CEL evaluator libraries:

- `@bufbuild/cel` — ECMAScript CEL evaluator.
- `@marcbachmann/cel-js` — lightweight CEL implementation.
- `cel-js` — CEL evaluator.
- `@protoutil/cel` — CEL implementation inspired by cel-go.

These primarily evaluate CEL; they do **not** appear to provide a ready-made
safe CEL-to-Postgres-SQL lowerer for our restricted subset.

Executable spike: `prototypes/expression/` validates that `@bufbuild/cel`
exposes a protobuf-shaped AST that can support conservative SQL lowering without
writing our own parser. The spike covers typed field contexts, actor parameter
binding, `self.field` aliases, null semantics, list membership,
`has`/`present`/`missing`, archive helpers, malicious literal parameterization,
expression complexity limits, unknown-field rejection, unsupported-function
rejection, and type-mismatch rejection.

### Recommendation

Use `@bufbuild/cel` for parsing/AST if the package remains compatible in Deno.
Implement our own tiny SQL lowerer for the supported subset.

Reasons:

- SQL lowering must be conservative and field-schema-aware.
- We need parameterized SQL, identifier safety, unsupported-function rejection,
  and context-specific allowed fields/functions.
- Policy/query/index/hook-condition contexts need different function allowlists.
- Falling back to runtime evaluation for queries/policies is not acceptable.

### MVP subset

Start with:

- field identifiers: `status`, `owner_id`, `company_id`
- literals: string, number, boolean, null
- comparisons: `==`, `!=`, `<`, `<=`, `>`, `>=`
- boolean operators: `&&`, `||`, `!`
- presence helpers: `present(field)`, `missing(field)`
- archive helpers: `active()`, `archived()`
- membership: `field in ["a", "b"]`

Reject everything else with stable validation errors.

### Decision direction

Prefer `@bufbuild/cel` for AST parsing and own the SQL lowerer. Keep the parser
behind an expression adapter so we can replace it if package compatibility or
CEL semantics become a problem.

## 4. Policy config status

The focused policy prototype currently proves an **internal model** with
generated scenarios. It validates SQL pushdown/runtime parity for RBAC, ABAC,
and one-level ReBAC, but it is not yet a full user-authored pack policy format.

The CRM default pack has a simple `policies/sales_access.yaml` fixture, and the
pack/vertical-slice prototypes store policy metadata. The vertical slice does
not enforce it yet.

### MVP policy config proposal

Use structured YAML, not arbitrary Rego/OPA and not free-form SQL.

```yaml
kind: Policy
apiVersion: operant.dev/v1
metadata:
  name: sales_access
spec:
  rules:
    - name: admin_all
      effect: allow
      roles: [admin]
      actions: ["*"]
      resources: ["*"]

    - name: sales_rep_own_leads
      effect: allow
      roles: [sales_rep]
      actions: [read, create, update, action]
      resources: [default.lead]
      where: "owner_id == actor.id || sales_team_id in actor.sales_team_ids"

    - name: company_member_read
      effect: allow
      roles: [sales_rep]
      actions: [read]
      resources: [default.opportunity]
      relation:
        relationship: default.opportunity_company
        objectSide: from
        subjectResource: default.company
        subjectIdsFromActor: company_ids
```

Rules are lowered to SQL for query/list and evaluated at runtime for individual
operations. Deep ReBAC remains rejected.

## 5. Hook context, API access, and secrets decision

Hooks receive curated context only. They must not connect directly to the
database.

Allowed:

- Read the JSON envelope from stdin.
- Use API calls with explicit hook permissions if they need more data.
- Receive explicitly referenced secrets as environment variables.
- Return versioned JSON output on stdout.
- Log to stderr.

Not allowed:

- Direct database credentials.
- Direct database connections.
- Hidden filesystem state beyond explicitly granted artifact/cache paths.
- Broad environment access just because a hook needs one secret.

This keeps hooks within the same authorization/audit/API boundaries as any other
client.

### Built-in secret resource proposal

Add a built-in platform resource type for secrets. Secrets are not pack
resources and should not be exposed through normal resource query APIs.

Conceptual fields:

- `id`
- `name`
- `description`
- `value_ciphertext` or external secret reference
- `created_at`, `updated_at`
- `created_by`, `updated_by`
- optional `scope`/`namespace`

Hook config references secrets by name and maps each secret to an environment
variable:

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

Runner behavior:

1. Resolve declared secret refs before execution.
2. If a ref is missing or not authorized, fail closed before spawning Deno.
3. Inject only the declared env vars.
4. Use narrow Deno env permission, e.g. `--allow-env=CLEARBIT_API_KEY`.
5. Record secret names/env names in hook execution audit metadata, but never
   values.

Executable prototype: `prototypes/hooks/` now includes `use_secret` and
`missing_secret` hook cases proving narrow env injection and fail-closed
missing-secret behavior.

## 6. Migration integration requirement

MVP must integrate the full migration lifecycle. This includes all focused
prototype behavior plus server/CLI integration.

Required integration points:

- Pack apply invokes migration preview when an active revision exists.
- `optctl pack preview` displays migration plan summary.
- `optctl migration inspect` shows issues, blockers, live facts, SQL, and
  cleanup guidance.
- Safe additive changes can apply.
- Risky/destructive changes require explicit reviewed/staged/confirmed flows.
- Cleanup/backfill flows through ordinary changesets.
- Migration operations write audit/events.

## 7. Outbox reasonable MVP proposal

Keep outbox durable but simple.

### Table fields

- `id`
- `event_id`
- `hook_name`
- `hook_revision`
- `script_digest`
- `envelope_json`
- `status`: `pending | running | succeeded | failed | dead_letter`
- `attempts`
- `available_at`
- `locked_by`
- `locked_at`
- `last_error`
- timestamps

### Worker behavior

- Workers claim rows with `for update skip locked`.
- Claim only `pending`/retryable rows with `available_at <= now()`.
- Set `running`, `locked_by`, `locked_at`, increment attempts.
- On success, write `hook_executions`, mark `succeeded`.
- On failure, write `hook_executions`, set `pending` with exponential-ish
  backoff until max attempts.
- After max attempts, set `dead_letter`.

### Ordering

Do not guarantee global ordering in MVP.

Provide a practical per-object best effort:

- Events include `resource`, `object_id`, and `object_version_id`.
- Worker can process independent rows concurrently.
- If strict per-object ordering becomes necessary, add an object-key
  claim/advisory-lock later.

### Idempotency

- Outbox rows are unique per `(event_id, hook_name)`.
- Hook executions are append-only.
- Hooks should be written idempotently for external side effects where possible.
- Platform retries may re-run a hook after failure.

### CLI

- `optctl outbox status`
- `optctl outbox drain --limit N`
- `optctl outbox retry <id>`
- `optctl outbox dead-letter list`

## 8. Metadata prototype requirement

Metadata route shape is frozen to Proposal A in
[MVP API Routes](mvp-api-routes.md).

Required HTTP routes:

- `GET /metadata/home`
- `GET /metadata/packs`
- `GET /metadata/packs/{namespace}/{name}`
- `GET /metadata/resources/{namespace}/{resource}`
- `GET /metadata/actions/{namespace}/{action}`
- `GET /metadata/hooks/{namespace}/{hook}`
- `GET /metadata/policies/{namespace}/{policy}`

Required CLI commands:

- `optctl home`
- `optctl metadata resource default.lead`
- `optctl metadata action default.convert_lead`

`optctl` keeps dotted identifiers and translates them to API path segments. The
vertical-slice and optctl prototypes have been aligned to this route shape.
Metadata output should use CRM/default-pack `axi` guidance for agent-friendly
help.

## 9. TOON input/output decision

- `optctl` output is TOON by default.
- HTTP input and output remain JSON.
- CLI structured input is JSON only (`--input '{...}'`, `--file payload.json`).
- Do not accept TOON as command input in MVP.
- Provide `--json` for machine/debug output.

## 10. Planning readiness

These questions are now resolved enough to start detailed MVP implementation
planning. Remaining work belongs in the MVP plan rather than additional
pre-planning debate:

1. implement app-managed Postgres lifecycle against real Postgres binaries,
2. implement frozen changeset JSON v0,
3. integrate expression SQL lowering,
4. implement Proposal A metadata routes and `optctl` translation,
5. integrate migration, policy, hook, secret, outbox, and TypeBox/Ajv subsystems
   into the main server.
