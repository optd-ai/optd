# Race-Free Commit Revalidation Prototype

This prototype uses a real Postgres server and multiple independent connections
to prove the lock protocol frozen in `spec/commit-revalidation.md`.

## Protocol exercised

A commit transaction uses Postgres `READ COMMITTED` and:

1. locks the immutable stage row `FOR UPDATE`;
2. acquires early, mutually compatible `ROW EXCLUSIVE` locks on every affected
   pack-owned runtime table in canonical order;
3. re-reads the active pack revision after those locks;
4. locks project rows `FOR SHARE`;
5. locks mutated dependencies `FOR UPDATE` and read dependencies `FOR SHARE` in
   canonical `(table, UUID)` order;
6. performs one-statement-snapshot authorization;
7. checks approvals and object versions;
8. atomically writes object versions, commit, event, and outbox facts.

Pack apply acquires `SHARE ROW EXCLUSIVE` on every existing table owned by the
pack in the same table order, then activates the new pack revision in that
transaction. Ordinary writers remain mutually compatible; pack installation
waits for them and blocks new writes while active.

## Real concurrency evidence

The test proves:

- two commits of one stage create one commit;
- commit/cancel and commit/approval mutation serialize on the stage row;
- mutated and read-only object dependencies cannot change after locking;
- pack apply waits for an in-flight commit;
- a commit waiting for pack apply observes the new revision and becomes stale;
- writes to different rows in one table remain concurrent;
- opposite authored table/object order canonicalizes and avoids the known
  application deadlock cycle;
- authorization committed before the decision snapshot is denied, while an
  overlapping revocation may order after commit;
- the configurable request lock timeout overrides the 10-second server default;
- failed revalidation creates no commit/version/event/outbox facts;
- real Postgres deadlock detection produces `40P01` and a bounded transaction
  retry can complete without rerunning a stage hook.

## Run

The test needs real Postgres binaries. From the repository root:

```bash
nix-shell --run 'deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/commit-revalidation/commit_revalidation.test.ts'
```

Expected result:

```text
1 passed | 0 failed
```

The prototype intentionally models exact active pack-revision equality. Any
upgrade to a pack referenced by a stage invalidates that stage. New unrelated
packs do not. This conservative MVP rule is easy to reason about. Stages should
still retain component dependency identities/digests so a future version can
adopt selective compatibility without changing the operation graph contract.
