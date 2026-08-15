<!-- generated-by: pi-dag-workflow/project-model; view: view-identity-auth; contract: 1; input: sha256:fea65839e05a1de23f1cf56df2e0c49f034ec83581299bec1d45ac5238ba3e39 -->

# Identity, authentication, and authorization

Canonical identity, authentication, and authorization decisions and contracts projected from project-model/model.json.

## Outcomes and intent

<a id="obj-int-correctness"></a>

### Prefer correctness, least authority, and durable evidence

Authenticate every request, derive authority server-side, fail closed on ambiguity, make writes reviewable and atomic, and preserve immutable audit/history evidence.

<a id="obj-int-local-binding-boundary"></a>

### Do not overstate local credential security

Portable filesystem/process binding prevents accidental credential crossover, not malicious same-OS-user compromise; server authentication remains real and a hardened local provider is deferred.

## Concepts

<a id="obj-con-principal-context"></a>

### Principal and auth context

Opaque credentials resolve to immutable server auth contexts that distinguish authenticated principal, anchoring human, optional agent, session, authorization lineage, roles, and boundary.

<a id="obj-con-agent-authorization"></a>

### Agent authorization lineage

A request/approval/redemption/delegation/replacement/revocation lineage anchored to one human; the agent principal acts while the server-derived human anchor remains policy context.

<a id="obj-con-role-policy-boundary"></a>

### Role/policy assignment boundary

Global role and policy definitions grant nothing by themselves. Assignments and authorizations carry exact Project, all_projects, or isolated system boundaries.

## Scenarios

<a id="obj-scn-bootstrap"></a>

### Bootstrap a fresh installation

A new single-tenant server has no human users. The operator supplies the bootstrap secret, creates the first human, logs in from a separate process tree, and creates a Platform Project. Exactly one active super-admin remains, opaque sessions are stored server-side, local bindings are private, and caller actor headers have no authority.

**Context.** A new single-tenant server has no human users.

**Action.** The operator supplies the bootstrap secret, creates the first human, logs in from a separate process tree, and creates a Platform Project.

**Expected outcome.** Exactly one active super-admin remains, opaque sessions are stored server-side, local bindings are private, and caller actor headers have no authority.

<a id="obj-scn-agent-grant"></a>

### Agent requests and redeems bounded authority

An agent process has only request/discovery authority. It discovers roles, requests roles in one boundary, waits; an authorized same-anchor actor approves; the agent redeems and continues. The nearest binding selects the new opaque agent credential; actor.id is the agent and actor.human_user_id is the anchoring human.

**Context.** An agent process has only request/discovery authority.

**Action.** It discovers roles, requests roles in one boundary, waits; an authorized same-anchor actor approves; the agent redeems and continues.

**Expected outcome.** The nearest binding selects the new opaque agent credential; actor.id is the agent and actor.human_user_id is the anchoring human.

<a id="obj-scn-revocation"></a>

### Revocation takes effect without credential fallback

An active agent authorization is revoked while the process remains alive. The agent issues another command. The server denies it with stable authentication/authorization error and optctl does not search ancestors for broader credentials.

**Context.** An active agent authorization is revoked while the process remains alive.

**Action.** The agent issues another command.

**Expected outcome.** The server denies it with stable authentication/authorization error and optctl does not search ancestors for broader credentials.

## Decisions

<a id="obj-dec-opaque-auth"></a>

### Use opaque server-issued credentials only

The server accepts opaque credentials and derives actor, roles, boundaries, lineage, and auth context. Caller headers/body cannot supply actor or role authority.

<a id="obj-dec-nearest-process-binding"></a>

### Select exactly the nearest verified process binding

Local optctl walks verified ancestry and selects the nearest binding only; it does not credential-shop or fall back after permission denial, and the server never receives process evidence.

<a id="obj-dec-human-agent-lineage"></a>

### Preserve agent principal and anchoring human

For agent credentials actor.id is the agent principal and actor.human_user_id is the non-null server-derived anchoring human. Generic policy decides who may approve or grant.

<a id="obj-dec-global-definitions-bound-assignments"></a>

### Keep role/policy definitions global and authority boundary on assignments

Roles and policies are global definitions. Role assignments, policy assignments, and agent authorizations carry exact Project, all_projects, or system boundaries; only validated system:super_admin bypass crosses boundaries.

<a id="obj-dec-policy-model"></a>

### Use allow-only RBAC/ABAC and one-hop ReBAC

Policy uses structured allow rules and the fixed CEL subset; direct one-hop same-Project relationships may target system:principal; deep traversal and actor arrays are unsupported.

<a id="obj-dec-auth-admin-routes"></a>

### Align human-user administration routes with the implemented lifecycle API

The v1 human-user administration API lists and creates users, patches user status, lists and creates role assignments, and disables a role assignment with POST /api/v1/auth/users/:user_id/role-assignments/:assignment_id/disable plus a positive integer expected_version. V1 has no single-user GET and no DELETE compatibility alias.

**Rationale.** The Hono API, compiled CLI, concurrency controls, and E2E tests already agree. POST-disable carries expected-version state and preserves audited lifecycle semantics; there is no deployed compatibility requirement.

<a id="obj-dec-agent-request-cancellation"></a>

### Keep requester cancellation in the agent authorization lifecycle

A requester may cancel its own pending agent authorization request. Cancellation is terminal, audited, wakes connected waiters through the Postgres-backed status path, and produces no authorization session.

**Rationale.** The specific API, repository lifecycle, CLI, and tests already implement safe cancellation.

<a id="obj-dec-reset-id-nonce"></a>

### Separate password-reset identity from proof-of-possession entropy

Password-reset request IDs are opaque server UUIDv7 workflow identities, not secrets. The client-generated private redemption nonce has at least 128 bits of cryptographic entropy and only its hash is sent; redemption requires nonce possession in addition to the exact request workflow.

**Rationale.** This matches source and preserves non-enumeration without falsely assigning 128 random bits to UUIDv7.

## Commitments

<a id="obj-com-auth-me"></a>

### Expose one canonical current-identity DTO

/api/v1/auth/me returns credential_kind, explicit principal, human_user, optional agent, role_assignments, session_id, and auth_context_id, with no contradictory top-level aliases.

<a id="obj-com-auth-request"></a>

### Support bounded multi-role agent request/approval/redemption

A request credential may discover/request one or more roles in one boundary. A same-human authorized actor decides; the requester waits via reconnectable WebSocket and redeems its private nonce. Delegation, replacement, revocation, and root lineage are validated server-side.

<a id="obj-com-human-session"></a>

### Keep human sessions explicit and revocable

Human login requires password and binds a full opaque session locally; sessions have no automatic expiry in this pass; reset/recovery revoke affected sessions; logout revokes server and local state.

<a id="obj-com-project-boundary"></a>

### Enforce Project lifecycle and authority

Project-scoped writes and actions require active exact Project authority; archived Projects reject new writes but retain authorized reads/history and already-enqueued delivery. all_projects inheritance is explicit; ordinary system authority is isolated.
