<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-changesets; contract: 1; input: sha256:ba9dc91a02f93761f479858024119dc1a7de5264433c5d160e8081f797026355 -->

# Changesets

Generated exact-contract projection imported into project-model/model.json from the reviewed changesets.md source.

## Exact migrated contract

<a id="obj-com-exact-changesets-v1"></a>

### Exact v1 contract — Changesets

**Migration provenance.** Exact normative contract imported from `spec/changesets.md` at `sha256:0ac9a09a27188a26cf9f243fc61911109a5c5a884c8dd7482c93e33df27f162d`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Summary

Objects are not modified through raw CRUD. Every write is submitted as an
intention and processed through the same changeset engine.

Historical prototype evidence lives in `prototypes/changesets/`. It uses the old
preview/commit/PGlite vocabulary and is retained only as early
parser/transaction evidence; the immutable stage contracts in this spec are
normative.

## Canonical Write Path

1. Receive an intention.
2. Build and normalize the complete operation graph.
3. Resolve declared Operant reads and record their object versions.
4. Run stage/action/validation hooks once.
5. Validate schema, constraints, lifecycle, policy, effects, and approvals.
6. On any execution or validation denial, return the error/result without
   creating a stage.
7. Otherwise persist one immutable staged-changeset aggregate and return its
   complete inspect representation.
8. On commit, load that exact stage without rerunning hooks.
9. Reauthorize and revalidate current object/dependency/config versions and
   approvals.
10. Execute the transaction and enforce one successful commit per stage.
11. Write new immutable `object_versions` rows and update current projections.
12. Write audit records and committed events and enqueue after-commit outbox
    work.
13. Commit and return the result.

The normative operation and patch vocabulary is frozen in
[Changeset Operation Schemas](changeset-operation-schema.md). Race-free commit
locking, current-state revalidation, timeout, retry, and pack-activation
ordering are frozen in [Commit Revalidation](commit-revalidation.md).

## Intentions

V1 direct intentions are exactly create, update, transition, archive, link,
unlink, and append-only comment. Semantic action/seed staging expands to that
same graph. Approval decisions and cancellation are stage-lifecycle operations,
not graph operations. File attachment, hard delete/unarchive, and generic undo
are absent; recovery uses an explicitly valid compensating changeset.

## Staging

Staging fully expands one atomic user intent, which may include operations in
multiple projects under one Postgres transaction boundary. Stage hooks execute
once. They may use dates, entropy, and declared network/secret access; their
normalized output is persisted rather than reproduced at commit.

A successful stage is one immutable aggregate containing the canonical resolved
operation graph and only the metadata needed to inspect, authorize, validate,
and safely commit it: object/config dependencies, hook identities/digests/logs,
policy decisions, warnings, approvals, and planned after-commit work. Its
normalized Postgres records and lifecycle separation are frozen in
[Immutable Staged Changeset Storage](staged-changeset-storage.md). Generated ids
live directly in operations. Diffs and summaries are derived rather than stored
as competing authoritative forms.

The stage does not retain a second raw request/input payload or a generic bag of
external API responses supplied only for hook validation. Hook invocation input
is ephemeral. External values that affect writes appear in canonical operations;
explanatory external-validation details may appear in persisted hook stderr.

`stage` returns the same complete staged-changeset DTO/rendering as `inspect`,
so an agent never needs a second command merely to see what it just staged.
Inspect may additionally reflect later lifecycle facts such as approval,
cancellation, staleness, or commit.

Hook execution failure, validation denial, policy denial, schema failure, or
missing capability/secret returns a structured error/result and creates no
stage. A proposal that is otherwise valid but requires approval is persisted as
a stage awaiting approval. After-commit delivery remains separate from commit
success.

## Stage access and route authority

The creating principal may inspect/cancel its stage while authenticated and
active. Another principal needs exact `changeset.inspect` or `changeset.cancel`
system capability respectively and boundary visibility for every affected
project. Safe `not_found` hides stages outside visibility. Approval reviewers
receive only the stage representation/redactions authorized by
`changeset.approval.decide` and the exact requirement role.

Authorization follows the frozen stage source. Direct graphs require every exact
operation/resource/project permission. Semantic action stages require the exact
`action:<publisher>/<pack>:<action>` permission in their one request project and
revalidated reviewed effect manifest, not separate caller permission for each
internal emitted operation. Seed stages analogously require exact
`seed:<publisher>/<pack>:<seed>` permission and reviewed seed effects. Action
and seed staging cannot emit into another project; direct graphs may span
projects. The creating principal needs no extra generic commit permission.
Another principal additionally needs exact `changeset.commit_others` system
capability and stage visibility; `system:super_admin` remains the audited
built-in bypass. Cancellation never undoes a commit and does not cancel claimed
outbox work.

## Commit equivalence and revalidation

Commit uses current authorization and applies exactly one persisted immutable
stage. It never runs normalization, action-expansion, or validation hooks and
never discovers unseen effects. It revalidates current authorization,
object/read versions, exact referenced pack/resource revision identities,
current policy/assignment decisions, approvals, operation-graph digest, and
stage digest. It does not recheck synchronous hook-secret grants because no hook
or plaintext access occurs at commit.

