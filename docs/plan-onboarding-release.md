# Onboarding usability release plan

Status: implemented; host validation passed, immutable release gate pending.
Baseline: v0.2.2. Proposed release: v0.3.0 (new additive CLI/API functionality,
not another storage cutover). Confirm the next unused version before tagging. No
release or installation is authorized by this document. Preserve both handoff
documents unchanged.

## Implementation evidence (2026-10-15)

- All four feature areas are implemented in the working tree. The resolver is
  `POST /api/v1/auth/workspace/resolve`. Existing redundant
  `--boundary workspace --workspace <selector>` remains compatible;
  contradictory boundary types are rejected.
- Latest combined unit/integration run: **391 passed, 0 failed**, using isolated
  HOME/XDG state and environment. The host CRM/Projects shared public-flow
  matrix also passed (12-test run including equivalence and focused CLI
  acceptance). New relationship/slug/metadata/pagination assertions run through
  the existing shared Projects driver, so they are included in future
  exact-image acceptance.
- The independent black-box observer used a frozen candidate and disposable
  server/database without source lookup. Seed discovery, required fields,
  lifecycle guidance, link/unlink and scoped slug requests succeeded. After
  correcting the parent's missing cursor-key setup, resource and relationship
  traversal succeeded; restricted viewers could paginate resources but were
  correctly not assumed to have relationship-read grants.
- The exploratory snapshot exposed selected-Workspace query inconsistency and
  bootstrap's known-anchor failure after server mutation. Follow-up changes now
  use shared Workspace context resolution for queries and preflight the anchor
  before bootstrap/login; compiled regression tests cover both. The exploratory
  binary predates those follow-ups and is not final-candidate acceptance
  evidence.
- Isolated harness mode allowlists environment, prevents external-database and
  initial environment overrides, generates both encryption/cursor keys, disables
  legacy auth-state bridging, and clears subprocess inheritance for build,
  server and direct CLI execution. Independent test servers verified cleanup;
  the main installation and credentials were not used.
- A disposable source-runtime upgrade smoke passed from the v0.2.2 commit
  `d82aa0b9dccea27fdf09e0484429c28cd5ef3432` to the candidate server, using only
  public CLI setup/reads and the same database/auth state. Workspace, Project,
  Task, relationship, role assignment, existing administrator session and viewer
  login/scoped reads survived without a data reset. This is not an exact-image
  upgrade attestation.
- Remaining gates: clean committed candidate, full mandatory exact-image release
  gate and artifact checks. No tag, publication or installation has occurred.

Separate unresolved risk: another investigation reported that an agent launcher
can inherit a human credential from an authenticated ancestor shell. This work
neither changes that selection policy nor claims to fix it. Resolve or
explicitly triage that issue separately before publication; do not infer its
safety from the scoped resolver tests.

## Outcome and boundaries

A new human or agent can discover and execute relationship changes, explicitly
initialize Workspace seeds, request scoped authority using a Workspace slug, and
find required input and pagination information without inspecting source code.

Keep normal authorization, lifecycle checks, approval revalidation, and audited
changesets. Do not auto-seed on pack installation, enumerate workspaces for
request credentials, require query totals, weaken process/credential boundaries,
rebuild historical import, or change self-completion semantics. No database
reset is intended for existing Workspace-era installations. Project-era
databases stay unsupported.

## 1. Relationship CLI adapters

Proposed command shapes (new, not commands claimed to exist today):

- `optctl --workspace <selector> link <qualified-relationship> --from <uuid> --to <uuid> [--input <json>] [--file <path>]`
- `optctl --workspace <selector> unlink <qualified-relationship> <relationship-id> [--expected-version <n>]`

Match `create`/`update`: stage and commit by default, with `--stage` to stop
after staging; reuse the existing commit timeout, input exclusivity,
idempotency, output envelopes and error handling. Expose `--stage` and
applicable commit options on both commands. Do not introduce a parallel mutation
path.

