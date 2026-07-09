# Deno optctl Prototype

A minimal `optctl` shim for testing
`prototypes/vertical-slice/vertical-slice-server.ts`.

It is intentionally small and Deno-based. A future production CLI can be
implemented in Rust for lower startup latency while keeping this HTTP command
contract.

## Commands

```bash
deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 home

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 metadata resource default.lead

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 pack apply prototypes/crm-default-pack

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 query default.lead --where 'status == "new" && active()' --fields id,name,email,status

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 changeset commit --file change.json

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 action preview default.convert_lead --input '{"lead_id":"lead_ada"}'

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 action commit default.convert_lead --input '{"lead_id":"lead_ada"}'

deno run --allow-read --allow-net prototypes/optctl/optctl.ts --server http://127.0.0.1:8789 history default.lead lead_ada
```

Output is compact TOON-ish text for easy agent reading.

## Test

```bash
deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/optctl/optctl.test.ts
```
