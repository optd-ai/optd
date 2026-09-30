<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-authentication; contract: 1; input: sha256:c4494f920914899fb8d6ad930cbffceec398ad89ba1517e3919f2bb1cf19a2f9 -->

# Authentication and Local Agent Grants

Generated exact-contract projection imported into project-model/model.json from the reviewed authentication.md source.

## Exact migrated contract

<a id="obj-com-exact-authentication-v1"></a>

### Exact v1 contract — Authentication and Local Agent Grants

**Migration provenance.** Exact normative contract imported from `spec/authentication.md` at `sha256:907cbfed4b2bd8237c2d423f8bbde8e829966e7d7706cb44009a85c2b73eb839`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Status

Implemented and frozen for the current single-tenant local-first contract.
Production requests use opaque server-issued credentials and server-derived
principal, human-anchor, role, session, and authorization-context facts; caller-
supplied actor or role authority is rejected.

## Goals

- Distinguish human users, agent users, and system actors in authentication and
  provenance.
- Let local agents request a role and continue using ordinary `optctl` commands
  after user/authorized approval.
- Prevent accidental role switching by agents that can edit `--actor` flags or
  changeset JSON.
- Preserve install simplicity: no root-owned files, no required daemon, no
  mandatory OS keyring, no JWT ceremony for the local-first MVP.
- Preserve clean server semantics: every HTTP request is authenticated and
  authorized in isolation from local process-tree details.
- Use full authentication in dev and production; tests may use a port/adapter
  test implementation.

## Non-goals

- Perfect protection against malicious code running as the same OS user.
- Mandatory OS keyring integration.
- Mandatory background auth agent.
- JWT/OIDC as the default local-agent auth model. OIDC/JWT may be added later as
  an integration path for external identity providers.
- Server-side inspection of local process ancestry during ordinary API request
  handling.

## Research-backed patterns

- `sudo`: scoped, revocable local auth cache; useful validate/invalidate UX but
  optd should not copy sudo's short timeout by default.
- polkit: unprivileged process requests action; authorized principal approves;
  policy controls who may approve.
- OAuth device-code flow: constrained client creates a request and asks a user
  to approve elsewhere.
- AWS STS AssumeRole / service-account impersonation: temporary assumed role
  while preserving original-principal provenance.
- SSH/gpg agent: optional future no-root local process can hold secrets in
  memory, but requiring it would hurt install simplicity.

## Principal model

optd should model at least three execution identities:

- `human_user`: the single human/admin identity on the local machine or server
  installation. The human user logs in through `optctl`, owns the
  authorization-request credential, and is the root source for roles that can be
  requested or granted locally.
- `agent_user`: a local agent process/session using a role grant ultimately
  authorized under the human user. An agent user never has access to roles the
  human user cannot assume or grant.
- `system`: internal platform actors such as migrations, seed application,
  scheduled work, or server-owned maintenance operations.

Roles are authorization concepts, not identities. All local human/agent role use
is anchored to the human user, while provenance records whether the work was
performed directly by the human user or by an agent user acting under an
approved grant.

Human users have immutable server ids, unique login usernames, and
active/disabled lifecycle status. References and audit use the immutable id;
username is login metadata. Disabling a human user immediately revokes all full
sessions, authorization-request sessions, agent authorizations, and pending
agent requests anchored to that user. Human-user hard deletion is not supported
because audit and provenance references must remain valid; deletion is modeled
as disablement with optional PII redaction.

## Server and `optctl` boundary

The design separates two related records:

- A **local process grant binding** is `optctl`-owned filesystem state that
  binds a credential to a local process tree and controls credential selection.
- An **agent authorization session** is server-owned state that maps an opaque
  bearer token to an agent principal, anchoring human user, approved role,
  project authority, revocation state, and audit provenance.

The server checks the current HTTP request only:

1. Is there a credential?
2. Is its authorization session valid, unexpired if applicable, and not revoked?
3. What principal/session/effective role and project authority does it map to?
4. Is that effective actor authorized for this operation?
5. What provenance should be recorded?

The server should **not** inspect local process ancestry or decide whether a
local process is still in an approved process tree. That is `optctl`'s local
credential-selection responsibility. The server stores token hashes and
authoritative authorization state, but no authoritative PID-tree binding.

`optctl` decides which token to attach by inspecting local filesystem auth state
and process/session binding metadata. A local binding cannot mint or expand
server authority; it only controls local access to a server-issued credential.

## One authentication model and testing strategy

optd has one normal server authentication model for development, containers,
and production: opaque server-issued bearer tokens resolved through server-side
sessions, authorizations, role assignments, policy assignments, and auth
contexts. Bootstrap and recovery are explicit installation states, not auth
modes. Internal system execution and deterministic test authentication are
application composition paths, not publicly selectable runtime modes.

There is no `OPTD_AUTH_MODE`, disabled mode, dev trust mode, or runtime actor
impersonation switch. Unknown obsolete insecure auth-mode configuration fails
with an actionable unsupported-configuration error.

### Public route classes

- `/live`, `/ready`, and minimal bootstrap status are unauthenticated and expose
  only operational state.
- The bootstrap endpoint is available only in `bootstrap_required` and requires
  `OPTD_BOOTSTRAP_TOKEN`.
- Login validates username/password before issuing authority; recovery requires
  its explicit operator-created recovery credential.
- Every other public operation requires normal bearer authentication.

If the database is `bootstrap_required` but `OPTD_BOOTSTRAP_TOKEN` is absent,
the server starts for diagnostics and reports `bootstrap_token_not_configured`;
ordinary routes remain unavailable. Once active, the environment variable is
unnecessary and any remaining value is ignored.

The server never accepts principal or role authority from `--actor`, actor/role
HTTP headers, or request JSON. The authenticated actor is derived exclusively
from the bearer token and current server state. Auth implementation removes
pre-auth compatibility rather than preserving these inputs.

### Application port

Application services depend on a request-authentication port such as:

```ts
interface RequestAuthenticator {
  authenticate(input: AuthenticationInput): Promise<AuthResult>;
}
```

The production adapter validates token hashes, sessions, authorization chains,
revocation, boundary-specific effective roles, and persists an immutable auth
context. Services receive the validated context and do not parse bearer headers.

A deterministic test adapter is constructed only through unit/integration test
dependency injection. It is not reachable through an environment variable,
public header, or production server route.

### Test levels

- Unit tests inject deterministic principals and process graphs.
- Service/database integration tests may inject deterministic auth when auth
  mechanics are not under test.
- Focused auth integration tests exercise password hashing, bootstrap, login,
  opaque token lookup, revocation, role/boundary resolution, and auth-context
  persistence.
- At least one full scenario uses only public bootstrap/login/request/approve/
  work/revoke interfaces, verifies denial and provenance, and uses no test actor
  headers or JSON.

Canonical manual workflows also use real bootstrap/login/token authentication.
Historical prototype documents may show pre-auth fixtures, but canonical
runbooks and acceptance scenarios must not recommend insecure runtime auth.

### Internal system principals and hooks