Translate directly to the existing authored `link`/`unlink` operations. Optional
link input contains relationship fields, not a second way to override endpoints.
Unlink takes a relationship instance ID, never an ambiguous endpoint pair. Reuse
the existing mutation pipeline; no direct database writes or new authorization
bypass. Return existing created-identity mappings and replay behavior.

Acceptance: compiled CLI creates and removes an edge; optional edge fields;
invalid endpoint types and malformed IDs; inaccessible/cross-workspace
endpoints; missing edge; stale expected version; denial without permission; no
mutation on failure; ordinary approval/commit behavior; repeat/idempotency
parity with raw changesets. Raw JSON staging remains available for
multi-operation local refs.

## 2. Explicit seed discovery

Enhance pack help/AXI with the actual seed command, qualified seed names, and a
clear distinction between installed definitions and initialized workspace data.
Explain `seed commit <pack> --all` versus selecting `--seed`; errors for omitted
or conflicting selection should show a usable correction. Match examples to the
actual parser and current selected-workspace rules.

Expose existing seed row metadata prominently rather than adding a parallel
metadata system. Preserve explicit stage/commit paths and warn that
reconciliation may update existing data. Do not promise that re-running seeds is
a no-op unless the seed semantics and tests establish it.

Acceptance: fresh pack installation leaves data unseeded; help alone leads to
successful explicit initialization; selection errors are actionable; inspect,
stage, commit and repeat reconciliation behave as documented; no cross-workspace
writes; initialization does not silently require broad administrative authority.

## 3. Scoped slug support and diagnostics

Current generic CLI slug resolution calls `/api/v1/workspaces`. Do not grant
that listing capability to an authorization-request credential just to reuse it.

Proposed design: a narrowly scoped authenticated authorization-boundary resolver
accepts one exact Workspace UUIDv7 or slug and returns only its canonical UUID
(and selector confirmation if needed). Wire both `auth request` and role
discovery to this resolver; keep stored request boundaries canonical UUIDs.
Existing UUID clients remain supported. Add the route/schema through the normal
application port/service/repository layers, not an SQL shortcut inside the CLI
or HTTP route. Finalize the route name in the relevant specification before
implementation.

The resolver must use the governing current requestability/delegation boundary,
including active user, session, grant lineage and workspace status. Identity
alone grants no lookup. Restricted agents must not obtain their anchoring
human's broader authority. A permitted lookup grants no resource-read or
workspace-list capability. Approval/redemption/commit still revalidate current
authority.

Resolve only exact selectors, without wildcard, prefix, list, count or
pagination support. Unknown and inaccessible selectors return the same public
error shape; avoid including workspace identity in denial details. UUID-shaped
malformed or wrong-version arguments get local field-specific usage errors, not
opaque server schema failures. Valid slugs must not be mistaken for malformed
UUIDs. Reuse the canonical slug grammar. Define archived/inactive behavior
explicitly and align it with existing authorization eligibility, rather than
silently allowing requests.

Acceptance: UUID/slug equivalence, valid scoped human/request/agent cases,
unknown and inaccessible equivalence, malformed and wrong-version UUIDs, invalid
slugs, revoked or superseded grants, inactive users/workspaces, ancestor
revocation, restricted-agent scope, changed authority between resolution and
request/approval, and no expansion of ordinary workspace listing. API and CLI
contract tests must assert canonical persisted boundaries and unchanged
role-grantability checks.

## 4. Critical output and metadata links

- Put required inputs before optional definitions and verbose field detail in
  human-readable metadata. Retain existing machine-readable required/optional
  fields; test ordering rather than assuming their presence solves discovery.
- Display a pagination summary before human-readable rows: returned count,
  whether more exist, and how to continue. Unknown totals stay unknown; count
  remains opt-in. Preserve machine-readable stdout as one valid envelope, with
  no prefixed prose; route supplementary notices appropriately by output mode.
