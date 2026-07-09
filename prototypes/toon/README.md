# TOON Package Spike

This spike verifies that `@toon-format/toon` works through Deno npm imports.

Finding:

- The package exports `encode` and `decode`.
- It works in Deno.
- The MVP should wrap it behind an adapter so output shape can be
  customized/replaced later.
- MVP CLI input remains JSON only; TOON is for output by default.

Run:

```bash
deno test --allow-env --allow-net --allow-read --allow-write prototypes/toon/toon-package-spike.test.ts
```
