# App-Managed Postgres Spike

Validates the intended local/runtime database lifecycle:

- locate `initdb`, `postgres`, and `psql` from `OPERANT_PG_BIN_DIR` or `PATH`
- initialize a temp `PGDATA`
- start `postgres` as a child process
- wait for readiness
- run SQL through `psql`
- stop the child process

The test skips when Postgres binaries are unavailable. In MVP integration tests,
`direnv + shell.nix` should provide these binaries.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/postgres/app-managed-postgres-spike.test.ts
```
