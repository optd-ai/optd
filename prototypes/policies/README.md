# SQL-Lowerable Policy Prototype

This prototype validates a simple internal policy model that combines RBAC, ABAC, and one-level ReBAC while remaining SQL-lowerable.

It proves:

- RBAC, ABAC, and ReBAC are complementary inputs to one policy decision, not mutually exclusive systems.
- Read/list policy rules can compile into SQL predicates for pushdown before pagination.
- The same policy rule can be evaluated both as SQL and in runtime code with matching results.
- One-level ReBAC can be represented as a single SQL join against membership/assignment tables.
- Deeper relationship traversal is rejected as a hard constraint.

## Hard ReBAC constraint

Only one relationship hop is supported.

If users need deeper transitive access, they should denormalize/link the relevant object directly so the policy can use a one-hop relationship.

Examples:

- supported: actor is member of object's team
- supported: actor is assigned to object's company
- rejected: actor -> team -> parent team -> region -> object

## Test coverage

The prototype runs 60 policy scenarios:

- 20 RBAC-style combinations
- 20 ABAC-style combinations
- 20 one-level ReBAC-style combinations

It verifies that SQL-pushdown results match runtime evaluation results for every scenario.

## Run

```bash
deno run --allow-read --allow-write --allow-env --allow-net prototypes/policies/policy-prototype.ts
```

## Test

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/policies/policy-prototype.test.ts
```