Migrations, seeds, hooks, and outbox workers use explicit internal principals
such as `system:pack_migrator`, `system:seed_runner`, and
`system:outbox_worker`. Only internal application composition can create these
contexts; HTTP callers cannot request them. A system principal is audited and
does not automatically imply `system:super_admin`.

Hooks never receive initiating human/agent bearer tokens. Synchronous and
background hooks run under constrained internal execution contexts while
preserving initiating auth context and causation. Pack hooks permanently have no
self-API capability; any future automation component with API authority would be
a separate reviewed principal model, never exposure of the original bearer
token.

## Role system resources and summaries

The target model has first-class global role system records. Legacy implicit
strings in the pre-auth implementation/fixtures must be migrated to explicit
publisher-qualified or reserved built-in role identities.

A role is not itself a permission list. It should not own an `allow` field.
Policies grant permissions to roles; role objects provide identity, lifecycle,
metadata, human/agent guidance, and a stable object for policies, users, and
grants to reference.

Role definitions are globally registered system objects; holding a role is
always expressed by a separate assignment with an explicit boundary. The same
role definition can therefore be assigned in `sales`, `sandbox`, all projects,
or the system boundary without cloning the definition.

- Pack role definitions use publisher-qualified identities such as
  `optd/crm:sales_manager`.
- Built-in roles use reserved identities such as `system:super_admin` and
  `system:admin`.
- Policies reference canonical role definition ids.
- Human-user role assignments and server agent authorizations reference a role
  definition plus exactly one project/all-project/system boundary.
- Pack install/preview canonicalizes relative references and detects definition
  conflicts.
- Missing assignment boundary never implies global authority.

The normative role, policy, and assignment model is defined in
[Authorization Definitions and Assignments](authorization-assignments.md).

A role object should fit the broader system-resource model: declarative,
previewable, migratable, auditable, and inspectable through metadata.

Example role object:

```yaml
kind: Role
metadata:
  name: sales_manager
spec:
  display_name: Sales Manager
  description: Human or agent responsible for CRM lead and opportunity work.
  introduced_by_pack: "optd/crm"
  lifecycle:
    status: active
  axi:
    summary: Can manage CRM leads and opportunities.
    verbose_guidance:
      - Use this role for agents that qualify leads, convert leads, and manage opportunity lifecycle.
      - This role is broader than sales_rep and should not be granted to read-only reporting agents.
      - Exact allowed operations come from active policies that reference this role.
```

### Role summary source of truth

Role `axi` is authored intent and usage guidance, not authorization truth.
Active policy definitions and assignments are authoritative. Policy rules may
include `axi.summary` to explain their conditions in human terms; the server
combines that prose with the structured rule but never uses prose to decide.

`optctl auth roles` resolves an explicit or active-context
project/all-project/system boundary and echoes it, then shows canonical role id,
display name, and `role.spec.axi.summary`. It lists roles available through the
anchoring human user's assignments even when no active policy currently grants
useful capabilities; such roles remain visible with a warning.

`optctl auth roles --verbose` asks the server for boundary-specific structured
capability explanations containing:

- resource definition and action;
- unconditional, ABAC-conditional, or ReBAC-conditional access classification;
- policy/rule ids and active definition versions;
- authored rule summaries and role guidance;
- warnings, including no active policy capability.

Conditional rules must always remain labeled conditional. A conditional update
rule must never be summarized as unconditional update access. The server, not
`optctl`, computes and deduplicates capabilities from policy definitions
selected by active policy assignments in the target boundary. `optctl` formats
the structured response as TOON by default or JSON with `--json`.

Approval of a multi-role request shows guidance for each requested role and a
deduplicated combined capability summary for the shared boundary. The approval
audit record snapshots the displayed role ids, role-definition versions,
policy-definition versions, and a digest of the structured capability summary.
The snapshot records what the approver saw; ongoing authorization always uses
current server state.

## Password authentication contract

MVP human authentication uses `@node-rs/argon2` Argon2id with a versioned
`argon2id.v1` profile:

```text
memoryCost: 19,456 KiB
timeCost: 2
parallelism: 1
output: 32 bytes
```

Store the complete salted PHC string plus profile and password-changed
timestamp. On successful login, verify encoded parameters and transactionally
rehash when the stored profile is weaker than current policy. Pin the tested
package version.

Default password policy is intentionally minimal for local installations:

```text
minimum: 8 Unicode characters
maximum: 1,024 UTF-8 bytes
Unicode normalization: NFC
composition requirements: none
periodic expiration/history/blocklist: none
```

Allow spaces, pasted passwords, and Unicode. Reject empty/whitespace-only,
embedded newline/NUL, and over-byte-limit values. Password stdin removes only
the line terminator, not spaces. No canonical/common-password blocklist is
included in this version.

Operators may configure individual, startup-validated variables:

```text
OPTD_PASSWORD_MIN_LENGTH=8
OPTD_PASSWORD_REQUIRE_UPPERCASE=false
OPTD_PASSWORD_REQUIRE_LOWERCASE=false
OPTD_PASSWORD_REQUIRE_DIGIT=false
OPTD_PASSWORD_REQUIRE_SYMBOL=false
OPTD_PASSWORD_MAX_CONCURRENT_HASHES=4
```

Do not support a password regex. Values below eight are allowed with an explicit
startup warning for local operator choice. `GET /api/v1/auth/password-policy`
returns the effective typed policy so `optctl` can explain it before prompting;
server validation remains authoritative.

Passwords enter only through no-echo interactive prompts or `--password-stdin`;
no password-value argument exists. Remote password submission requires HTTPS,
except loopback/local development HTTP. Password fields are excluded from logs,
telemetry, errors, redirects, and response DTOs.

Login uses one generic `login_invalid` response for unknown username, wrong
password, or disabled user. Unknown users verify against a fixed dummy Argon2id
PHC hash to reduce username timing disclosure. The library verify operation is
used directly.

Postgres-backed throttling is keyed by normalized username. Failures 1–4 have no
delay; failures 5+ require 1, 2, 4, 8, 16, then at most 30 seconds. Throttled
requests return `429 login_throttled` with `retry_after_seconds`; successful
login/password change/recovery resets the counter, stale rows may be removed
after 24 hours, and there is no permanent lockout or IP storage.

Each app process uses a non-queuing Argon semaphore sized by
`OPTD_PASSWORD_MAX_CONCURRENT_HASHES`. If no slot is immediately available,
return `503 authentication_busy` with `Retry-After: 1`.

Self password change verifies the current password, applies policy, updates the
hash, revokes every human/request/agent session and pending request anchored to
the user, resets throttling, issues replacement full and authorization-request
sessions, and audits the change. Destructive password confirmations share the
same verification/throttle behavior.

### Normal password-reset request

A forgotten-password user creates a reset request without a session:

```bash
optctl auth password-reset request --username jordan
```

The client generates an idempotency key and a private redemption nonce with at
least 128 bits of cryptographic entropy, and sends only the nonce hash. The
server returns an opaque UUIDv7 request ID. The ID is a public workflow
identity, not proof of possession; non-enumeration and redemption security come
from the uniform response, exact-ID lookup, throttling, and the separate private
nonce. There is no endpoint/CLI command to list pending reset requests; a
super-admin must provide the exact ID:

```bash
optctl auth password-reset inspect reset_<random-id>
optctl auth password-reset approve reset_<random-id>
```

Inspection shows target username, creation/expiry, reason, and warns the
super-admin to verify that the user supplied this exact id. Approval does not
receive/set the password or reveal a reset token. The reset requires both
super-admin approval with the exact id and the original requester's private
nonce.

The requester waits on the same indefinite reconnectable WebSocket pattern as
auth requests. After approval it redeems the nonce for a narrowly scoped
single-use reset capability, prompts/confirms a new password, then completes the
reset. Completion updates the hash, revokes all anchored human/request/agent
sessions and pending auth requests, resets throttling, issues new full/request
sessions, invalidates the capability, and audits completion.

Reset requests are idempotent, non-enumerable, cancellable by the requester,
single-use, and expire after 30 minutes. Denial is terminal. Creation is
username-throttled and always returns a non-enumerating public shape.

This normal reset requires an active super-admin. If none is usable, the
separate host/container/database operator recovery workflow below is required.

## Human-user authentication contract

Primary command:

```bash
optctl auth login [--username <name>]
```

Behavior:

1. If `--username` is omitted and no username has been stored locally before,
   prompt for username.
2. Prompt for password or other configured human-user authenticator.
3. Authenticate to the server.
4. Server returns:
   - a full human-user session token bound locally by `optctl` to the current
     process tree/session;
   - a authorization-request token tied to the same human user, used by other
     non-escalated process trees to list requestable roles and create auth
     requests.
5. `optctl` stores the full token in the local auth store with process/session
   binding metadata.
6. `optctl` stores the authorization-request token for use by non-escalated
   process trees.

A later `optctl auth login` from another terminal/process tree is the normal way
for the human user to escalate that process tree into a full human-user session.
Until then, that process tree uses only the authorization-request credential.

A full human session has no automatic expiration for this implementation pass.
Session expiration/idle timeout is deliberately deferred until its UX and
recovery effects can be designed. Sessions remain explicitly revocable, and a
password/authenticator reset invalidates every full session,
authorization-request session, agent authorization, and pending agent request
anchored to that human user.

Multiple full sessions are allowed. Each login creates an independently
revocable full session. The authorization-request session is reused or rotated
rather than creating an unbounded authorization-request credential for every
login.

One local OS login session/user account may be associated with only one optd
human user per normalized server origin. Switching users requires
`auth logout --all` followed by password login as the other user; `optctl` never
silently hides or orphans the previous user's durable credentials. Login always
prompts for a password; there is no silent human login or refresh-token flow for
the MVP.

Useful commands:

```bash
optctl auth login
optctl auth whoami
optctl auth status
optctl auth logout
optctl auth logout --all
```

`optctl auth logout` revokes the current server full session and deletes its
local process-tree binding. `optctl auth logout --all` explains that it will
revoke all full sessions, authorization-request sessions, agent authorizations,
and pending requests anchored to the human user, then requires password
reauthentication and a `y/N` confirmation. Password confirmation prevents an
agent holding an inherited session from revoking unrelated sessions. There is no
separate lock operation for the MVP.

## Authorization-request credential

The first successful human-user login should create two credentials:

- a full human-user session token bound to the current process tree/session;
- a authorization-request token tied to that human user and usable by other
  `optctl` process trees on the same local machine/user account.

The request token is not an authority to do normal platform work. It should only
allow auth-discovery and auth-request operations:

- `optctl auth status`
- `optctl auth roles`
- `optctl auth roles --verbose`
- `optctl auth request --role ...`
- possibly `optctl home` with limited/bootstrap-safe metadata

`optctl auth roles` filters through the human user associated with the request
credential. It shows roles that human user is allowed to request/grant.

If no human-user login/authorization-request credential exists,
`optctl auth roles` should not show roles. It should tell the caller to ask the
human user to run:

```bash
optctl auth login
```

The request credential should be revocable and rotated when appropriate. A
password/authenticator reset or user disable revokes it together with all other
sessions and authorizations anchored to that human user.

## Agent role request workflow

Agents start with the human user's authorization-request credential when no
approved local process grant binding and corresponding server authorization
session are available. That credential is enough to inspect auth status, list
roles requestable/grantable by that human user, and create an auth request.

Proposed flow:

```bash
optctl auth roles
optctl auth roles --verbose
optctl --project sales auth request \
  --role optd/crm:sales_manager \
  --role optd/crm:sales_rep \
  --reason "Need to qualify CRM leads"
```

The request may include optional, explicitly agent-reported metadata: `name`,
`harness`, `external_session_id`, `provider`, `model`, and `reasoning_effort`.
These typed fields are unverified approval context, never authorization input.
optd does not accept arbitrary environment/settings dumps or infer this
metadata from processes. The approver may override the friendly name.

`optctl auth roles` with no flags shows only role names and concise summaries.
`--verbose` shows detailed permissions/capabilities for each role when the
caller explicitly chooses to inspect available roles.

The request records:

- one or more requested canonical roles;
- exactly one requested boundary shared by all requested roles: project,
  all-projects, or system;
- reason;
- optional typed agent-reported metadata;
- created timestamp;
- a client-generated request idempotency key.

The agent should request the specific role set it needs. The human user may tell
the agent which roles to request, or the agent may inspect roles available under
the human user's authorization-request credential and choose. Humans and agents
may both hold multiple roles. Approval is all-or-nothing; partial approval
requires a new request with a smaller set.

Each request asks for one or more roles in exactly one boundary. Approval
creates a replacement authorization containing the agent's prior still-valid
bounded role assignments plus the newly approved assignments. One process
binding points to one current authorization token.

Request creation is idempotent using the authorization-request session id plus a
client-generated idempotency key persisted in the local request record. It does
not depend on a harness or agent-session id always being available.

Request output:

```text
auth request created
request_id: 019b7a2e-7c10-7000-8000-000000000101
requested_roles: [optd/crm:sales_manager, optd/crm:sales_rep]
requested_boundary: project:sales
agent_name: crm-lead-agent

Ask an authorized user/agent to run:
  optctl auth approve 019b7a2e-7c10-7000-8000-000000000101 --agent-name crm-lead-agent
```

If the same agent process tree already has a sufficient local process grant
binding backed by an active server authorization session, another auth request
for that role set should not create churn. It should report that the agent is
already authorized for those roles and show the local binding plus authorization
session summary.

Pending requests last indefinitely until approved, denied, cancelled by the
requester, or invalidated by cleanup/revocation of the associated
authorization-request credential. Requester cancellation is terminal, audited,
and wakes connected waiters through the same Postgres-backed status path.

Agents may wait for approval:

```bash
optctl auth wait 019b7a2e-7c10-7000-8000-000000000101
```

`auth wait` obtains a short-lived single-use watch ticket using the
authorization-request credential, then waits indefinitely on the request's
WebSocket status stream. Postgres `LISTEN/NOTIFY` wakes connected app nodes,
with Postgres state remaining authoritative. Transient disconnect reconnects to
the same request with a new ticket; it never creates a new request. There is no
wait timeout. Ctrl-C leaves the request pending.

