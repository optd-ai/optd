# Authorization Definitions and Assignments

## Decision

Operant separates reusable authorization definitions from the boundaries where
they apply:

1. Role definitions are globally registered.
2. Policy definitions are globally registered.
3. Role assignments grant a principal a role in an explicit boundary.
4. Policy assignments activate a policy in an explicit boundary.
5. Agent authorizations carry the same explicit boundary.
6. An omitted boundary is invalid and never implies global authority.

This avoids cloning definitions into every project while preventing accidental
system-wide access.

## Boundary model

Every assignment uses exactly one boundary variant:

```yaml
boundary:
  type: project
  project_id: 019b7a2e-7c10-7000-8000-000000000001
```

```yaml
boundary:
  type: all_projects
```

```yaml
boundary:
  type: system
```

The variants have distinct meanings:

- `project` applies only to one runtime project.
- `all_projects` applies to project-resource operations in every project.
- `system` applies to operations without a project target, such as managing
  projects, users, policy assignments, or bootstrap recovery.

System authority does not imply all-project authority, and all-project authority
does not imply system authority. Creating `system` or `all_projects` assignments
requires explicit elevated authorization.

## Role definitions

A role definition is a globally registered identity for a responsibility. It
does not contain an `allow` list and does not grant authority by itself.

```yaml
kind: Role
apiVersion: operant.dev/v1
metadata:
  name: sales_manager
spec:
  display_name: Sales Manager
  description: Manages CRM leads and opportunities.
  axi:
    summary: Appropriate for CRM management agents.
```

Canonical pack role identity:

```text
operant/crm:sales_manager
```

Built-in platform roles use a reserved system identity:

```text
system:super_admin
system:admin
```

The role identity remains stable across every project boundary; packs are
installed globally rather than per project.

## Policy definitions

A policy definition is globally registered authorization logic. It references
canonical role and pack-definition identities rather than one particular project
installation.

```yaml
kind: Policy
apiVersion: operant.dev/v1
metadata:
  name: sales_access
spec:
  default_assignment: all_projects
  rules:
    - name: manager_access
      effect: allow
      roles: ["operant/crm:sales_manager"]
      actions: [read, create, update, transition]
      resources:
        - "operant/crm:lead"
        - "operant/crm:opportunity"
      where: "true"
    - name: manager_convert
      effect: allow
      roles: ["operant/crm:sales_manager"]
      actions: ["action:operant/crm:convert_lead"]
      resources: ["operant/crm:lead"]
```

Canonical policy identity:

```text
operant/crm:sales_access
```

Pack source may use unambiguous pack-relative references such as `sales_manager`
and `lead`. Validation canonicalizes them before storage and fails on undeclared
or ambiguous references.

A policy definition grants nothing until an active policy assignment selects it
for a boundary.

## Role assignments

A human role-assignment creation request is sent under the target user route;
principal comes from the path and body is exactly one role plus canonical
boundary:

```json
{
  "role": "operant/crm:sales_manager",
  "boundary": {
    "type": "project",
    "project_id": "019b7a2e-7c10-7000-8000-000000000001"
  }
}
```

Other exact boundary variants are `{ "type": "all_projects" }` and
`{ "type": "system" }`. A project assignment grants no authority in another
project; all-project authority does not imply system authority and vice versa.

The server creates a UUIDv7 assignment with immutable principal/role/boundary/
creator content and separate active/disabled lifecycle. Deactivation retains
audit evidence. Role definitions must be currently active and boundary type must
be compatible with the role/policy model. Agent role assignments are embedded
in immutable authorization records created/replaced only by the auth request
flow, not these human-user administration routes.

Human assignment create/deactivate requires `role.assignment.manage` in the
assignment boundary and the exact target role currently effective for the
administrator in that boundary, preventing authority creation.
`system:super_admin` bypasses role-possession policy but remains subject to the final-active-human
super-admin invariant. Assigning/removing `system:super_admin` itself requires an
active super-admin; the transactional final-active-human invariant still applies.

## Grant permission

Grantability is not a separate role list or delegation resource. Policy-derived
`auth.request.decide` is the actor's `can_grant` capability. An actor with that
capability may approve or deny requests for any roles currently in the actor's
effective role set in the requested boundary. Holding a role without
`auth.request.decide` does not permit granting it.

