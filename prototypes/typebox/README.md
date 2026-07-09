# TypeBox + Ajv T-Shaped Spike

This spike validates how TypeBox + Ajv can support the MVP architecture across
multiple surfaces:

- YAML pack parsing (including merge-key normalization) plus pack config
  validation with file/path-aware normalized errors
- changeset v0 operation schemas
- hook envelope and output schemas
- Hono HTTP boundary validation
- metadata derivation for `optctl metadata`
- optional future OpenAPI document shape using TypeBox JSON schemas

It is intentionally broad and shallow. The goal is to confirm integration shape,
not finalize every schema.

Run:

```bash
deno test --allow-env --allow-net --allow-read --allow-write prototypes/typebox/typebox-spike.test.ts
```
