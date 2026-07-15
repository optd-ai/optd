# Durable Outbox Delivery Prototype

This prototype uses real Postgres, independent claim connections, an in-process
polling loop, and a real local HTTP provider to prove the MVP outbox contract in
`spec/outbox-delivery.md`.

## Proven behavior

- `FOR UPDATE SKIP LOCKED` permits one active claim while multiple in-process
  claim loops poll concurrently.
- A fixed lease survives server/process crash: expiry marks the old append-only
  attempt `lease_expired` and creates a new attempt with the same delivery ID.
- The delivery UUID is the stable provider idempotency key across ordinary,
  lease-recovery, and manual-retry attempts.
- A real HTTP provider sees two ambiguous attempts but applies one effect by
  idempotency key.
- Structured `delivery.v1`-style outcomes drive success, retry with
  `retry_after`, and immediate dead-letter.
- Pinned configuration/security failures dead-letter without executing code.
- Full-jitter exponential retry bounds are deterministic with injected random
  input.
- Cancellation wins only before claim; running work returns
  `delivery_in_progress`.
- Manual retry retains all attempts, increments `retry_generation`, resets only
  the generation attempt count, and preserves the idempotency key.
- Pack upgrade does not redirect queued work: old pinned revision/grant executes
  with the secret's current `value_version`.
- One polling async loop inside the server process discovers work without
  LISTEN/NOTIFY or another container.
- MVP deliberately has no ordering guarantee; a later delivery can finish while
  an earlier delivery remains running.

## Run

```bash
nix-shell --run 'deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/outbox-delivery/outbox_delivery.test.ts'
```

Verified with PostgreSQL 18.4:

```text
1 passed | 0 failed
```

The prototype is intentionally separate from the current production worker,
which already proves basic SKIP LOCKED claiming and dead-lettering but does not
yet implement leases, append-only attempts, stable external idempotency,
structured outcomes, or pinned-revision loading.