- Link action metadata to lifecycle/state prerequisites, existing
  read/availability metadata, and the next executable inspection command. Do not
  claim that static availability guarantees successful execution under changing
  authority/state.
- Give relationship metadata concrete link/unlink examples and clarify endpoint
  object IDs versus relationship instance IDs. Use qualified pack identities.

Acceptance: snapshot/contract checks for human and JSON modes,
empty/single/multi page results, projected fields, explicit totals,
piped/non-TTY output, long metadata, and discoverable lifecycle/relationship
commands. No fake fields, mandatory totals, or lossy/truncated error paths
introduced.

## 5. Isolated acceptance, not another product feature

This is both an investigation of prior contradictory observations and a release
acceptance exercise. Convert repeatable lessons into regression tests; do not
make an agent's subjective success the sole CI gate.

Use a separate disposable service, database, ports, HOME, XDG config/state/data,
auth anchor/context, bootstrap secret and master key. Never use localhost:8789,
the Home Manager service, real auth files, existing Docker volumes, or an
external database connection. Start from an allowlisted/sanitized environment;
explicit `--server` is necessary but not sufficient isolation. Only clean up
resources created and ownership-recorded by this run. Shared immutable build
caches are not shared credentials or mutable runtime state.

Existing `tests/support/live_harness.ts` already allocates temporary
data/home/XDG roots, random secrets, and service/Postgres ports, and removes the
external DB setting by default. The independent read-only harness investigation
confirmed that subprocesses still inherit environment settings and existing
adapters copy or project authentication state. Therefore add a strict onboarding
adapter before running acceptance: minimal allowlisted runner environment,
`clearEnv: true` for owned subprocesses, locked isolation settings, fresh
`OPTD_SECRET_MASTER_KEY`, and separate TMPDIR/Deno cache roots. Removing a key
from an explicit env object alone does not prevent subprocess inheritance. Use
public bootstrap/login/request flows; no auth-store bridge, copied grants or
SQL-created business state.

Provide raw compiled-CLI invocation so the onboarding test can prove local
context selection without silently injected server/workspace flags. The isolated
HOME and deny-access-to-main-server boundary must remain in force even for these
calls. Acquire resources exception-safely, record ownership before ambiguous
creation results, retry port collisions, use bounded termination, and propagate
cleanup errors. Run quiescence checks even after cleanup throws. Keep these
changes scoped to the new runner/adapter unless a shared fix is necessary.

Parallel smoke instances are feasible, but full release gates must be serialized
on a shared Docker daemon: their global inventory checks can observe each
other's resources. Use separate disposable daemons/VMs for parallel full gates.
No changes to gate inventory checks are proposed. The scout confused
relationship link/unlink with local context linking in part of its suggested
exercise; that suggestion is not adopted. Section 1 defines server-side
relationship operations exclusively.

Procedure:

1. Harness operator prepares fresh baseline v0.2.2 and candidate environments,
   sequentially or with disjoint roots/ports. No production data is copied.
2. A fresh-context agent gets the explicit sandbox URL, synthetic credentials,
   goals and permission boundaries—not implementation notes or command answers.
   It uses only the installed CLI help/AXI/metadata, not repository source.
3. Onboard a Workspace, install a pack, discover/init seeds, request scoped
   authority by slug, create related objects, link/unlink, discover required
   fields and action prerequisites, and paginate beyond the default limit.
4. Include non-super-admin and denied operations; run the authorization matrix
   deterministically even if the exploratory agent misses a case.
5. Save exact command argv, exit codes, stdout/stderr and raw envelopes; redact
   secrets/passwords/nonces. Bind results to binary SHA256, source revision,
   server version and image identity. Record hints needed and discrepancies.
6. Stop owned processes, verify quiescence, preserve redacted evidence, and
   remove only owned sandbox resources. A failed cleanup is a failed acceptance
   run.

