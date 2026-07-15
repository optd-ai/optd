# Authentication API and CLI Contract

## Conventions

All auth HTTP routes use `/api/v1/auth`. Responses use
[API Response and Error Contract](api-errors.md), including
`meta.request_id`:

```json
{ "ok": true, "data": {}, "meta": { "request_id": "019b..." } }
```

```json
{
  "ok": false,
  "error": { "code": "stable_code", "message": "...", "details": {} },
  "meta": { "request_id": "019b..." }
}
```

Authentication headers:

```http
Authorization: Bearer <token>
Authorization: Operant-Bootstrap <token>
Authorization: Operant-Recovery <token>
```

Passwords/tokens never appear in URL parameters or ordinary CLI arguments.

## Boundary DTO

Exactly one variant:

```json
{ "type": "project", "project_id": "019b7a2e-7c10-7000-8000-000000000001" }
```

```json
{ "type": "all_projects" }
```

```json
{ "type": "system" }
```

Role assignment:

```json
{
  "role": "operant/crm:sales_manager",
  "boundary": { "type": "project", "project_id": "019b7a2e-7c10-7000-8000-000000000001" }
}
```

## Routes

### Operational/bootstrap/login

```text
GET  /live
GET  /ready
GET  /api/v1/auth/bootstrap/status
POST /api/v1/auth/bootstrap
POST /api/v1/auth/login
GET  /api/v1/auth/password-policy
POST /api/v1/auth/password/change

POST /api/v1/auth/password-reset/requests
GET  /api/v1/auth/password-reset/requests/:request_id
POST /api/v1/auth/password-reset/requests/:request_id/decision
POST /api/v1/auth/password-reset/requests/:request_id/cancel
POST /api/v1/auth/password-reset/requests/:request_id/watch-ticket
GET  /api/v1/auth/password-reset/requests/:request_id/watch?ticket=<short-lived-ticket>
POST /api/v1/auth/password-reset/requests/:request_id/redeem
POST /api/v1/auth/password-reset/requests/:request_id/complete
```

Bootstrap response returns the first human session and authorization-request
credential once. `optctl` stores both and automatically creates/activates the
normalized server context.

Login accepts username/password and optional `existing_request_session_id`. If
that active request credential belongs to the user, response marks it retained;
otherwise login issues an additional request credential without revoking ones
active agents may use. Password policy/hashing/throttling follow the normative
contract in [Authentication](authentication.md).

Password-reset creation returns the same non-enumerating public shape for
existing/unknown usernames plus an unguessable request id. There is deliberately
no pending-reset list route. A super-admin must receive/provide the exact id to
inspect/decide. Approval plus requester nonce redemption yields a single-use
reset capability; completion sets the new password, revokes old authority, and
issues replacement sessions. Reset wait uses the same indefinite WebSocket
contract as agent auth requests.

### Current identity/sessions

```text
GET  /api/v1/auth/me
GET  /api/v1/auth/sessions
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
```

Logout revokes the current bearer session. Logout-all requires password
reauthentication and confirmation.

### Roles

```text
GET /api/v1/auth/roles?boundary_type=project&project_id=019b...&verbose=false
```

Response follows the authored-guidance/computed-capability contract in
[Authentication](authentication.md).

### Authorization requests

```text
POST /api/v1/auth/requests
GET  /api/v1/auth/requests/:request_id
POST /api/v1/auth/requests/:request_id/decision
POST /api/v1/auth/requests/:request_id/cancel
POST /api/v1/auth/requests/:request_id/watch-ticket
GET  /api/v1/auth/requests/:request_id/watch?ticket=<short-lived-ticket>
POST /api/v1/auth/requests/:request_id/redeem
```

Creation requires `Idempotency-Key` plus a request or agent bearer credential:

```json
{
  "roles": ["operant/crm:sales_manager", "operant/crm:sales_rep"],
  "boundary": { "type": "project", "project_id": "019b7a2e-7c10-7000-8000-000000000001" },
  "reason": "Need to qualify CRM leads",
  "redemption_nonce_hash": "...",
  "agent": {
    "name": "crm-lead-agent",
    "harness": "pi",
    "external_session_id": "optional",
    "provider": "anthropic",
    "model": "claude-sonnet-4",
    "reasoning_effort": "high"
  }
}
```

