# Policies and Authorization

## Deployment Constraint

The policy system must preserve simple horizontal scaling:

- App nodes are stateless or safely cacheable.
- Postgres is the only required coordination point for horizontally scaled
  deployments.
- App-managed local Postgres covers the default single-node deployment.
- No correctness-critical coordination between app nodes.
- Any distributed cache or queue is optional, not required for authorization
  correctness.

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

## Ory

Ory is an ecosystem rather than one thing:

- Ory Kratos: identity and user management.
- Ory Hydra: OAuth2/OpenID Connect provider.
- Ory Keto: relationship-based permissions inspired by Zanzibar.
- Ory Oathkeeper: identity-aware proxy.

### Pros

- Strong identity/auth ecosystem.
- Can avoid building login, OAuth/OIDC, session, and relationship permission
  systems from scratch.
- Keto is relevant for ReBAC.

### Cons

- Adds multiple services and operational concepts.
- May conflict with “simple deployment” if all components are required.
- Keto/relationship checks can become another coordination dependency unless
  carefully backed and deployed.
- The platform still needs domain-specific policy decisions beyond identity.

### Fit

Use OIDC/JWT compatibility so Ory, Auth0, Clerk, WorkOS, Cognito, or enterprise
IdPs can integrate. Do not require Ory for the core deployment. Ory may be a
supported integration or optional deployment profile, not a mandatory
dependency.

## Recommended Initial Direction

Use a small internal expression model intentionally designed for SQL lowering.

RBAC, ABAC, and ReBAC are not separate engines. They are complementary inputs to
one authorization decision:

- RBAC: actor roles grant broad capabilities.
- ABAC: actor/object/action attributes constrain those capabilities.
- ReBAC: shallow relationships connect actors to objects.

Read/query policies must compile to SQL predicates so filtering happens before
pagination. The same rule should also be runtime-evaluable for changeset
preview/commit on known objects. Pagination should never page first and
post-filter afterward, because that creates unstable page sizes and unreliable
cursors for agents.

Executable prototype evidence lives in `prototypes/policies/`. It validates 20
RBAC-style, 20 ABAC-style, and 20 one-level ReBAC-style policy combinations
against PGlite, checking SQL-pushdown results against runtime evaluation.

1. **Authentication:** Support a simple local auth mode plus external OIDC/JWT
   identity. Do not require a heavyweight identity provider.
2. **Membership:** Store users, service-agent identities, roles, groups, and
   ownership relationships in the selected database.
3. **Policy engine:** Build an internal deterministic policy evaluator
   combining:
   - RBAC grants,
   - ownership checks,
   - one-level relationship checks,
   - ABAC-style predicates over object/action/state attributes,
   - approval requirements.
4. **Decision logs:** Persist policy decision summaries with changeset
   previews/commits for auditability.
5. **Optional integrations:** Support external identity providers such as
   Ory/Auth0/Clerk/WorkOS/Cognito through OIDC/JWT compatibility, not as core
   requirements.

## Enforcement Points

- API request admission.
- Changeset preview.
- Changeset commit recheck inside the transaction or immediately before write
  with lock/version checks.
- Query/search filtering through SQL-lowerable policy predicates before
  pagination.
- Semantic search retrieval filtering.
- Event/webhook subscription authorization.

## Database Role

Postgres should enforce invariants that must survive app bugs/races where it
can. Runtime enforcement remains necessary for action-level, changeset-level,
hook-level, and policy-specific decisions that are not naturally expressible as
SQL constraints.

- Resource constraints.
- Unique idempotency keys.
- Object version checks.
- Optional row-level security for defense-in-depth, if it does not make the app
  too complex.

Application policy remains necessary because decisions are action- and
changeset-level, not just row-level.

## Open Questions

- Should policy rules be user-authored through a safe DSL, configured through
  structured resource files, or only app-defined at first?
- How much of ABAC should be exposed publicly in v1?
- Should Postgres RLS be mandatory or optional defense-in-depth?
- What policy explanation format should previews return?
