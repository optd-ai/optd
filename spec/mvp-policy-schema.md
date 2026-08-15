<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-mvp-policy-schema; contract: 1; input: sha256:0b15a355d4c706689ef10c249d931e944da744dcb40343d46be2e98c4f2db293 -->

# MVP Policy Schema v1

Generated exact-contract projection imported into project-model/model.json from the reviewed mvp-policy-schema.md source.

## Exact migrated contract

<a id="obj-com-exact-mvp-policy-schema-v1"></a>

### Exact v1 contract — MVP Policy Schema v1

**Migration provenance.** Exact normative contract imported from `spec/mvp-policy-schema.md` at `sha256:f5d3922c71d77bf62224e1b45836b3c3d6793b9b68fa65df05892252fb61e51b`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

Policy uses structured YAML plus the frozen SQL-lowerable CEL subset. Rego/OPA,
arbitrary SQL, caller-supplied roles, and pack-defined permission vocabularies
are not supported.

## Policy document

```yaml
kind: Policy
apiVersion: operant.dev/v1
metadata:
  name: sales_access
spec:
  default_assignment: all_projects
  rules:
    - name: sales_rep_own_leads
      effect: allow
      roles: [operant/crm:sales_rep]
      actions: [read, create, update, archive, transition, comment]
      resources: [operant/crm:lead]
      where: "owner_id == actor.id"
      axi:
        summary: Work leads owned by the actor or assigned to the actor's sales teams.

    - name: explicit_opportunity_viewer
      effect: allow
      roles: [operant/crm:sales_rep]
      actions: [read]
      resources: [operant/crm:opportunity]
      relation:
        relationship: operant/crm:opportunity_viewer
        object_side: from
        subject_side: to
        subject: actor.id

    - name: convert_qualified_lead
      effect: allow
      roles: [operant/crm:sales_rep]
      actions: [action:operant/crm:convert_lead]
      resources: [operant/crm:lead]
      where: "status == 'qualified'"
```

Pack-local role/resource/action/relationship references may be abbreviated in
source and are canonicalized against the owning pack during preview. Persisted
policy definitions contain only publisher-qualified identities.

`spec.default_assignment` is required and is `none|all_projects`. Pack policies
cannot default-activate at `system` or one project. `all_projects` activation is
security-relevant, shown in preview, and atomically tied to the exact active
pack revision. It grants no role by itself.

## Rule fields

- `name`: unique lowercase snake-case identity within the policy.
- `effect`: `allow` only for v1. Absence of a matching allow denies.
- `roles`: canonical role identities. `*` is allowed only in built-in system
  policy authored by the platform, not ordinary packs.
- `actions`: exact domain/semantic/system action strings. `*` is allowed only in
  built-in super-admin policy mechanics.
- `resources`: canonical resource identities. `*` is allowed only where the
  active system policy schema explicitly permits it.
- `where`: optional frozen CEL-subset predicate evaluated against declared
  object and actor fields.
- `relation`: optional one-hop ReBAC clause.
- `axi.summary`: optional explanation used in boundary capability summaries;
  explanatory only.

## Action vocabulary

Domain resource actions:

```text
read
read_archived
history.read
create
update
archive
transition
link
unlink
comment
```

Semantic pack action/seed permissions are exact qualified strings:

```text
action:operant/crm:convert_lead
action:operant/projects:start_task
seed:operant/crm:lead_statuses
```

Semantic action/seed permission covers only its reviewed declared/generated
effect manifest in the one request project; it is not a wildcard over the
underlying resources.

System API capabilities use exact dotted identities owned by the platform rather
than generic `manage_*` aliases. The initial set includes the frozen API
contracts, for example:

```text
project.read
project.create
project.update
project.archive
pack.preview
pack.apply
pack.inspect_security
migration.inspect
migration.validate
migration.apply
changeset.inspect
changeset.cancel
changeset.commit_others
changeset.approval.decide
auth.request.decide
auth.user.manage
auth.password_reset.decide
auth.authorization.inspect
auth.authorization.revoke
secret.inspect
secret.create
secret.rotate
secret.disable
secret.grant
hook.secret.configure
policy.assignment.manage
role.assignment.manage
outbox.inspect
outbox.retry
outbox.cancel
outbox.drain
```

Together with the domain actions and dynamic `action:`/`seed:` identities above,
this is the closed v1 action registry. Route/service authorization must use one
canonical string; aliases such as `manage_secret` are rejected. Adding a system
route/action requires a spec/schema version change, not an arbitrary pack
string.

## Actor and boundary context

Actor context is entirely server-derived from the authenticated credential,
principal, authorization chain, and active assignments. Public requests cannot
supply roles, permissions, ownership arrays, or actor identity.

Conceptually, policy evaluation receives:

```json
{
  "principal": {
    "type": "agent_user",
    "id": "019b...",
    "human_user_id": "019a..."
  },
  "boundary": {
    "type": "project",
    "project_id": "019c..."
  },
  "roles": ["operant/crm:sales_rep"],
  "attributes": {
    "id": "019b...",
    "principal_type": "agent_user",
    "human_user_id": "019a..."
  }
}
```

CEL exposes only curated immutable principal aliases in v1: `actor.id`,
`actor.principal_type`, and nullable `actor.human_user_id`; the transport object
above is not caller input. Arbitrary assignment/user metadata arrays are not
policy attributes. Role and policy assignments use exactly one `project`,
`all_projects`, or `system` boundary as defined in
[Authorization Definitions and Assignments](authorization-assignments.md).

`system:super_admin` is a built-in policy bypass, not an ordinary pack rule. It
still requires valid authentication/authorization chain, structural validation,
last-human-super-admin invariants where relevant, and audit.

## ReBAC v1

Only one relationship hop is supported. Deep traversal is rejected.

`relation.object_side` identifies the protected-object endpoint and
`subject_side` must be the opposite endpoint. `subject` is exactly `actor.id` or
`actor.human_user_id`; null never matches. The relationship definition's subject
endpoint must be built-in `system:principal`. Thus one-hop ReBAC is one indexed
relationship existence check, not an arbitrary actor-supplied ID array.
Team/company traversal would require two hops and must be denormalized to a
direct protected-object/principal relationship for v1.

## Assignment and evaluation

A policy definition grants nothing until an active policy assignment selects it
for one explicit boundary.

- Query/list compiles applicable allow rules to SQL and pushes them down before
  sorting/pagination.
- Single-object, semantic action, changeset stage, and commit use targeted SQL
  evaluation.
- Commit re-evaluates all operation/project boundaries in one SQL statement
  snapshot under [Commit Revalidation](commit-revalidation.md).
- If no active assigned rule allows the exact action/resource/boundary, deny.
- Conditional rules remain labeled conditional in role capability summaries.

## Explanation and denial

Authenticated denial uses the shared error envelope and references the immutable
auth context. It reports current principal, boundary, exact failed action and
resource, and safe matched/checked policy identities/rules. It does not
recommend roles, auth requests, grant commands, or escalation steps.

```json
{
  "ok": false,
  "error": {
    "code": "policy_denied",
    "message": "current authority does not allow update on operant/crm:lead",
    "details": {
      "auth_context_id": "019b...",
      "principal_id": "019a...",
      "boundary": { "project_id": "019c..." },
      "resource": "operant/crm:lead",
      "action": "update",
      "checked_policies": ["operant/crm:sales_access"],
      "checked_rules": ["sales_rep_own_leads"]
    }
  }
}
```

Policy-definition/assignment identities and the decision summary are retained as
audit/stage evidence without duplicating object snapshots.