Roles are normalized/deduplicated/sorted. Agent fields are typed, optional,
unverified context; arbitrary environment/settings objects are rejected.

Decision uses one endpoint:

```json
{
  "decision": "approved",
  "agent_name": "crm-lead-agent",
  "capability_summary_digest": "..."
}
```

```json
{ "decision": "denied", "reason": "Requested authority is not appropriate." }
```

Same-decision retries are idempotent. Conflicting decisions return
`request_already_decided`. Denial is final and contains no suggested roles or
follow-up commands. The requester may cancel its own pending request;
cancellation is terminal and audited.

### Indefinite WebSocket wait

`optctl auth wait <request-id>` does not poll and has no timeout option/default.
It first exchanges its request credential for a random, single-use, read-only
watch ticket:

```text
POST /api/v1/auth/requests/:id/watch-ticket
```

The ticket expires after 60 seconds if unused and grants access only to that
request's status stream. It is safe to place in the WebSocket URL because it is
short-lived, single-use, non-redeeming, and carries no general bearer authority.

`optctl` connects:

```text
wss://<origin>/api/v1/auth/requests/:id/watch?ticket=<ticket>
```

Loopback insecure development uses `ws://`. The server sends the current state
immediately and then versioned state changes:

```json
{
  "type": "auth_request_status",
  "request_id": "019b7a2e-7c10-7000-8000-000000000102",
  "version": 4,
  "status": "pending"
}
```

Terminal status includes approved/denied/cancelled/invalidated and safe details.
On approval, `auth wait` redeems and installs the replacement token. On denial
it prints the human reason, exits nonzero, and suggests nothing. Ctrl-C closes
the socket and exits 130 while leaving the request pending.

There is no application-level wait timeout. WebSocket ping/pong detects broken
connections. On transient disconnect, `optctl` obtains a new watch ticket and
reconnects to the same request with capped backoff; it never creates a new auth
request. State versions make reconnect/resume idempotent.

Approval/cancellation transactions emit Postgres `LISTEN/NOTIFY` hints so any
app node holding a WebSocket can wake and reread authoritative request state.
Missed notifications do not lose state because initial/reconnect always reads
Postgres. Postgres remains the only coordination dependency.

### Redemption

```json
{ "redemption_nonce": "..." }
```

Approval never sends a bearer token to the approver. Redemption returns the
agent's complete replacement authorization plus one token. If delivery is lost,
retry with the same nonce revokes the previously issued unconfirmed session and
mints a replacement auth session/token under the same authorization ID and
lineage. The prior unconfirmed session is terminally revoked; authorization
identity/assignments never duplicate. The local binding atomically replaces its
old token.

### Authorizations

```text
GET  /api/v1/auth/authorizations
POST /api/v1/auth/authorizations/:authorization_id/revoke
```

Self-revocation needs no password. Revoking another authorization requires
password reauthentication plus confirmation.

### Recovery

Host-only initiation/cancellation:

```text
operant auth recovery begin
operant auth recovery cancel
```

Public completion:

```text
POST /api/v1/auth/recovery/complete
```

Completion uses `Operant-Recovery` authorization and the targeted workflow in
[Authentication](authentication.md).

### Human users and role assignments

```text
GET    /api/v1/auth/users
POST   /api/v1/auth/users
GET    /api/v1/auth/users/:user_id
PATCH  /api/v1/auth/users/:user_id
GET    /api/v1/auth/users/:user_id/role-assignments
POST   /api/v1/auth/users/:user_id/role-assignments
DELETE /api/v1/auth/users/:user_id/role-assignments/:assignment_id
```

`optctl auth user create --username <name>` prompts admin for the initial
password. Domain role assignment is separate. `DELETE` deactivates assignment
lifecycle while retaining immutable/audit evidence; it does not physically
delete. Last-active-human-super-admin invariants apply.

## Route authorization mapping