The requester generated a private redemption nonce at request creation; the
server stores only its hash. Approval never returns the bearer token to the
approver. On approval, `auth wait` presents the nonce, receives the replacement
token, atomically installs it as the requesting process binding's one current
authorization, and exits successfully.

If delivery is interrupted, retry verifies the same nonce and either completes
idempotently or revokes the undelivered session and remints a replacement. On
denial, `auth wait` prints the human-supplied reason, exits nonzero, suggests no
alternative role/request, and the agent stops and reports the denial.

## Approval workflow

Any authenticated principal with policy-derived `auth.request.decide` may
approve or deny. Approval additionally requires every requested role to be in
the approver's effective role set in the requested boundary. Human and agent
approvers use the same checks; `system:super_admin` follows its documented
bypass and last-human-super-admin invariants.

```bash
optctl auth approve 019b7a2e-7c10-7000-8000-000000000101 --agent-name crm-lead-agent
```

Approval must be policy checked. Approval UI should show:

- request id;
- requesting agent user/session id and friendly name;
- requested boundary;
- reason;
- requested roles and shared boundary;
- approver identity;
- whether the approver currently holds every requested role;
- human-readable permission summaries for the roles.

Confirmation:

```text
Grant roles [optd/crm:sales_manager, optd/crm:sales_rep] in project sales to agent session sess_xyz789 until the process tree exits?
Friendly agent name: crm-lead-agent
Approve? [y/N]
```

Non-interactive admin scripting may use:

```bash
optctl auth approve 019b7a2e-7c10-7000-8000-000000000101 --agent-name crm-lead-agent --yes
```

but the default should be interactive and explicit.

Approvers should be able to deny a request with a reason:

```bash
optctl auth deny 019b7a2e-7c10-7000-8000-000000000101 --reason "Requested role is too broad"
```

The agent observes the denial and reason through `auth wait` or `auth status`
and takes no automatic follow-up action.

On approval:

1. The server policy-checks `auth.request.decide`, verifies the approver holds
   every requested role in the shared boundary, and validates the same-human
   authorization chain.
2. The server creates an agent principal if needed and records the approved
   replacement authorization, but sends no token to the approver.
3. The requester's `auth wait` proves possession of the redemption nonce.
4. The server mints an opaque token, stores only its hash, and returns it once
   to the requester.
5. `optctl` atomically supersedes the old local binding token. Subsequent calls
   always use the nearest process binding's one current token.

## Grantability

Grantability is deliberately simple. `auth.request.decide` is the actor's
policy-derived `can_grant` capability and covers both approve and deny. There is
no separate delegation resource, grantable-role list, or grantability boundary.

An actor with `auth.request.decide` may approve any requested roles currently in
its own effective role set in the requested authorization boundary. An active
`system:super_admin` bypasses the role-possession check and may grant any role;
granting super-admin still requires super-admin and preserves the
last-human-super-admin invariant. The recipient must be an agent authorization
anchored to the same human user because this workflow delegates use of that
user's own login authority. Assigning roles to another human user is a separate
administration operation.

Delegation chains are supported. Each use validates the anchoring human,
immediate parent authorization, and effective role set. If an upstream role is
lost, downstream authorization continues with its valid role subset and the
server returns explicit role/ancestor errors where relevant; `optctl` may clean
up invalid local credentials opportunistically. Eager cascading revocation is
not required.

Server-side enforcement is required even if `optctl` UI is bypassed.

## Process/session binding contract

`optctl`, not the server, enforces local process bindings.

A full human login binding applies to the complete descendant process tree. This
is intentional so scripts, pipelines, and subagents can run `optctl` without
random login failures. A user who wants an agent to begin with minimal authority
should start that agent outside a human-authenticated tree, then log in and
approve its request from another terminal.

`optctl` walks ancestry and selects the nearest process binding, which points to
one current authorization token. It does not inspect target roles/projects to
choose among credentials, combine tokens, search other bindings after denial, or
fall back to a broader ancestor. If no process binding matches, it uses the
authorization-request credential only for its narrow auth workflow.

This allows a top-level agent to create a subagent, have the subagent request a
subset of the parent's roles before work begins, and approve that request when
the top-level agent has `auth.request.decide`. The subagent-specific binding
then restricts/overrides inherited authority for that subtree.

A binding anchor identity requires:

- PID;
- parent PID for ancestry walking;
- process start/creation time with the highest stable platform precision;
- real OS user id/SID;
- boot-session marker;
- binding creation time.

PID alone is never sufficient because operating systems reuse PIDs. Hostname,
executable basename, redacted command summary, cwd/project path, and model or
harness metadata are diagnostic/provenance fields only and do not establish a
binding.

For every `optctl` invocation, the process inspector walks from the caller up
through parent identities, rejects stale/reused identities, honors an optional
verified tree-stop marker, and selects the nearest matching anchor. If a
narrower binding matches but its server authorization is revoked or
insufficient, `optctl` must not retry with a broader ancestor credential; it may
use only the authorization-request credential to request replacement authority.

Human login and agent authorization requests anchor to the immediate parent of
the transient `optctl` command. This requires no agent-harness or terminal-
multiplexer detection: the command expresses human versus agent intent, the
invoking shell/harness is naturally the parent, and sibling shells/panes are not
descendants.

`optctl auth session-pid` prints the immediate caller PID as a machine-readable
integer. A parent agent may launch a subagent with:

```bash
OPTD_AUTH_TREE_STOP_PID="$(optctl auth session-pid)" subagent
```

The stop PID must occur in the caller's actual ancestry and must match its full
PID/start-time/user/boot identity. `optctl` inspects that process but never
walks above it. An unrelated or stale stop PID is rejected. `OPTD_*` is the
project-wide environment variable prefix; this variable affects only local auth
credential selection.

The preferred launch UX is:

```bash
optctl auth isolate -- <agent-command>
```

`auth isolate` verifies an authorization-request credential exists, sets the
tree-stop PID to the isolate process, spawns the child without any bearer token
in its environment, remains alive while the child runs, and returns its exit
status. The child cannot discover bindings above the isolate process and starts
with request-only authority. The raw environment variable remains available for
advanced launchers.

The local binding applies when current `optctl` process ancestry matches its
stored anchor process tree. When the anchor process exits, `optctl` must stop
using the credential and may clean up the local binding. It should make a
best-effort server revocation request when cleaning up, but correctness must not
depend on the server observing local process exit. Detached or reparented
automation receives only authorization-request authority; durable service
automation is outside the MVP local-binding design.

### Agent session identity

optd generates its own opaque random local agent-session id when a process
anchor first runs `optctl auth request`. The id is stored with the local process
binding and reused by later short-lived `optctl` invocations while that anchor
identity remains valid. The server independently creates its own
`agent_user_id`, auth request id, and authorization ids. Local and server ids
are not treated as the same identifier.

