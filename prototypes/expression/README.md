# CEL AST → SQL Spike

This prototype tests whether an existing CEL library can provide parsing/AST so
the platform does not need to write a CEL parser from scratch.

Finding:

- `@bufbuild/cel` exposes a protobuf-shaped parsed expression tree that is
  suitable for a conservative custom SQL lowerer.
- The library is an evaluator, not a ready-made CEL-to-Postgres compiler.
- We should still own SQL lowering so we can enforce field allowlists, function
  allowlists, parameterization, type checks, and context-specific behavior for
  queries, policies, partial indexes, hook conditions, and AXI conditions.
- The spike now covers typed field contexts, actor parameter binding,
  `self.field` aliases, null semantics, list membership, `has`/`present`/
  `missing`, archive helpers, malicious literal parameterization, expression
  complexity limits, and stable-ish error codes.

Run:

```bash
deno test --allow-env --allow-net --allow-read --allow-write prototypes/expression/cel-ast-sql-spike.test.ts
```
