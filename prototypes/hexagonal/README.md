# Hexagonal Skeleton Spike

Validates MVP boundary shape:

- Hono is an inbound adapter only.
- TypeBox/Ajv validation sits at adapter boundary.
- Application services depend on ports.
- Repositories/transaction managers are outbound adapters.
- Raw SQL repository shape is explicit and isolated.

Run:

```bash
deno test --allow-env --allow-net --allow-read --allow-write prototypes/hexagonal/hexagonal-skeleton.test.ts
```
