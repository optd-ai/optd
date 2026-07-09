# MVP Policy Schema v0

Policy uses structured YAML plus SQL-lowerable CEL-like expressions. Rego/OPA
and arbitrary SQL are not part of v0.

## Policy document

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
      actions: [read, create, update, archive, transition, action]
      resources: [default.lead]
      where: "owner_id == actor.id || sales_team_id in actor.sales_team_ids"

    - name: company_member_opportunities
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

## Rule fields

- `name`: unique within policy.
- `effect`: `allow` only for MVP. Deny can be added later if needed.
- `roles`: actor roles that activate the rule. `*` matches any role.
- `actions`: action vocabulary below. `*` matches any action.
- `resources`: dotted resources. `*` matches any resource.
- `where`: optional SQL-lowerable expression evaluated against object fields
  plus actor fields.
- `relation`: optional one-hop ReBAC clause.

## Action vocabulary

```text
read
create
update
archive
transition
link
unlink
comment
action
manage_pack
manage_migration
manage_secret
```

## Actor context v0

```json
{
  "id": "user_123",
  "roles": ["sales_rep"],
  "sales_team_ids": ["direct"],
  "company_ids": ["company_123"],
  "permissions": []
}
```

`super_admin` is a special role that bypasses permission checks.

## ReBAC v0

Only one relationship hop is supported. Deep traversal is rejected.

`relation.objectSide` determines which side of the relationship points to the
protected object:

- `from`: protected object id is in relationship `from_id`.
- `to`: protected object id is in relationship `to_id`.

`subjectIdsFromActor` names an actor array field containing directly authorized
related object ids.

## Evaluation

- Query/list: compile policy to SQL predicate and push it down before
  pagination.
- Single-object/action/changeset: evaluate rules at runtime and/or with targeted
  SQL checks.
- If no rule allows the operation, deny.
- Return explanations with matched/skipped rule names where practical.

## Denial response shape

```json
{
  "ok": false,
  "error": {
    "code": "policy_denied",
    "message": "actor is not allowed to update default.lead",
    "details": {
      "actor_id": "user_123",
      "resource": "default.lead",
      "action": "update",
      "checked_rules": ["sales_rep_own_leads"]
    }
  }
}
```