A material dependency change returns `stage_stale`; it does not generate a
replacement stage automatically. Other structured causes include
`authorization_changed`, `authorization_ancestor_invalid`, `policy_changed`,
`hook_revision_changed`, `approval_changed`, and `object_version_conflict`. The
agent explicitly creates a new stage when needed. Authorization errors explain
current authority but do not suggest escalation.

Stage and commit may use different auth contexts, but commit defaults to the
same principal that created the stage; another principal requires explicit
`changeset.commit_others`. Staging decisions are audit evidence, never reused as
commit authority.

## Stage and commit repetition

Stage creation has no idempotency requirement. If a response is lost, another
stage command may execute hooks again and create another immutable stage. The
cost is only duplicate/abandoned stage storage and repeated validation/network
work; stage hooks must not intentionally create external side effects.

A stage can commit successfully at most once, enforced by a unique database
constraint on `changeset_commits.stage_id`. Retrying commit for an existing
stage returns the existing success or safely resumes/fails without rerunning
hooks.

There is no combined server `stage-and-commit` endpoint. CLI direct commit is a
convenience sequence: create a stage, retain its id, then commit that id. A lost
stage response may leave an abandoned stage; a lost commit response can safely
retry the known stage id. Horizontally scaled nodes coordinate through Postgres.

Cancellation accepts exactly optional bounded `reason`. It locks the lifecycle
row: repeating an already-cancelled stage returns the current cancelled
representation; committed/rejected stages return their specific 409 terminal
code. Cancellation and the winning commit/approval decision are totally ordered
by that row lock.

## Conflict Detection

Use optimistic locking by object version. A changeset can include expected
versions for all touched objects. The commit fails or returns a conflict preview
when any expected version is stale.

## Approval Flow

A valid stage may begin `awaiting_approval`. Requirement schema, distinct
quorum, decision authority, lifecycle transitions, expiration, and commit
revalidation are frozen in
[Changeset Approval Contract](changeset-approvals.md). Approval facts are
append-only and never mutate the operation graph.

## Undo and Recovery

Undo is not a blanket guarantee. Supported cases should be explicit:

- Pure data changes may be reversible with inverse changesets.
- External side effects require compensation.
- Some actions are irreversible and must be labeled in the staged
  representation.

## Hooks and Scripts

Changesets integrate executable behavior through the stage contract:

- `action.stage` scripts generate operations once.
- `changeset.before_stage` scripts normalize proposed operations.
- `changeset.validate` scripts reject or warn before a stage exists.
- `event.after_commit` scripts perform intentional external effects through the
  outbox.

Stage scripts are trusted pack code, audited, configurable in duration, and fail
closed. They may perform declared external reads but must not intentionally
cause external effects. Filesystem, subprocess, direct database, and self-API
access are unavailable. The normative contract is
[MVP Hook Schema](mvp-hook-schema.md).

## Prototype Evidence

`prototypes/changesets/changeset-server.ts` currently validates these
assumptions:

- HTTP payload validation can feed a canonical operation parser.
- Staging can normalize operations, generate diffs with SQL reads, and return
  validation errors without domain writes.
- Persisted stages can be committed later by id and are revalidated without
  rerunning hooks.
- Commit can run SQL writes transactionally, write history/audit/event records,
  and enforce one successful commit per stage with a SQL unique key.
- Optimistic version conflicts prevent partial commits.
- Minimal policy checks participated in the prototype's old preview/commit
  validation result.
- Relationship aliases and missing references can be validated before any writes
  occur.
- Action endpoints generated operations and reused the same prototype write
  engine; target action staging is defined by the frozen hook/changeset specs.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/changesets/changeset-server.test.ts
```

## Error shape

All staging/commit failures use
[API Response and Error Contract](api-errors.md). Well-formed domain/schema/hook
validation failures are HTTP 422 with `error.details.issues[]`;
state/version/staleness conflicts use HTTP 409 and their stable specific code. A
failed request never returns HTTP 2xx with `ok: false`. Warnings belong only to
successful stage data.

## Archive Behavior

Archive is universal platform metadata: nullable `archived_at` plus
`archived_by_auth_context_id`, both set atomically by the archive operation.
There is no unarchive operation in v1.

Decisions:

- Archived objects cannot be updated or transitioned.
- A relationship cannot be linked when either endpoint is archived; existing
  relationships may be unlinked.
- Append-only comments may target archived objects when policy allows.
- Archived objects are hidden from default reads/lists.
- Archived objects remain explicitly readable for audit/recovery using an
  include-archived option.
- Archive is preferred over hard delete in normal changesets.

## Transaction Semantics

A changeset either commits completely or does not commit at all. Partial success
inside one changeset is not allowed. Validation failures return structured
validation results before writes. Runtime failures during commit roll back the
transaction and return a structured error.

One changeset may span multiple resource types and relationships when all
operations can commit in one transaction.

## Operation contract

The exact v1 operation shapes, UUIDv7 identity generation, structured
references, compatible mutation merging, RFC 6902 normalization patches,
operational limits, and RFC 8785/SHA-256 graph digest are normative in
[Changeset Operation Schemas](changeset-operation-schema.md).
