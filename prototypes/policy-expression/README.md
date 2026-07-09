# Policy + Expression Integration Spike

Joins:

- TypeBox policy schema validation
- CEL AST expression SQL lowering
- one-level ReBAC SQL exists clause generation
- explanation/matched-rule output

Run:

```bash
deno test --allow-env --allow-net --allow-read --allow-write prototypes/policy-expression/policy-expression-integration.test.ts
```
