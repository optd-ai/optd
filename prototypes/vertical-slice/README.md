# Integrated Vertical Slice Prototype

This Deno/PGlite prototype composes the earlier focused prototypes into one
executable flow using `prototypes/crm-default-pack`.

It validates:

- HTTP multipart pack apply
- strict pack normalization and metadata storage
- resource SQL table generation
- first-class relationship SQL table generation
- lifecycle/policy/action/hook/seed metadata storage
- seed files lowered into ordinary committed changesets
- `before_preview` lead normalization hook
- lead validation hook
- changeset preview and commit
- object versions, audit events, committed events, and outbox rows
- action hook execution for `convert_lead`
- relationship link operations from action-generated changeset operations
- `POST /queries` for compact filtered reads
- history inspection from immutable object versions plus audit/events
- metadata/home endpoints driven by pack AXI/resource/action metadata
- after-commit outbox worker execution

This is intentionally still a prototype: it favors readable end-to-end semantics
over production performance and complete validation. The intended direction is
to keep iterating in Deno until the vertical slice stabilizes; `optctl` can
later be implemented in Rust for low startup latency while continuing to call
the same HTTP API.

## Run tests

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/vertical-slice/vertical-slice-server.test.ts
```

## Run server

```bash
deno run --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/vertical-slice/vertical-slice-server.ts 8789
```