Agent identity requires no harness detection. Human versus agent intent comes
from `auth login` versus `auth request`; process anchoring comes from the
process inspector. Resuming a third-party harness after its process exits
creates a new optd local session and requires new authorization because the
process-bound security context changed.

Research found no portable documented agent-session environment contract:

- OpenAI Codex documents `CODEX_THREAD_ID` for child commands, but it is Codex
  correlation metadata rather than an optd authorization identity.
- Claude Code and Gemini CLI expose session ids to configured hooks, not as a
  general inherited contract for arbitrary subprocesses.
- Cursor and standalone GitHub Copilot CLI do not document a general child
  session id. GitHub Actions run ids identify workflow execution, not an agent
  conversation.
- Pi exposes session id/model/provider through its extension API
  (`ctx.sessionManager.getSessionId()` and `ctx.model`) but does not document a
  current-session environment variable for arbitrary child commands.
- `pi-subagents` exports package-specific run/routing variables; they are not Pi
  core session ids, and some include sensitive paths or capability tokens.

Therefore MVP core does not inspect harness-specific environment variables,
command lines, transcript/session files, internal databases, or parent process
names to derive identity. It does not read or forward provider API keys,
capability tokens, transcript paths, repository/workflow metadata, model, or
provider information.

A future explicit harness integration may supply an opaque, non-secret local
correlation alias or friendly name through a documented adapter. Explicit typed
agent-reported metadata may be sent with an auth request, but inferred process
metadata remains local, never changes binding checks, and never expands server
authority.

Research references:

- <https://developers.openai.com/codex/cli/reference/#environment-variables>
- <https://docs.anthropic.com/en/docs/claude-code/hooks>
- <https://geminicli.com/docs/hooks/>
- <https://docs.github.com/en/actions/reference/variables-reference#default-environment-variables>
- Pi extension/session APIs in the installed Pi documentation:
  `docs/extensions.md` and `docs/session-format.md`.

### Platform process inspection

The implementation-pass target is Linux (including the compiled CLI/container
acceptance environment) because it is the available test platform, not because
the model is Linux-only in principle. macOS/Windows adapters below define
portability intent but are implemented only when they can be tested on those
systems; builds without a verified adapter return
`process_inspection_unsupported` and never weaken matching to PID-only.

Process inspection sits behind a platform adapter and returns explicit `gone`,
`denied`, and `unsupported` outcomes. Full/agent credential selection fails
closed when the required identity cannot be established; it never downgrades to
PID-only matching. Tests use a deterministic fake process graph.

#### Linux

Use `/proc/<pid>/stat` for parent PID and process start ticks,
`/proc/<pid>/status` for real UID, and `/proc/sys/kernel/random/boot_id` for
boot UUID. Identity is `{boot_id, uid, pid, start_ticks}`. The executable
prototype in `prototypes/process-binding/` validates real ancestry,
PID-reuse/staleness checks, closest selection, and tree-stop validation.

#### macOS

Use `proc_pidinfo(PROC_PIDTBSDINFO)` to obtain parent PID, exact process start
seconds/microseconds, and real/effective UID. Use the boot-session UUID when
available, with `kern.boottime` as a runtime-tested fallback. Identity is
`{boot_marker, ruid, pid, start_sec, start_usec}`. Basic BSD identity is
normally available without root, but lookups can return gone/denied for
protected or racing processes.

A small native helper compiled against the macOS SDK is preferred over parsing
`ps`; direct Deno FFI is viable but must model Darwin ABI layouts and
permissions correctly. Ancestry is not an atomic kernel snapshot, so
implementations should re-read/revalidate child identity and parent linkage
during a walk.

Primary references:

- <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/libproc.h>
- <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h>
- <https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/proc_info.c>

#### Windows

Use Tool Help `PROCESSENTRY32.th32ParentProcessID` for reported parent PID, then
open child/parent with `PROCESS_QUERY_LIMITED_INFORMATION`. Use
`GetProcessTimes` creation `FILETIME` (retained as a 64-bit integer) and
`OpenProcessToken` plus `GetTokenInformation(TokenUser)` for the user SID. Use
cached `Win32_OperatingSystem.LastBootUpTime` as the documented boot marker; an
uptime-derived marker is only a fallback.

Identity is `{boot_marker, user_sid, pid, creation_filetime}`. Reject an alleged
parent created after its child. Ordinary same-user processes are usually
queryable without admin rights, but elevated/protected/exiting processes may be
denied or disappear. Tool Help plus `OpenProcess` is not atomic, so failures and
inconsistent observations fail closed rather than falling back to PID-only
matching.

A small native helper is preferred for production over PowerShell/CIM startup
and parsing or complex Win32 Deno FFI layouts. CIM remains suitable for
obtaining and caching the documented boot timestamp.

Primary references:

- <https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/ns-tlhelp32-processentry32>
- <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes>
- <https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights>
- <https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-gettokeninformation>
- <https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-operatingsystem>

## Filesystem auth store

Base MVP does not require root, setuid helpers, OS keyring, or a background
daemon. Active credentials and process bindings are stored durably because each
`optctl` invocation is short-lived and human login sessions do not automatically
expire in this pass.

Platform data roots:

- Linux: `$XDG_DATA_HOME/optd/auth/`, falling back to
  `~/.local/share/optd/auth/`.
- macOS: `~/Library/Application Support/optd/auth/`.
- Windows: `%LOCALAPPDATA%\\optd\\auth\\`.

Runtime directories such as `$XDG_RUNTIME_DIR` may hold locks and temporary
files, but are not the only copy of active credentials. Reboot or OS logout does
not require a new optd login. Dead process bindings remain unusable and are
removed by cleanup.

### Server origin partitioning

Credentials are partitioned by a hash of the exact normalized server origin:
scheme, hostname, and effective port. `optctl` sends a credential only to its
recorded origin. Remote origins require HTTPS unless the user explicitly enables
insecure HTTP; loopback/local development may use HTTP.

TLS/Web PKI is the MVP server-identity boundary. A server installation id may be
stored for diagnostics, but `optctl` does not make a preflight request before
every command. This avoids a double HTTP call and does not attempt to defend
against an internal actor that controls the origin and a valid certificate.

### Layout and schemas

```text
<auth-root>/
  identity.json
  instances/
    <origin-hash>/
      server.json
      sessions/
        <session-id>/
          metadata.json
          token
      bindings/
        <binding-id>.json
      requests/
        <request-id>.json
      authorizations/
        <authorization-id>.json
```

Each JSON record has `schema_version`, `record_type`, normalized server origin,
created/updated timestamps where applicable, and ids/references needed for its
record type. Session metadata and raw token contents are separate so status and
cleanup can inspect metadata without reading or serializing credentials. Token
files contain only the opaque UTF-8 token with no JSON wrapper.

The store uses separate per-record files rather than one mutable auth document.
The expected record count is small enough to scan without a mutable index.

### Permissions and safe repair

On Unix, directories use `0700` and files use `0600`. Windows uses equivalent
current-user-only ACLs through the platform adapter. New records use exclusive
creation and atomic temporary-file rename; implementations reject symlink path
components and non-regular files/directories.