Gate: no source lookup or operator hints are needed for the target tasks; all
security-negative cases pass; no access to the main installation occurs.
Baseline friction is characterization evidence, not a candidate test failure.
Candidate regressions or unresolved contradictory results block readiness.

## Implementation sequence and ownership

1. Define intended contracts and examples directly in `spec/`, the source of
   truth. Define scoped resolver policy and output-mode compatibility; review
   these edits alongside implementation and tests. No DAG model or regeneration.
2. Implement authorization resolver/schema/service/repository plus negative
   tests. This security seam is the highest-risk dependency and deserves review
   first.
3. Implement relationship adapters, seed guidance and output/metadata
   improvements. One owner edits shared `optctl.ts`/help files; parallelize only
   disjoint files or isolated branches with explicit integration ownership.
4. Add deterministic compiled-CLI and shared public-flow coverage for host and
   exact-image paths. Run the independent black-box onboarding exercise against
   the composed candidate, not an intermediate branch.
5. Review composed changes and security behavior; fix findings and rerun
   affected tests. Update release/upgrade docs and remove any stale claimed
   limitations.

Do not bump bundled pack versions unless pack content actually changes. If it
does, preserve immutable pack identity/version rules and test reconciliation
with existing installed definitions rather than rewriting a published pack
version.

## Release gates and publication

- Focused unit/integration tests, read-only specification checks, formatting,
  lint and CLI help/output contracts pass. Focused tests are not release
  readiness.
- Fresh-state host shared flows and the full suite run without skipped real
  PostgreSQL coverage. Add a v0.2.2 Workspace-data upgrade smoke test that
  retains objects, relationships, grants and auth semantics; no destructive
  reset.
- Run the unchanged mandatory release gate on a clean committed exact source.
  Verify host coverage, exact-image acceptance, compiled artifact identity and
  ownership-scoped cleanup. Wire new deterministic cases into that gate.
- Only after implementation approval and explicit publication authorization,
  commit/push the accepted candidate, verify the unused version, and push its
  immutable tag. The tag-triggered workflow must validate before publishing.
- Download the published artifacts, verify checksums/revision/image digest and
  embedded version, and smoke-test in a disposable environment. Publish notes
  with new commands, explicit seeding, slug scope, and output compatibility.
- Offer a separate approved Home Manager upgrade using the released binary and
  immutable image digest. Preserve the Deno executable payload; never strip it.
  Keep credentials and existing Workspace volume, take a recoverable backup, and
  verify health/version and basic authenticated operations after activation.

Failure policy: never move a failed tag or weaken a gate. Fix source and use a
new unused version. On local upgrade failure, preserve evidence and restore the
prior pinned CLI/image only when storage compatibility is verified; otherwise
restore the backup under explicit operator approval. Never silently wipe the
database.

## Completed prerequisite: specification authority

The DAG-model cutover is complete: edit `spec/` directly. All 62 specification
paths and 159 explicit anchors were retained. The final JSON model and migration
receipts are archived byte-for-byte under `spec/history/project-model/` as
non-normative history; the validator/projector is retired. Active tooling uses
`deno task spec:check` and the specifications rather than loading the old model.

Cutover verification: 18 focused tests passed, alongside type checks, repository
formatting, focused lint, shell syntax and diff checks. These checks do not
establish acceptance of the four planned features or release readiness. No
onboarding sandbox, full release gate or installation change has occurred.

## Evidence and remaining uncertainty

Code inspection supports the existing relationship operation schemas, generic
workspace-list resolver, current authorization requestability machinery,
temporary live harness, and immutable release process. Feature and isolated
sandbox evidence is recorded above; it is not full release readiness. The prior
six passing focused tests remain baseline evidence only. The harness scout
performed code inspection, not runtime validation; its isolation findings are
incorporated above. Runtime isolation and implementation-time contract decisions
must be verified before acceptance, not deferred until publication.
