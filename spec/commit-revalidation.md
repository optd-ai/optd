<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-commit-revalidation; contract: 1; input: sha256:4204b1b51b491e6830b8c4b72cc821782231cca8655507a590d2643e46c1d8de -->

# Race-Free Commit Revalidation

Generated exact-contract projection imported into project-model/model.json from the reviewed commit-revalidation.md source.

## Exact migrated contract

<a id="obj-com-exact-commit-revalidation-v1"></a>

### Exact v1 contract — Race-Free Commit Revalidation

**Migration provenance.** Exact normative contract imported from `spec/commit-revalidation.md` at `sha256:28578f4b4f2d89784f9818d21d9dc2938f6b4a0a6a15622285aac6b1ec54d715`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Purpose

Staging runs hooks once and persists an immutable operation graph under
[Immutable Staged Changeset Storage](staged-changeset-storage.md). Commit must
still atomically revalidate current database, authorization, approval, project,
and pack state with the writes. This contract prevents time-of-check/time-of-use
races without synthetic global coordination rows or rerunning hooks.

Executable evidence is in `prototypes/commit-revalidation/` and uses real
Postgres with independent concurrent connections.

## Concurrency semantics

Commit transactions use Postgres `READ COMMITTED` with explicit natural table
and row locks. Authorization has one decision statement snapshot:

- authorization changes committed before that statement are observed;
- changes overlapping that statement may be logically ordered after commit;
- there is no global security guard or promise that an overlapping revocation
  aborts an already-running commit.

Pack installation and domain commits are ordered through the pack-owned runtime
tables themselves. Ordinary write-intent locks are mutually compatible; the rare
pack installation acquires stronger locks and bears the disruption.

## Conservative pack invalidation

For MVP, a stage records every pack revision referenced by its operation graph.
Any active revision change to one of those packs invalidates the stage, even
when the changed pack component appears unrelated. Installing or upgrading a
pack not referenced by the stage does not invalidate it.

This deliberately conservative rule avoids a fragile compatibility classifier.
The stage should also retain the concrete resource/relationship/lifecycle
component identities and digests it used as non-authoritative provenance. A
future version may replace exact pack-revision comparison with selective
component compatibility without changing the operation graph or requiring the
MVP to classify changes now.

A changed referenced revision returns:

```text
stage_stale: pack_revision_changed
```

No replacement stage is generated automatically.

## Runtime table locks

### Commit

Before revalidation, commit explicitly acquires `ROW EXCLUSIVE` on every
pack-owned resource/relationship table the stage may mutate:

```sql
LOCK TABLE res_lead IN ROW EXCLUSIVE MODE;
```

Postgres already takes this mode for `INSERT`, `UPDATE`, and `DELETE`. Acquiring
it early closes the gap between validation and first DML. `ROW EXCLUSIVE` is
compatible with ordinary reads, `SELECT FOR UPDATE`, and other normal
`ROW EXCLUSIVE` writers; it does not serialize commits that touch different
rows.

Tables containing read-only staged dependencies are also locked early in
`ROW EXCLUSIVE` mode when they belong to the affected pack/table set. This is a
write-intent coordination signal for pack activation; row-level `FOR SHARE`
still preserves ordinary read concurrency.

Stable platform tables such as commits, object versions, audit, events, and
outbox need no explicit early table lock. Their ordinary DML locks remain
implicit; platform schema upgrades use the deployment migration lifecycle.

### Pack apply

Pack apply acquires `SHARE ROW EXCLUSIVE` on every existing resource and
relationship table owned by the pack, not only tables detected as changed:

```sql
LOCK TABLE res_lead IN SHARE ROW EXCLUSIVE MODE;
```

This simple rule covers metadata-only changes without maintaining a fragile list
of which changes might affect writes. Ordinary `ACCESS SHARE` reads may
continue. Pack apply waits for in-flight writers and blocks new writers while
activation is in progress.

DDL acquires stronger modes such as `ACCESS EXCLUSIVE` where Postgres requires
them. New tables have no active writers and are created before activation.
Removed tables use the required DDL lock and make referencing stages stale.

