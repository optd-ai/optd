<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-mvp-migration-integration; contract: 1; input: sha256:d8b6cc4791f1de7e89c1902773c7346616c1608dcf729d84aba8f7f89253f60a -->

# MVP Pack-Migration Integration

Generated exact-contract projection imported into project-model/model.json from the reviewed mvp-migration-integration.md source.

## Exact migrated contract

<a id="obj-com-exact-mvp-migration-integration-v1"></a>

### Exact v1 contract — MVP Pack-Migration Integration

**Migration provenance.** Exact normative contract imported from `spec/mvp-migration-integration.md` at `sha256:515d481385fc87bb369053ab259fb8df0e254b3aa43cca112c83068977576a7a`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Decision

Each previewed pack revision produces one immutable migration plan that either
applies completely in one Postgres transaction or does not apply at all. There
are no execution groups or partially applied plan states.

[Migrations](migrations.md) and
[Migration Classification](migration-classification.md) own DTO/class/hazard/
confirmation semantics; this file freezes subsystem integration.

## Lifecycle

1. `POST /api/v1/packs/preview` receives strict multipart source.
2. Server validates/canonicalizes source and stores or reuses an immutable
   content-addressed candidate pack revision.
3. Against the one active pack revision (or null for first install), it computes
   semantic definition/dependency diff, current live facts, hazards/blockers,
   generated SQL/metadata steps, and grant carry-forward requirements.
4. It persists a new immutable `migration.plan.v1` plus initial validation facts
   and returns the complete plan.
5. Inspect/violations/SQL routes expose authorized views; SQL is not duplicated
   into every plan item.
6. Cleanup/backfill possible under the current schema uses ordinary immutable
   changesets, followed by migration validation.
7. If cleanup requires a transitional schema, the author applies an explicit
   intermediate pack revision as its own atomic plan, performs cleanup, then
   previews the final desired revision into a new plan.
8. Apply revalidates plan/candidate/current active revision/live facts/authority
   under canonical pack/runtime locks.
9. Generated DDL, metadata, default policy assignments, grant carry-forward,
   active-pack pointer, audit, events, and application result commit atomically.

Plan class is `safe|risky|destructive`; plan status is exactly
`ready|blocked|applied`. Failed attempts are append-only attempt/audit records.
Legacy `previewed`, `staged`, `partially_staged`, `awaiting_confirmation`,
`failed`, and `superseded` status aliases are rejected.

## CLI sequencing

```text
optctl pack preview ./packs/crm-v2
optctl pack apply ./packs/crm-v2 --safe
optctl migration inspect <migration-id> [--violations|--sql]
optctl migration validate <migration-id>
optctl migration apply <migration-id> --safe
optctl migration apply <migration-id> --reviewed
optctl migration apply <migration-id> --confirm-token <token>
```

`pack apply` is client orchestration: multipart preview then exact whole-plan
apply. It is not a second source-upload route. There is no migration execution-
group/stage command, `preview-drop`, or separate confirmation mutation.

## Complex migration sequencing

A difficult migration is represented by explicit pack revisions, not hidden
server state:

```text
v1 active
  → preview/apply v1.1 additive transitional revision atomically
  → ordinary cleanup/backfill changesets
  → preview/validate v2 final destructive revision
  → confirm/apply v2 atomically
```

The intermediate revision may add replacement fields and normal pack hooks/
actions that block or dual-write old fields. This puts extra authoring burden
only on genuinely complex upgrades while keeping the server plan state machine
small, inspectable, and recoverable.

## Locking and execution

- Discover pack-owned physical runtime tables before the transaction.
- Set request/configured lock timeout.
- Acquire `SHARE ROW EXCLUSIVE` on every existing pack-owned runtime table in
  canonical qualified table order; generated DDL may escalate.
- Do not use `CREATE INDEX CONCURRENTLY` in atomic activation.
- Serialize competing apply/activation for the same pack and reject a plan whose
  `from_pack_revision_id` is no longer active.
- Run structural generated-DDL validation on temporary real Postgres before a
  plan becomes applicable; locked live revalidation remains authoritative.
- Execute all plan steps and active-revision switch in one transaction. Any
  error rolls back every DDL/metadata/activation effect.
- Never execute migration cleanup data writes outside changesets.
- Follow `commit-revalidation.md` for pack/write ordering, bounded deadlock/
  serialization retry, timeout, and transactional activation.

## Destructive flow

1. Preview classifies destructive changes and blockers conservatively.
2. Resolve blockers with normal changesets under the current schema, or apply an
   explicit atomic intermediate pack revision when the current schema cannot
   safely support cleanup.
3. Preview/validate the final desired revision against current live facts.
4. Validation issues a short-lived opaque confirmation token only for a ready
   destructive whole plan.
5. Apply the exact whole plan with token; under locks, any plan,
   active-revision, facts, identity, authority, expiry, or prior-use mismatch
   writes no DDL or activation.

## Honest operational limits

MVP does not claim zero-downtime migration. It reports strong locks, scans,
rewrites, table size/facts, and likely interruption. It may block unsafe work,
but does not implement shadow tables, hidden transitional schemas, automatic
dual writes, background copy orchestration, or other machinery that suggests a
hitch-free online migration guarantee.

## Implementation evidence boundary

PGlite migration prototypes remain algorithm/evidence references only.
Production logic belongs behind application services and real-Postgres adapters
and must be verified against real Postgres lock/DDL behavior; prototype
route/status/ID spellings are not compatibility contracts.