`auth.request.decide` permits both approval and denial; separate approve/deny
capabilities are not defined. Approval additionally requires that every
requested role is currently effective for the approver in the requested
boundary. Denial transfers no authority but remains limited to requests visible
to the actor under active policy assignments.

Before confirmation, the server returns role guidance and a boundary-specific,
deduplicated capability explanation derived from active policy assignments.
Approval audit snapshots displayed role-definition versions, policy-definition
versions, and the capability-summary digest. See
[Authentication](authentication.md) for the full summary contract.

A `system:super_admin` bypass includes these approval role-possession checks and
may grant any role; assigning `system:super_admin` still requires an active
super-admin and the last-human-super-admin invariant below.

The request recipient must be another agent authorization anchored to the same
human user. This is not cross-user role administration: an auth grant delegates
use of the anchoring human user's own login authority. Assigning roles to a
different human user is a separate administrative workflow.

## Agent authorizations

One server-side agent authorization represents the agent's complete currently
approved authority and may carry role assignments in multiple boundaries:

```yaml
role_assignments:
  - role: operant/crm:sales_manager
    boundary:
      type: project
      project_id: 019b7a2e-7c10-7000-8000-000000000001
  - role: operant/projects:viewer
    boundary:
      type: project
      project_id: 019b7a2e-7c10-7000-8000-000000000002
  - role: system:admin
    boundary:
      type: system
```

A single auth request may request multiple roles under one boundary and approval
is all-or-nothing. Adding approved roles creates a replacement authorization
containing the prior still-valid assignments plus the new assignments. The new
token supersedes the prior local process binding; one process anchor has one
current authorization token.

`optctl` never chooses among authorizations based on roles or target project. It
walks ancestry, selects the nearest binding, and sends that one token. The
server computes effective roles from the authorization's assignments for each
request or changeset operation boundary. Insufficient authority fails normally;
the CLI never searches other bindings, combines tokens, or falls back to broader
ancestors.

When an upstream actor loses one role, downstream authorizations continue with
their still-valid roles and report the removed role through auth status. The
server checks the authorization chain when used and returns specific invalid
ancestor/role errors; eager cascading revocation is not required.

The server authorization controls role/project authority. The local `optctl`
process binding separately controls which local process tree may select and use
the server-issued token. See [Authentication](authentication.md).

Delegation chains are supported. Each authorization records its anchoring human,
immediate approver, parent authorization where applicable, and root
authorization. Every use validates the chain. An agent may approve a descendant
request with no special-case logic when it has `auth.request.decide`, holds all
requested roles in the boundary, and remains anchored to the same human user.

## Super-admin invariant

`system:super_admin` is a built-in role. An authenticated principal with an
active super-admin assignment/authorization bypasses authorization-policy checks
but not authentication, session validity, structural validation, or audit. Human
and agent principals may hold it; there is no agent-specific exception.

Through normal authenticated APIs, only an active super-admin may assign/grant
`system:super_admin` or remove it from another principal. The server rejects,
transactionally, any ordinary role removal, human disablement, or mutation that
would leave no active human user assigned `system:super_admin`; concurrent
mutations lock/check this invariant. Bootstrap creates the first human
super-admin.

The host-operator recovery maintenance command is not a principal or policy
bypass available through HTTP. Possession of server/database operator access may
create a narrowly targeted, one-time audited recovery challenge that explicitly
authorizes restoring super-admin to one existing human user. This is the only
exception and exists specifically to recover from corruption/manual intervention
that violated the normal invariant. All bypasses and super-admin changes are
audited.

## Policy assignments

A policy assignment activates a globally registered policy definition in exactly
one boundary.

### Pack default all-project policy assignment

A pack Policy with `spec.default_assignment: all_projects` creates/activates one
server-generated assignment bound to that exact policy/pack revision during
transactional pack activation. `none` creates no default assignment. Pack source
cannot default-activate system or one-project authority. Preview surfaces this
security-relevant change.

