<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-policies; contract: 1; input: sha256:76174b92d7472c76c88cf8238db30422f98cdef84844a37fc771312bf09f6fd1 -->

# Policies and Authorization

Generated exact-contract projection imported into project-model/model.json from the reviewed policies.md source.

## Exact migrated contract

<a id="obj-com-exact-policies-v1"></a>

### Exact v1 contract — Policies and Authorization

**Migration provenance.** Exact normative contract imported from `spec/policies.md` at `sha256:2dd369390e59a5c850d73bc49fd9ecbbcbbcf17823aaba91ba08d67cc320f520`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Definition and assignment model

Role and policy definitions are globally registered, while explicit assignments
control where they apply. Role assignments, policy assignments, and agent
authorizations must select exactly one `project`, `all_projects`, or `system`
boundary. Missing boundary never implies global authority. See
[Authorization Definitions and Assignments](authorization-assignments.md) for
the normative model.

## Deployment Constraint

The policy system must preserve simple horizontal scaling:

- App nodes are stateless or safely cacheable.
- Postgres is the only required coordination point for horizontally scaled
  deployments.
- App-managed local Postgres covers the default single-node deployment.
- No correctness-critical coordination between app nodes.
- Any distributed cache or queue is optional, not required for authorization
  correctness.

## Capability explanations

The server computes role capability explanations for one explicit target
boundary from globally registered role/policy definitions and active policy
assignments. Role `axi` describes authored intent; policy structure remains
authoritative. Policy rules may provide explanatory `axi.summary` text.

Structured explanations classify each resource/action capability as
unconditional, ABAC-conditional, or ReBAC-conditional and retain policy/rule ids
and versions. Conditional access must never be flattened into unconditional
claims. `optctl` formats this server response and does not independently
interpret policy. See [Authentication](authentication.md) for role-listing and
approval UX.

## Semantic operations and hook effects

Policy authorizes the user-visible operation/action. Reviewed hook/action effect
declarations are enforced through invocation-bound internal capabilities; the
initiator does not separately need raw permissions for every implementation
effect. Stage validates all synchronous effects and returns non-committable on
undeclared/unavailable capability. System hook executors never imply
super-admin. Authorization denials explain current roles/boundary/failed
capability without recommending escalation.

For multi-project changesets, the server resolves one token and computes the
actor's effective bounded roles plus active policies independently for every
operation/project. The whole changeset remains atomic.

## Authorization Questions

Every action should answer:

- Who is the actor?
- What action is being attempted?
- Which object(s), type(s), fields, relationships, and lifecycle transitions are
  affected?
- What ownership or relationship context matters?
- Is approval required even if the action is allowed?
- What evidence explains the decision?

## RBAC

Role-Based Access Control grants permissions through roles such as admin,
manager, agent, viewer, owner, or approver.

### Pros

- Simple mental model.
- Easy to administer and audit.
- Works well for coarse product permissions.
- Can be represented in Postgres tables and evaluated locally.
- Good default for early product versions.

### Cons

- Can become role explosion when conditions vary by object state, owner,
  department, region, or transition.
- Poor at context-heavy rules like “can transition if owner and deal value <
  threshold.”
- Often needs exceptions, which erode simplicity.

### Fit

RBAC should likely be the base layer: roles grant broad capabilities on object
types and actions.

## ABAC

Attribute-Based Access Control evaluates rules over actor, object, action,
environment, resource configuration, lifecycle state, and relationship
attributes.

### Pros

- Expressive for ownership, lifecycle state, object value, department, region,
  risk score, approval state, script-derived facts, etc.
- Better fit for AI-agent operations because actions need contextual
  allow/deny/approve decisions.
- Reduces role explosion.

### Cons

- Harder to explain and debug.
- Rule authoring can become dangerous if too flexible.
- Requires disciplined policy testing and decision logging.
- Attribute freshness matters.

### Fit

ABAC should likely complement RBAC for contextual constraints. Avoid making
arbitrary user-authored code part of the initial trusted policy path.

## ReBAC / Relationship-Based Access

Relationship-based access checks permissions through graph relationships: user
is member of team, team owns project, project contains task, etc.

Hard v1 constraint: ReBAC is limited to one relationship hop. If users need
deeper transitive access, they should denormalize or link the relevant object
directly so policy can use a one-hop relationship.

### Pros

- Natural for collaboration products.
- Models sharing, ownership, team membership, object hierarchies, and delegated
  access.
- Can be backed by Postgres relationship tables for initial simplicity.

### Cons

- Deep graph traversal can become complex and expensive.
- Systems like Zanzibar/Authzed/SpiceDB are powerful but add operational
  complexity.

### Fit

Start with one-level relationship checks in Postgres. Defer dedicated graph
authorization infrastructure unless scale or sharing complexity demands it.

## Frozen implementation direction

optd does not require Ory, OAuth/OIDC/JWT validation, an identity proxy, or a
separate graph/policy service in MVP. All environments use the same built-in
opaque-token authentication contract. Future identity-provider integration must
exchange into server-issued optd sessions rather than creating a second route
auth mode.

RBAC, ABAC, and one-hop ReBAC are complementary inputs to one deterministic
internal policy evaluator:

- RBAC selects exact role/action/resource candidates from active definitions and
  assignments in the target boundary.
- ABAC constrains candidates through the frozen CEL subset over object fields
  and immutable `actor.id|principal_type|human_user_id`.
- ReBAC adds at most one direct typed relationship from the protected object to
  built-in `system:principal` matched by actor/human ID.

Policy definitions are strict pack YAML and grant nothing until an active policy
assignment selects a boundary. Caller roles/actor attributes are never input.
Approval requirements come from trusted validation-hook output and use their
separate contract; policy controls who may decide.

## Enforcement points

- Protected system API admission uses exact dotted system capabilities.
- Direct stage evaluates each operation/project; action/seed stage evaluates its
  exact semantic permission and reviewed effect manifest.
- Commit rechecks current authorization in one SQL-statement snapshot under the
  canonical locks.
- Query/search/history lower policy predicates into SQL before keyset sorting,
  limiting, and counting.
- Outbox execution uses pinned internal capability plus current global hook
  runtime policy; initiating roles are not re-evaluated.

Postgres constraints preserve structural/race invariants, while application
services own action/context policy. Postgres RLS is not required for MVP and no
application post-filter pagination is permitted.

## Frozen v1 schema/evidence

- [MVP Policy Schema](mvp-policy-schema.md) owns exact structured YAML, action
  vocabulary, actor/boundary context, assignment, and safe denial format.
- [Expression Language](expression-language.md) owns the non-extensible CEL
  subset and typed SQL lowering.
- [Authorization Definitions and Assignments](authorization-assignments.md) owns
  global definition and explicit boundary assignment semantics.
- Existing PGlite policy prototypes remain expression/evaluator evidence only;
  real-Postgres integration tests are authoritative for SQL/pagination/commit
  behavior.