If an interactively invoked `optctl` finds a path owned by the current OS user
with overly broad permissions, it explains the issue and offers to repair it,
defaulting to yes. It verifies the result before continuing. Non-interactive use
fails with an actionable command:

```bash
optctl auth repair-permissions --yes
```

`optctl` refuses automatic repair when ownership is wrong, a path is a symlink,
the path type is unexpected, or safe permissions cannot be verified after
repair. Group-readable token state is not accepted.

The server stores token hashes and authorization-session metadata/revocation
state, never plaintext tokens. Local binding ids may reference server session or
authorization ids, but local and server records have different ownership and
semantics.

### Lifecycle and cleanup

- Login writes a new full-session token/binding and creates or rotates the
  authorization-request credential.
- Agent approval writes a token, authorization metadata, and process binding.
- `auth logout` revokes and removes the current full session/binding.
- `auth logout --all` password-reauthenticates, confirms, revokes all anchored
  state server-side, and removes visible local state.
- An agent may revoke its own authorization without a password; it cannot revoke
  sibling, parent, or other-user sessions.
- `auth revoke <authorization-id>` for another session/agent requires human
  password reauthentication and confirmation.
- Process exit makes a binding stale immediately; cleanup removes it and its
  unreferenced token and attempts server revocation when appropriate.
- Password reset or user disable immediately revokes server state; local files
  are removed when the client next observes rejection or runs cleanup.
- Corrupt records are never selected and are reported for quarantine/removal.

`optctl auth cleanup` always performs safe local cleanup offline. When online,
it also checks server state and best-effort revokes stale agent authorizations.
Failure to contact the server does not restore or select a broader credential.
Non-authoritative request UX metadata may use a simple retention period.

### Status contract

`auth status`, `auth whoami`, and `auth sessions` return explicit safe fields:

- server origin;
- credential and principal type;
- human/agent user identity;
- effective roles and assignment boundary;
- binding, session, and authorization ids;
- anchor PID and liveness/staleness;
- request-credential availability;
- server status when checked;
- selection explanation and warnings.

The status DTO contains only these intended fields; token values and
password/authenticator material are not part of it. Default output is concise,
while `--verbose` includes safe process-selection diagnostics.

### Concurrency and crash safety

Readers scan complete per-record files without a global lock. Writers create a
temporary file with strict permissions, flush where practical, and atomically
rename it into place. Mutations affecting multiple records, cleanup, permission
repair, and local human-identity association use a short per-instance advisory
lock with stale-lock recovery. Removing a token after another process has read
it is safe because server revocation remains authoritative.

### MVP local-security boundary

The portable filesystem selector protects against accidental credential
crossover between process trees. It is not a hardened boundary against a
malicious process running as the same OS user. Such a process may be able to
read or manipulate user-owned auth files or bypass `optctl` with a recovered
bearer token.

This limitation does not weaken server authentication: every HTTP request still
requires a valid server-issued token, and the server independently enforces the
principal, role, assignment boundary, policy, revocation state, and audit
provenance. Local process matching only chooses among credentials already issued
by the server.

Local credential custody and selection should sit behind an interface so a
hardened provider can be added without changing server auth semantics or CLI
commands. Conceptually:

```ts
interface LocalCredentialProvider {
  storeSession(input: IssuedSession, binding: ProcessBinding): Promise<void>;
  selectSession(context: ProcessContext): Promise<SelectedSession | null>;
  removeSession(sessionId: string): Promise<void>;
  cleanup(): Promise<CleanupResult>;
}
```

The MVP implementation is a user-owned filesystem provider. A post-MVP hardened
Linux provider may use a narrowly constrained one-shot sudo helper that owns
credentials, verifies the caller/process binding, and proxies or signs requests
without returning reusable bearer tokens. A daemon, root setup, sudo, setuid
helper, or OS keyring remains optional and is not required for MVP installation.

## Grant and authorization-session lifetime

The default local process grant binding lasts until the approved agent process
tree exits.

The local `optctl` credential-selection layer detects when the binding no longer
applies and prevents reuse by unrelated process trees. Automatic human and agent
session expiration is deferred for this implementation pass to avoid unfinished
renewal UX. Server sessions remain explicitly revocable, and `optctl` makes a
best-effort revocation during cleanup when possible. Recovery challenges retain
their explicit short one-time expiry.

Useful commands:

```bash
optctl auth status
optctl auth whoami
optctl auth revoke <authorization-id>
optctl auth cleanup
```

## Optional future local credential providers

A stronger no-root future option is a user-owned `operant-auth-agent` process,
similar to `ssh-agent` or `gpg-agent`. It could store secrets in memory and
expose local IPC:

- Unix: Unix socket under `$XDG_RUNTIME_DIR/operant/`.
- Windows: named pipe or background process equivalent.

This avoids persistent plaintext token files but adds installation, lifecycle,
and debugging complexity. It should not be required for the base install.

Install feasibility:

- Linux: `optctl auth agent install` could create a systemd user service when
  available.
- macOS: could install a LaunchAgent under `~/Library/LaunchAgents/`.
- Windows: likely requires named pipes plus startup task/background process.

## Bootstrap and installation workflows

### Bootstrap state

Authentication initialization has explicit server states:

- `bootstrap_required`: database has never completed auth initialization;
- `bootstrap_in_progress`: transient serialized transaction state;
- `active`: normal operation. Targeted recovery challenges may coexist with
  active operation and do not create a global recovery mode.

Runtime readiness is independent. `/ready` may be ready while a minimal
unauthenticated bootstrap-status endpoint reports only
`{"state":"bootstrap_required"}`. It exposes no database details, usernames,
secret values, or deployment paths.

Bootstrap never reopens because users/sessions are disabled or revoked, a token
reappears, or a password is forgotten. Only a database that has never completed
auth initialization may bootstrap. The last-active-human-super-admin invariant
prevents ordinary administration from creating that state.

### One environment-variable secret

All deployment modes use the same high-entropy one-time secret:

```text
OPTD_BOOTSTRAP_TOKEN
```

The server reads it from its environment and stores/compares only a digest.
`optctl bootstrap init` reads the matching value from its own environment; there
is no bootstrap-token CLI argument or file-specific workflow. Local shells,
Docker Compose, and Kubernetes may inject the variable through their normal
secret-management facilities. optd never generates or prints bootstrap
secrets in server logs.

The token is accepted only in `bootstrap_required`, compared in constant time,
and invalidated transactionally after successful use. A still-present
environment variable has no effect after activation. A failed transaction leaves
the token usable for retry.

Example local/packaged flow:

```bash
export OPTD_BOOTSTRAP_TOKEN='<high-entropy-secret>'
optd server start
optctl bootstrap init --username jordan
optctl auth whoami
```

Example container/remote flow:

```bash
# The server and operator environments receive the same secret value.
docker compose up -d

OPTD_BOOTSTRAP_TOKEN='<high-entropy-secret>' \
  optctl --server https://optd.example.com \
  bootstrap init --username jordan
```