Login/bootstrap/watch-ticket redemption use their explicit credential contracts.
Authenticated self operations (`me`, own sessions/logout/password change, own
pending request/cancel/redeem) use ownership plus structural checks without a
pack role.

Administrative/decision routes use exact system actions:

```text
auth.request.decide
auth.user.manage
auth.password_reset.decide
auth.authorization.inspect
auth.authorization.revoke
role.assignment.manage
```

Password-reset decision and any mutation of `system:super_admin` additionally
require an active super-admin; policy cannot bypass final-human and target
workflow invariants. Human role assignment also requires current possession of
the target role as frozen in `authorization-assignments.md`. Listing/revoking
agent authorizations is limited to the current human anchor unless system policy
explicitly permits broader administration. Every route remains audited.

## Stable HTTP errors

HTTP classification/envelope follows [API Response and Error Contract](api-errors.md).
Auth validation uses 400 only for malformed transport and 422 for well-formed
contract/domain validation. Expired one-time recovery/redemption resources use
410; throttling uses 429 and hash/dependency saturation uses 503.

Stable codes include:

```text
authentication_required
credential_invalid
session_revoked
user_disabled
authorization_insufficient
authorization_ancestor_invalid
authorization_role_removed
wrong_boundary
request_not_pending
request_already_decided
request_denied
request_cancelled
request_invalidated
redemption_invalid
redemption_already_used
watch_ticket_invalid
watch_ticket_expired
bootstrap_required
bootstrap_token_not_configured
bootstrap_credential_invalid
bootstrap_already_completed
recovery_invalid
recovery_expired
login_invalid
login_throttled
authentication_busy
password_policy_failed
password_confirmation_required
password_reset_not_found
password_reset_denied
password_reset_expired
password_reset_capability_invalid
interactive_input_required
auth_store_permissions_unsafe
context_conflict
```

Authorization errors may show current authority and failed capability but never
recommend escalation.

## CLI exit/input contract

| Exit | Meaning                                         |
| ---: | ----------------------------------------------- |
|    0 | success                                         |
|    1 | structured server/operation failure             |
|    2 | CLI usage or missing required interactive input |
|  127 | isolate child command missing                   |
|  130 | Ctrl-C                                          |

`auth isolate` otherwise returns the child's exit status and forwards signals.
Agents consume `error.code`, not a second detailed exit-code taxonomy.

Global noninteractive controls:

```text
--non-interactive
OPERANT_NON_INTERACTIVE=1
```

Passwords use prompts or `--password-stdin`; no password-value argument exists.
Without TTY/stdin, login/bootstrap/recovery return `interactive_input_required`.
Noninteractive approve requires `--yes`; logout-all/revoke-other require
`--password-stdin --yes`; doctor risky fixes require `--yes`. Piped JSON/data
commands never prompt.

## Context contract

```text
context list
context show
context add
context use
context set-project
context remove
```

Same name/origin add is idempotent. Same name/different origin returns
`context_conflict`; replacement requires `--replace` and confirmation/`--yes`.
Removing active context requires `--force` and leaves none active.

Bootstrap automatically creates/activates `local` for loopback, explicit
`--context` when supplied, normalized hostname for remote, hostname+port for
non-default port, and a short origin-digest suffix on collision. Contexts
contain no credentials/identity. Cross-origin redirects never receive
credentials.

## Doctor contract

```json
{
  "healthy": false,
  "findings": [{
    "severity": "error",
    "code": "token_permissions_unsafe",
    "path": "...",
    "repairable": true,
    "planned_action": "chmod_0600"
  }],
  "fixes": []
}
```

Severity: `info | warning | error | unsafe`. `doctor` is read-only. `--fix`
applies only allowed local repairs after one plan/confirmation; partial fixes
are reported individually and unsafe findings are never auto-repaired. Exit 0
when no error/unsafe remains, otherwise 1; `--strict` makes warnings fail.

## Isolate contract

```text
optctl auth isolate -- <agent-command>
```

Missing request credential returns `authorization_request_credential_missing`;
unsupported process inspection returns `process_inspection_unsupported`; missing
child exits 127. Signals are forwarded, isolate remains alive, child exit status
is returned, and no bearer token enters the child environment.