## Canonical lock order

Application write paths acquire locks in this order:

1. staged-changeset lifecycle coordination row;
2. pack-owned runtime tables;
3. project rows;
4. object and relationship dependency rows.

Runtime tables are sorted by the stable tuple:

```text
publisher
pack
kind rank: resource before relationship
component name
physical table name
```

Dependency rows are grouped by that table order and then sorted by UUID. A row
that is both read and mutated is locked once using the stronger mode.

Pack apply uses exactly the same runtime-table ordering. It must not lock,
cancel, or mutate stage lifecycle/approval rows while holding runtime-table
locks; stages become stale through revision comparison. This prevents the known
cycle:

```text
commit: stage → table
pack apply: table → stage
```

Canonical ordering prevents known application-created cycles but does not claim
that all future database deadlocks are impossible. Postgres deadlock detection
and bounded retry remain the backstop.

## Commit transaction

One commit attempt performs:

1. `BEGIN` at `READ COMMITTED`.
2. Set the transaction-local lock timeout.
3. Lock `staged_changeset_lifecycle` for the stage `FOR UPDATE`.
4. Return the original commit DTO when a commit already exists.
5. Reject a cancellation record.
6. Resolve affected physical tables from current metadata.
7. Acquire early `ROW EXCLUSIVE` table locks in canonical order.
8. Re-read active pack metadata after waiting and compare every referenced exact
   pack revision.
9. Lock affected project rows `FOR SHARE` in UUID order and verify active state.
10. Lock all staged object/relationship dependencies in canonical order: mutated
    rows `FOR UPDATE`, read-only rows `FOR SHARE`.
11. Evaluate all operation/project authorization boundaries in one SQL statement
    snapshot using current auth/session/ancestor/role/policy state.
12. Revalidate the frozen staged approval requirements, current requirement
    validity, authority, quorum, expiry, and decisions bound to the exact
    `stage_id + stage_digest`; never derive a different requirement set.
13. Compare current object-version pointers and relationship versions with the
    stage dependencies.
14. Revalidate schema, lifecycle, relationships, constraints, and canonical
    operation applicability without running hooks.
15. Apply every operation.
16. Write exactly one resulting object version per canonical object mutation.
17. Write the unique commit, audit, events, and outbox rows.
18. Commit.

No hook, network call, secret resolution, filesystem operation, or other
external effect occurs inside this transaction.

## Stage lifecycle

Commit, cancellation, and approval mutation lock the stage lifecycle
coordination row first.

Consequences:

```text
commit wins        → cancellation returns already_committed
cancellation wins  → commit returns stage_cancelled
approval first     → commit observes it
commit first       → later approval mutation returns already_committed
two commits        → one writes; the other returns the original result
```

`changeset_commits.stage_id` has a unique constraint as the final exactly-once
guarantee. Staleness is derived and never mutates the immutable stage document.

## Dependency locks

- Existing create references/link endpoints/comment targets/read dependencies:
  `FOR SHARE` unless also mutated.
- Update/transition/archive target rows: `FOR UPDATE`.
- Unlinked relationship rows: `FOR UPDATE`.
- Read-only hook/object dependencies: `FOR SHARE`.
- A duplicated row is locked once with the strongest mode.

After locking, commit compares immutable staged dependency IDs/versions to
current pointers. A mismatch returns `stage_stale` and writes no committed
facts.

Creates have no row to lock. UUIDv7 generation avoids practical identity
collision; database unique constraints are authoritative for field and
relationship uniqueness races. Pre-checks improve errors but never replace the
constraint. Concurrent violations return `constraint_conflict`.

## Physical metadata discovery

Commit must discover physical tables before locking while pack apply may be
active. It therefore:

1. reads metadata to identify physical tables;
2. attempts canonical table locks;
3. re-reads active metadata after locks;
4. compares exact referenced pack revisions;
5. maps a renamed/removed table or changed mapping to `stage_stale` rather than
   an internal SQL error.