`optd server start` means starting the local server process when that
packaging exists. Docker Compose, Kubernetes, the container entrypoint, a
compiled server, or `deno run src/main_server.ts` have identical bootstrap
semantics.

### Interactive initialization

`optctl bootstrap init --username <name>`:

1. Reads `OPTD_BOOTSTRAP_TOKEN` without displaying it.
2. Prompts for password and confirmation; passwords are never command arguments.
3. Shows that it will create the first human user with `system:super_admin`.
4. Requests `y/N` confirmation.
5. Sends the one-time token and initialization request over the configured
   server connection.

The server performs one serialized transaction under a database advisory lock:

1. Confirm `bootstrap_required` and verify the token.
2. Create the first human user and password authenticator.
3. Assign `system:super_admin` in the system boundary.
4. Mark bootstrap completed and invalidate the token digest.
5. Create a full human session and authorization-request session.
6. Write immutable bootstrap/auth audit records.
7. Commit and return both opaque tokens once.

Concurrent losing attempts return `bootstrap_already_completed`. `optctl` stores
the returned sessions, so bootstrap logs the user in and no immediate
`auth login` is needed.

### Recovery workflow

Ordinary bootstrap is never recovery. Recovery requires host/container/database
operator access to run the server binary with the installation's normal database
configuration. It is used for forgotten passwords, explicitly re-enabling a
disabled administrator, restoring a missing human super-admin after corruption,
or suspected credential compromise. Lost/corrupt local files with a known
password use `auth doctor` and normal login instead.

The operator creates a high-entropy environment value:

```bash
export OPTD_RECOVERY_TOKEN='<high-entropy-secret>'
optd auth recovery begin --username jordan
```

Optional, explicit repair flags are:

```bash
optd auth recovery begin --username jordan \
  --enable-user \
  --restore-super-admin
```

`recovery begin` acquires a database advisory lock, verifies the target user,
stores only the token digest, creates one targeted challenge with a 15-minute
lifetime, immediately revokes the target's human sessions, authorization-request
sessions, anchored agent authorizations, and pending auth requests, and writes
`auth.recovery.initiated`. One active challenge is allowed per target user.

The operator uses the same environment value from an operator-controlled client:

```bash
OPTD_RECOVERY_TOKEN='<same-secret>' \
  optctl --server https://optd.example.com \
  auth recover --username jordan
```

`optctl` explains the authorized recovery operations, prompts for and confirms a
new password, then asks `y/N`. In one transaction the server locks/verifies the
unexpired unused challenge, updates the authenticator, enables/restores
super-admin only when authorized at initiation, rechecks the
last-human-super-admin invariant, marks the challenge used, creates new full and
authorization-request sessions, writes `auth.recovery.completed`, and returns
the new tokens once. `optctl` stores them and activates the recovered origin's
context.

The installation remains active during targeted recovery; other users are not
disrupted. A lost completion response requires starting a new challenge, which
revokes the undelivered sessions. Operators may replace or cancel challenges:

```bash
optd auth recovery begin --username jordan --replace
optd auth recovery cancel --username jordan
```

Initiated, completed, cancelled, and expired outcomes are audited with target
human id, challenge id, timestamps, requested repair flags, system executor, and
outcome. Tokens, passwords, host identity, PID, cwd, command line, and
environment values are never stored. Recovery never reuses `bootstrap init` or
`OPTD_BOOTSTRAP_TOKEN`.

### Remote login

After bootstrap, `optctl auth login [--username]` works identically against a
local or `--server <url>` endpoint. Local process-tree token selection remains
on the client machine. The server sees only opaque credentials and server-needed
authorization/provenance data.

## CLI server/project contexts

Contexts are non-secret convenience configuration containing only a normalized
server origin and optional default project. They never contain/select users,
tokens, roles, bindings, or authorizations.

```bash
optctl context list
optctl context show
optctl context add prod --server https://optd.example.com --project sales
optctl context use prod
optctl context set-project delivery
optctl context remove old
```

Resolution precedence is explicit command flags, `OPTD_SERVER_URL` /
`OPTD_PROJECT`, active context, then packaged local defaults. Explicit
resource project and selected project must agree or return `project_conflict`.
Origins normalize scheme, lowercase hostname, effective port, trailing slash,
and IPv6 representation; origins contain no path/query/fragment. Credentials
never follow redirects to another origin.

Successful bootstrap automatically creates/updates and activates a context—no
confirmation. Loopback uses `local`, an explicit `--context` uses that name, and
remote origins otherwise use the normalized hostname with deterministic
collision handling. The project remains unset until one exists; creation of the
first project may set it automatically only when the context has no default.

## CLI input and diagnostics

Input policy is resolved once per invocation. Prompting is allowed only when
stdin is a terminal and not supplying command data, `--json` and
`--non-interactive` are absent, `OPTD_NON_INTERACTIVE` is unset, and the
command explicitly permits the prompt. Permission repair prompts at most once
per invocation and never retries. Ordinary object/query/changeset commands never
request passwords or approval.

```bash
optctl --non-interactive ...
OPTD_NON_INTERACTIVE=1 optctl ...
```

`optctl auth doctor` inspects only local auth/context state by default: root
ownership/type/modes/symlinks; versioned record schemas; token/session/binding
reference consistency; process-anchor liveness and PID reuse; orphan tokens,
temporary files, and stale locks; normalized origin partitions; and active
context validity. Optional online checks read server/session status.

`optctl auth doctor --fix` may tighten current-user-owned permissions, create
safe missing directories, quarantine malformed metadata, remove stale temp/lock
and dead-binding records, remove confirmed orphan records, and normalize context
origins. It never changes ownership, follows/replaces symlinks, resets
passwords, assigns roles/policies, repairs Postgres, revokes another principal,
or silently deletes the only usable credential. Risky fixes produce one
plan/confirmation; `--fix --yes` supports noninteractive repair.

## Metadata to store

### Server-side tables / records

`auth_bootstrap_state`

- singleton installation/auth schema id
- `state`: bootstrap_required/active
- `bootstrap_token_digest` nullable
- `completed_at` nullable
- `completed_by_human_user_id` nullable
- `updated_at`

`auth_human_users`

- `id`
- `username`
- `display_name`
- `password_hash` Argon2id PHC string
- `password_profile`
- `password_changed_at`
- `status`: active/disabled
- `created_at`, `updated_at`, `last_login_at`

`auth_login_throttles`

- `username_key`
- `consecutive_failures`
- `next_attempt_at`
- `updated_at`

`auth_password_reset_requests`

- `id` random/unenumerable
- `human_user_id` nullable internally for non-enumerating unknown-user requests
- `idempotency_key`
- `redemption_nonce_hash`
- `reason`
- `status`: pending/approved/denied/cancelled/redeemed/completed/expired
- `approved_by_principal_id`, `denied_by_principal_id`
- `created_at`, `expires_at`, `redeemed_at`, `completed_at`

`auth_password_reset_capabilities`

- `id`
- `request_id`
- `capability_digest`
- `status`: active/used/revoked/expired
- `created_at`, `expires_at`, `used_at`

`role_definitions`