The generated assignment uses a UUIDv7, canonical `{type: all_projects}`
boundary, source pack/policy revision UUIDs, activation auth context, and active
timestamps. This does not grant any principal a role. Project-specific role assignments
still determine who has CRM authority in each project. Explicit project policy
assignments may configure exceptions/additional policy but never install another
pack copy or version.

### System policy assignment

Built-in `system:*` policy definitions/assignments are created by platform
migrations. Additional explicit system assignments use the administrative API
below and an exact `{type: system}` boundary. Global activation is possible only
through explicit `all_projects` or `system` assignments. Missing boundary data must fail validation.

## Authorization evaluation

Every protected operation has an explicit target boundary. A project-resource
request includes both its runtime and source-definition identity:

```json
{
  "project_id": "019b7a2e-7c10-7000-8000-000000000001",
  "resource_definition": "operant/crm:lead",
  "object_id": "019b7a2e-7c10-7000-8000-000000000002",
  "action": "update"
}
```

Evaluation proceeds as follows:

1. Resolve the authenticated principal and server authorization session.
2. Resolve active role assignments or agent-authorization roles matching the
   principal and target boundary.
3. Find active policy assignments matching the target boundary.
4. Evaluate rules in those policy definitions for the assigned roles, action,
   and source resource definition.
5. Apply ABAC and one-hop ReBAC predicates against the runtime object/context.
6. Deny when no complete match exists.

Conceptually:

```text
principal has role in target boundary
AND policy is active in target boundary
AND policy allows role + action + resource definition
AND ABAC/ReBAC predicates pass
```

A project assignment cannot activate system authority. A system assignment
cannot silently imply all-project access.

## Pack installation and upgrades

Previewing local source for `operant/crm@0.1.0` creates the exact durable
migration plan/candidate revision; applying that plan transactionally activates
server-wide resource/action/hook/lifecycle, role, policy, seed, and default
policy-assignment definitions. It must not automatically
assign domain roles to principals.

Exactly one revision of a pack is active globally. Definitions are
versioned/content-addressed for audit and preview equivalence, but projects
cannot select different versions. A pack upgrade atomically updates the
server-wide active revision and all projects use the new definitions after
successful migration.

Whole-pack uninstall is not an MVP route. A future uninstall must deactivate
default policy assignments, retain historical definitions/audit references,
detect dependent active role assignments, and never redirect authority.

## Policy-assignment administration

Pack-declared default policy assignments are activated/deactivated atomically
with their exact pack revision. Additional operator assignments have immutable UUIDv7 identity/content (exact
policy-definition revision, one boundary, creator auth context/time) plus a
separate active/disabled lifecycle projection and append-only disable audit.
Policy/boundary never change in place; disable the old assignment and create
another.

```text
GET  /api/v1/policy-assignments
POST /api/v1/policy-assignments
POST /api/v1/policy-assignments/{assignment_id}/disable
```

Creation contains exact `policy_revision_id` plus one canonical boundary. List
is cursor-paginated and filterable by active status, policy identity, and
boundary. Disable accepts expected active/version state and is idempotent after
success. The exact system capability is `policy.assignment.manage`; ordinary
pack roles cannot self-activate policy. Every mutation is audited.

```text
optctl policy assignment list
optctl policy assignment create --policy-revision <uuid> --boundary <json>
optctl policy assignment disable <assignment-id>
```

There is no public role-definition mutation endpoint: built-in roles are
platform migrations and pack roles are pack revisions. Human role assignments
use the user routes in `auth-api.md`; agent assignments use the auth
request/replacement-authorization flow.

## Persistence model

Suggested conceptual records:

- `role_definitions`
- `policy_definitions`
- `role_assignments`
- `policy_assignments`
- `agent_authorizations`

Assignments store a structured boundary discriminator and fields rather than
encoding all authority into dotted strings. Canonical strings are API/CLI
identifiers.

## Vocabulary

| Term                  | Meaning                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| Role definition       | Globally registered responsibility identity                             |
| Policy definition     | Globally registered authorization logic                                 |
| Role assignment       | Principal holds a role in a project, all projects, or system boundary   |
| Policy assignment     | Policy is active in a project, all projects, or system boundary         |
| Agent authorization   | One server-issued token containing the agent's bounded role assignments |
| Local process binding | `optctl` process tree allowed to use the authorization token            |