Physical table identity remains stable for a resource identity during one active
revision. Pack activation and metadata/DDL updates occur in one transaction.

## Authorization and policy

Authorization is recomputed at commit; staging decisions are evidence only. One
SQL statement evaluates every operation/project boundary so `READ COMMITTED`
does not mix policy snapshots across separate decisions.

A current denial returns `authorization_changed` or the more specific
`authorization_ancestor_invalid`. Current policy may differ from staging while
still allowing the exact operation; exact policy-version equality is not
required.

Synchronous hook-secret grants are not rechecked because no hook executes at
commit. Outbox workers check their pinned hook-secret grants at delivery.

## Approvals

Approval requirements are frozen stage evidence and decisions are append-only as
defined in [Changeset Approval Contract](changeset-approvals.md). Decision
creation locks the stage lifecycle row. Commit does not rerun hooks or derive
new requirements; under that lock and the authorization-cutoff statement it
rejects missing quorum, rejection, expiration, inactive approver/authorization,
or lost required-role possession as `approval_changed`.

## Lock timeout

The server default lock timeout is 10 seconds and is configurable by deployment.
Each commit or pack-apply API request may provide a positive duration override.
`optctl --timeout` sends that requested lock timeout and sets a sufficiently
longer client HTTP deadline, allowing an agent to wait through known business
activity when appropriate.

The request override may exceed the server default. The server may enforce only
an explicitly configured deployment safety maximum; there is no small hardcoded
maximum. Invalid/non-positive values fail request validation.

Timeout results are retryable:

```text
commit_busy
pack_install_busy
```

They create no commit/version/event/outbox facts. Administrative pack-install
diagnostics may expose safe affected-table, blocker-count, and wait-duration
metadata, but never unrelated SQL text or actor details.

## Database retries

The server internally retries only transaction failures:

```text
40P01  deadlock_detected
40001  serialization_failure
```

The retry bound and jitter are configurable and small by default. Every attempt
reloads/revalidates the same immutable stage. Hooks never rerun.

Do not automatically retry domain or operational outcomes:

```text
stage_stale
authorization_changed
authorization_ancestor_invalid
approval_changed
stage_cancelled
constraint_conflict
commit_busy
```

Exhaustion returns `commit_retry_exhausted` with no partial writes.

## Transactional pack activation

For MVP, pack activation-path DDL must be transactional. While canonical pack
table locks are held, one transaction performs schema/data migration, normalized
definition storage, active-revision swap, and security-equivalent hook-secret
grant carry-forward.

Nontransactional operations such as `CREATE INDEX CONCURRENTLY` are not used in
the authoritative activation path. If scale later requires them, they must be
modeled as non-authoritative preparation with explicit cleanup/recovery before a
separate locked activation transaction; they cannot silently weaken atomicity.

## Stable outcomes

```text
stage_stale
  pack_revision_changed
  object_version_changed
  relationship_version_changed
  project_changed

authorization_changed
authorization_ancestor_invalid
approval_changed
stage_cancelled
already_committed
constraint_conflict
commit_busy
commit_retry_exhausted
```

`already_committed` normally returns the original successful commit DTO rather
than an error.

## Prototype evidence

`prototypes/commit-revalidation/commit_revalidation.ts` implements the protocol
against real Postgres tables. Its test coordinates independent connections with
barriers to prove:

- same-stage exactly-once commit;
- commit/cancel and approval serialization;
- mutated/read dependency locking;
- pack apply waiting for in-flight writes;
- waiting commits observing a new revision and becoming stale;
- concurrent ordinary writers on different rows;
- canonical ordering from opposite authored orders;
- authorization decision snapshot semantics;
- 10-second default/request override behavior;
- no partial facts after failed revalidation;
- real Postgres `40P01` detection and bounded retry without hook execution.

Run:

```bash
nix-shell --run 'deno test --allow-read --allow-write --allow-env --allow-net --allow-run prototypes/commit-revalidation/commit_revalidation.test.ts'
```

Verified evidence:

```text
1 passed | 0 failed
```