- `id`
- `publisher` and `pack` nullable for built-in system roles
- `name`
- `canonical_id`: e.g. `optd/crm:sales_manager` or `system:admin`
- `display_name`
- `description`
- `source`: system/pack/local
- `introduced_by_pack` nullable
- `status`: active/deprecated/disabled
- `axi_summary`
- `axi_verbose_guidance_json`
- `metadata_json` for future system-resource fields
- `created_at`, `updated_at`

`role_assignments`

- `principal_type`
- `principal_id`
- `role_id`
- `boundary_type`: project/all_projects/system
- `project_id` present only for project boundary

`can_grant` is derived from active policy evaluation of `auth.request.decide`;
it is not stored as an independent delegation assignment.

- `created_at`, `created_by_auth_context_id`

`auth_sessions`

- `id`
- `principal_type`: human_user/agent_user/authorization_request/system
- `human_user_id`
- `agent_user_id` nullable
- `token_hash`
- `status`: active/revoked/expired
- `created_at`, `revoked_at`, `last_used_at`
- `expires_at` nullable and unset for human/agent sessions in this pass;
  reserved for a future complete expiry/renewal design
- `request_metadata_json`

For `agent_user` rows, this is the authoritative **agent authorization
session**. It stores approved role/project authority directly or references a
normalized server-side authorization binding. It does not store an authoritative
PID/process-tree constraint.

`auth_contexts`

- `id`
- `request_id`
- `principal_type`: human_user/agent_user/system
- `principal_id`
- `human_user_id` nullable for system principals
- `agent_user_id` nullable
- `auth_session_id` nullable for internal system execution
- `authorization_id` nullable
- `root_authorization_id` nullable
- `credential_kind`: human_session/agent_authorization/authorization_request/
  password_login/internal
- `auth_method`: bearer/password/internal
- `created_at`

Auth contexts are immutable server-derived credential snapshots. Bounded roles
are stored in
`auth_context_role_assignments(auth_context_id, role_id,
boundary_type, project_id)`.
Contexts do not require one target boundary; audit policy summaries record
per-operation boundary decisions for multi-project changesets.
Authorization-request credentials use the associated human principal, credential
kind `authorization_request`, and no role rows. Contexts contain no local
process/client fingerprinting fields.

`auth_agent_requests`

- `id`
- `human_user_id`
- `requested_role_ids`
- `boundary_type`: project/all_projects/system
- `project_id` present only for project boundary
- `reason`
- `status`: pending/approved/denied/invalidated
- `agent_reported_metadata_json` with only the typed optional fields
- `idempotency_key`
- `redemption_nonce_hash`
- `created_at`, `approved_at`, `denied_at`, `redeemed_at`
- `approved_by_principal_id`
- `denied_by_principal_id`
- `denial_reason`

`auth_agent_authorizations`

- `id`
- `auth_session_id`
- `human_user_id`
- `agent_user_id`
- `request_id`
- bounded role assignments in normalized child records
- `friendly_name`
- `agent_reported_metadata_json`
- `supersedes_authorization_id` nullable
- `status`: active/revoked/expired
- `created_at`, `revoked_at`, `last_used_at`
- `approved_by_principal_id`
- `displayed_role_definition_versions_json`
- `displayed_policy_definition_versions_json`
- `capability_summary_digest`
- `request_metadata_json` for non-process workflow metadata needed for approval
  and audit

This is server authorization state, not the `optctl` process grant. It must not
claim to enforce a local process tree.

`auth_agent_authorization_roles`

- `authorization_id`
- `role_id`
- `boundary_type`: project/all_projects/system
- `project_id` present only for project boundary
- `source_request_id`

`auth_recovery_challenges`

- `id`
- `human_user_id`
- `token_digest`
- `status`: active/used/cancelled/expired
- `enable_user` boolean
- `restore_super_admin` boolean
- `created_at`, `expires_at`, `used_at`, `cancelled_at`
- one active challenge per target user

### Local filesystem metadata

Local request files and process grant binding files should include only what
`optctl` needs for credential selection and UX:

- local binding id
- exact normalized server origin and optional diagnostic installation id
- human user id/username for the authorization-request credential
- server request id / authorization session id
- token path
- process binding metadata
- friendly agent name
- canonical role id and assignment boundary
- created/approved timestamps
- non-secret summaries

Avoid storing full command lines if they may contain secrets. Store redacted
command summaries.

## Provenance

Audit/provenance separates human user, agent user, server authorization session,
and effective roles instead of flattening everything into one `actor_id`. Agent
work is still ultimately anchored to the human user's authority, but audit shows
which agent user performed the work.

The server never receives or stores local PID, ancestry, cwd, OS username,
hostname, executable/command summary, local binding id, model/harness metadata,
or other inferred process evidence. Those remain exclusively in `optctl`'s local
store. Intentional workflow input such as requested roles/boundary, reason, and
friendly agent name remains on auth request/authorization records.

Each authenticated HTTP request creates one immutable `auth_contexts` row with
explicit principal, anchoring-human, agent, session, authorization-chain,
boundary, and effective-role fields. Audit and committed records reference that
context as defined in [Events and Audit](events-audit.md).

## Executable authentication prototype

`prototypes/authentication/` exercises the proposed public lifecycle in an
isolated Hono server: one-time bootstrap, Argon2id login, retained/issued
request credentials, idempotent multi-role requests, approval without token
disclosure, requester nonce redemption, multi-project replacement authorization,
per-project role use, agent-to-subagent approval and chain invalidation, denial
without escalation suggestions, self-revocation, password-confirmed logout-all,
targeted recovery, stable errors, and auth contexts without process evidence.

Observed evidence:

```text
2 passed | 0 failed
AUTH_FLOW_COMPILED_PASS
```

`@node-rs/argon2` works under Deno and compiled Linux binaries. The validated
Argon2id baseline is 19,456 KiB memory, time cost 2, parallelism 1, and 32-byte
output in salted PHC strings. The password policy, throttling, and immediate
saturation behavior above are normative for implementation.

The prototype caught one important lineage rule: replacement authorization must
preserve the superseded authorization's parent/root delegation chain rather than
making the now-deactivated superseded authorization its own parent.

## Frozen implementation-pass boundaries

- Human sessions have no automatic absolute or idle expiration in this pass;
  explicit logout, password reset, disablement, recovery, and revocation remain
  effective. Expiration UX is deferred.
- Boundary capability summaries are computed from active policy assignments and
  exact role assignments, preserve conditional labels, and combine authored role
  `axi` guidance without turning role definitions into permission lists.
- Auth storage uses the normalized records/table shapes defined throughout this
  spec and
  [Authorization Definitions and Assignments](authorization-assignments.md). The
  implementation plan must order migrations by foreign-key dependency:
  principals/users and roles/policies, credentials/sessions, assignments,
  authorization chains/tokens, requests/decisions/watch tickets, auth contexts,
  then reset/recovery records. No old database compatibility is required.
- Server-generated opaque auth/session/request IDs are UUIDv7. Friendly names
  are explicit requester/operator metadata; core auth does not inspect or infer
  agent harness/model identity.
