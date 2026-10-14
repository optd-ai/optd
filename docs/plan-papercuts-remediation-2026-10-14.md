# Onboarding papercuts: verified assessment and remediation plan

Review baseline: `d494c23`
(`fix(auth): recover missing request credentials on login`). Input:
`docs/handoff-papercuts-2026-10-14.md`. The original handoff is preserved
unchanged (and excluded from automatic formatting to preserve its bytes).

## Accepted update — fresh-install Workspace release

The user subsequently authorized all remaining handoff fixes and explicitly
chose a fresh-install breaking release, without a compatibility layer. The
platform boundary is now Workspace across CLI, HTTP, authorization, schema, and
contracts; publisher identity and the Projects Pack's work-project resource are
preserved. Both bundled Packs are now `0.2.0`. See
[Workspace release notes](workspace-release.md).

Implementation includes current-authority Workspace access, approval readiness
and commit parity, PATH-based process readers, corrected list
projections/defaults, seed and required-field metadata, actionable CLI
help/errors, created-ID commit results, explicit authorized historical import,
and self-completion with jointly optional time entries. Canonical model revision
27 and its 62 generated specs record the updated contracts.

The broad host run reported 481 passing and eight failing tests. All eight were
subsequently fixed and passed in focused reruns, including complete CRM/Projects
flows, PostgreSQL lifecycle checks, bootstrap, and exact Compose cleanup checks.
This is not an exact-image release attestation. Local Docker is unavailable; the
user approved committing/pushing and using the existing gated GitHub workflow
for `v0.2.0`, with local installation only after publication succeeds.

## Historical first update — close your own tickets

The user requested that actors be able to close their own tickets. The Projects
pack source is now version `0.1.1`: task completion emits no separate approval
requirement. Existing transition/action authorization, assignment restrictions,
project boundaries, lifecycle validation and time-entry validation are
unchanged. This supersedes the distinct-reviewer recommendation below for
ordinary task completion; platform approval behavior for other packs remains
unchanged.

Verification: 26 focused tests and the 10-test host public-flow entrypoint
passed (the latter includes shared test registrations also present in the
focused run). The compiled Projects flow stages and commits completion as the
same agent, with no human approval. New hook tests cover human/agent completion
from in-progress and blocked, plus invalid transitions, blocked reasons, titles
and time entries.

This is a source change, not a deployment. Existing installations must preview
and apply the new pack revision. Previously staged approvals are immutable;
restage affected work after upgrading. Legacy fixture packs under
`tests/fixtures` use an older schema and are intentionally not rewritten.

## Verdict

The handoff captures substantial real friction, but its diagnoses and proposed
fixes are not all correct. Do not implement it literally. In particular:

1. **A4:** super-admin role bypass is intentional; decision and commit disagree
   about it. Preserve the documented bypass rather than silently removing it.
2. **C1:** seeds are implemented as explicit per-project changesets. Global pack
   installation deliberately does not create project data. Fix discoverability
   and metadata, not global installation semantics.
3. **A14/A15:** client-side process binding is already documented, and all three
   listed regressions already have tests.
4. **A16:** request authority is available from the shared local request
   credential without `auth isolate`. Isolation prevents broader
   ancestor-credential discovery; it is not how request authority is minted.
5. **C2/C3:** principal-type permission, approval capability, exact
   required-role possession, and self-approval are separate gates. Changing only
   one will not deliver the desired workflow.

This is a targeted assessment, not a certification that the whole codebase is
correct. Historical release-image behavior was not independently re-run.

## Verified findings, ordered by implementation urgency

### 1. Authentication portability and error classification — A1/A2

**Confirmed, blocking on hosts without `/bin/cat`.**
`src/adapters/outbound/process-inspection/linux.ts:45` hardcodes that
executable. `inspect` maps every `NotFound` to a dead PID, and any nonzero
helper result is converted to `NotFound`, losing permission and other failure
information too.

The current machine has a manually supplied `/bin/cat` symlink; passing tests
here do not reproduce a pristine NixOS environment. The suggested direct
procfs-read alternative is not a drop-in fix: the implementation explicitly
documents Deno's special-file permission guard.

**Plan:** resolve the helper from the caller's PATH before constructing the
scrubbed subprocess environment; retain no-shell/fixed-argv execution. Give
missing helper, denied procfs access, dead PID, and unexpected helper failure
distinct diagnostics. Avoid interpreting a failed boot-id read as proof that an
individual PID died. Test real binary execution without relying on `/bin/cat`,
not only the injected reader.

### 2. Approval eligibility is inconsistent — A4

**Confirmed with an important correction.**
`src/adapters/outbound/postgres/stage_repository.ts:695–759` already checks
active principal, type, initiator, expiry, approval capability, and exact
effective role. It explicitly permits super-admin to bypass capability/role
possession. `spec/changeset-approvals.md:73` explicitly authorizes that bypass.

However, commit's `valid_approvals` SQL
(`src/adapters/outbound/postgres/commit_repository.ts:1329–1367`) requires the
exact role and does not implement the same super-admin alternative. The
decision-time lifecycle calculation also counts recorded approvals without
validating their current eligibility (`stage_repository.ts:789–799`). Thus a
false `ready` state is possible. Commit does fail closed; this is not evidence
of an unauthorized successful commit.

**Plan:** make decision, review access, quorum projection, and the
single-statement commit cutoff enforce the same documented rules. Preserve the
cutoff's concurrency guarantees. Preserve super-admin bypass only for
role/policy, never principal type, initiator, expiry, authentication, or audit.
Keep commit revalidation even after decision-time checks. Clarify pending versus
invalidated approval errors without casually changing stable error codes.
Existing immutable decisions remain evidence; do not rewrite them to repair
status.

**Acceptance:** a super-admin lacking the manager role can approve and commit
when otherwise eligible; an ordinary wrong-role approver is rejected without
inserting a decision; deactivated/revoked/expired approvers cannot count toward
readiness or commit. Include distinct-principal quorum, rejection, duplicate
decision, cross-boundary and race cases.

### 3. Project service ignores seeded policy — A3/A7

**Confirmed.** `src/application/services/projects/manage_projects.ts:27–35`
hardcodes super-admin for all project operations. Seeded `system:admin` rules
cover all four actions, including read (`migrations.ts:693–699`), not just
create. Slug resolution uses that list API (`optctl.ts:643–666`).

A7 overstates the workaround: `context set-project <UUIDv7>` uses the UUID fast
path and persists the selection; users need not pass the UUID on every command.

**Plan:** route project operations through current server-derived authorization.
Creation requires system authority; define and test exact boundary rules for
list/read/update/archive rather than flattening assignments into `auth.roles`.
Add minimal slug resolution for principals authorized in that project, filtering
before pagination and avoiding cross-project enumeration. An arbitrary
assignment should not automatically expose full project metadata, especially if
revoked, inactive, or unrelated to the effective agent authorization.

**Acceptance:** system admin follows its active policy; a project-scoped agent
resolves its own slug but cannot enumerate or mutate other projects;
revocation/archival and pagination remain correct. This changes existing access
semantics and needs a reviewed model direction.

### 4. Default list projection rejects platform IDs — A5

**Confirmed for the bundled resource defaults, not intrinsically every possible
resource.** The CLI forwards `axi.list.defaultFields` (`optctl.ts:1934–1938`);
bundled definitions include `id`. Query validation accepts only `packFields`
(`query_objects.ts:301–325`), even though SQL definitions expose `id` as a
platform field (`query_policy_sql.ts:351–357`). The fallback also reads
`list.fields` rather than `defaultFields`.

**Plan:** make platform `id` a supported explicit projection and align metadata
default-field handling. Keep the existing top-level object identity and
field-value DTO semantics deliberate, and update query contracts if needed.
Validate unknown and duplicate fields normally. Test every bundled resource's
declared defaults, not just one task-stage example.

## Remaining handoff disposition

| Item | Assessment                                                                                                                                                                                                                                                                                                          | Proposed action                                                                                                                                                                                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A6   | Commit DTO lacks object IDs (`domain/changesets/commit.ts:1`). But IDs already exist in staged operations, and `changeset inspect <stage_id>` exposes them; re-query/title matching is not the only option.                                                                                                         | Add an additive operation-key-to-created-identity result derived from the frozen graph; preserve it on idempotent commit replay. Cover creates, hook-generated operations and relationship identities. Document stage-only IDs as allocated, not committed.                                                      |
| A8   | Pagination exists, and total is opt-in rather than unavailable. CLI already accepts `--include-total` (`optctl.ts:244`); query defaults it to false.                                                                                                                                                                | Human output should say “showing N; more results available” and show the next-page command; show “of M” when total is requested. Preserve JSON, do not force expensive counts, and do not imply a known total when null.                                                                                         |
| A9   | Confirmed. Cliffy subcommands are registered without command-specific options (`optctl.ts:1052–1085`). Reproduced `bootstrap init --help` showing only help.                                                                                                                                                        | Declare positional/flag usage for every public command, with credential-input safety and examples. Keep help registration aligned with actual manual dispatch; test required options and defaults, not just help exit code.                                                                                      |
| A10  | Confirmed. Reproduced both quoted misleading errors locally.                                                                                                                                                                                                                                                        | Validate context name before parsing flags; distinguish missing stage ID from missing requirement ID and invalid values. Add negative argument tests.                                                                                                                                                            |
| A11  | Confirmed. Changeset input supports positional files and `--file`, not `--input` (`optctl.ts:525–535`).                                                                                                                                                                                                             | Add `--input <JSON-or-file>` using the existing input resolver; retain documented file forms unless explicitly choosing a breaking CLI release. Reject ambiguous multiple sources.                                                                                                                               |
| A12  | Confirmed. Runtime version is hardcoded (`config/runtime.ts:1`); Docker version build arg currently labels only the final image (`Dockerfile:46–51`).                                                                                                                                                               | Stamp version/revision into the build before compilation, including standalone CLI packaging. Assert `/live` and `/ready` report the packaged identity. Avoid a mutable runtime env override masquerading as build provenance.                                                                                   |
| A13  | Confirmed. Generic definition diff uses `kind.slice(0, -1)` (`domain/migrations/pack_migration.ts:399–404`).                                                                                                                                                                                                        | Use explicit singular definition names. Check downstream migration-kind consumers and persisted plan compatibility; do not mutate old immutable plans/digests.                                                                                                                                                   |
| A14  | Already explicitly documented (`spec/authentication.md:89–112`, also local-binding cleanup wording).                                                                                                                                                                                                                | Add a concise onboarding/security warning: stale local bindings do not invalidate a copied bearer token; expiry/revocation do. Do not claim missing documentation or implement server-side PID checks.                                                                                                           |
| A15  | Already covered. Anchor traversal: `tests/unit/auth_anchor.test.ts`; redemption secrecy: `tests/unit/agent_redemption_cli.test.ts`; missing request credential recovery: `tests/integration/login_request_credential_recovery.test.ts`; compiled tool shells: `tests/e2e/process_binding/agent_tool_shell.test.ts`. | Retain/run these tests and add only missing portability or real-harness coverage. All named suites passed in this review.                                                                                                                                                                                        |
| A16  | Premise incorrect for current code. `auth_store.ts:219–230` reads the shared per-origin request credential; `optctl.ts:1520–1552` uses it directly for `auth request`, with no isolate requirement.                                                                                                                 | Document the existing live-harness request/wait flow and distinguish request discovery from preventing inherited human credentials. Add a no-isolate running-harness regression. Consider attach/isolate-in-place only after a threat-model review; do not add `grant-request --pid` based on the handoff alone. |
| B    | Naming collision is real; Workspace is a reasonable proposed name, not a correctness fix or mechanically risk-free rename. Pack publisher namespace is distinct.                                                                                                                                                    | Separate, reviewed compatibility/migration project after correctness fixes. See phase 5.                                                                                                                                                                                                                         |
| C1   | Empty runtime rows after pack apply are by design (`spec/pack-structure.md:181–183, 263–307`); `seed stage/commit` already exist. Metadata really is wrong: it returns `spec.resources` although seeds declare `resource/key/mode/rows` (`inspect_metadata.ts:213–217`).                                            | Fix seed metadata and expose per-project initialization instructions. Add a guided explicit initialization workflow, not implicit global writes. Verify four stages and four tags after seed commit and unchanged replay. Audit explicit seed capabilities for non-super-admin operators.                        |
| C2   | Human-only completion approval is confirmed (`hooks/validate_task.ts:68–76`), but agents can already stage completion. Agent exclusion is on approval, not both sides. Principal types are already pack-authored hook output with a documented default.                                                             | Accepted update: ordinary task completion requires no separate approval. Implemented in pack source 0.1.1 with same-agent stage/commit E2E coverage; existing task authorization still applies.                                                                                                                  |
| C3   | Non-nested roles confirmed. Adding `changeset.approval.decide` to admin alone is insufficient: the requirement still demands the exact manager role.                                                                                                                                                                | Decide explicit manager co-assignment or a documented role-implication design before claiming admin is a strict superset. Prefer explicit co-assignment initially over introducing global role hierarchy solely for this pack. Test grants as well as successful approval.                                       |
| C4   | Initial-state enforcement is intentional (`stage_repository.ts`, create lifecycle validation), and there is no explicit import path.                                                                                                                                                                                | Design an audited import capability/source, not a general unchecked state override. Validate schema, references, hooks and provenance; explicitly decide completion approvals for historical records. Support bulk operation keys and dry-run staging.                                                           |
| C5   | Confirmed in `actions/complete_task.yaml` and `hooks/complete_task.ts`. The convenience action requires time entry, but a direct transition can already complete without a timesheet, subject to approval.                                                                                                          | Make hours/date optional as a pair; emit a timesheet and spent-hours write only when provided. Reject half-pairs and invalid hours; do not fabricate zero-hour rows.                                                                                                                                             |
| C6   | Resource metadata passes the field map through unchanged (`inspect_metadata.ts:131`); there is no required-first presentation. Object-map order is not a durable API guarantee.                                                                                                                                     | Add explicit ordered required/optional field guidance to human metadata presentation; preserve canonical schemas and JSON compatibility. Test required references and pagination/scroll-heavy output.                                                                                                            |
| C7   | Lifecycle already returns transitions (`inspect_metadata.ts:207–211`), but action metadata omits availability and reads (`:200–206`).                                                                                                                                                                               | Expose declared action availability and read/input context, plus a concise lifecycle edge summary. Do not invent a unique action-to-transition mapping: direct transitions and multiple actions may share an edge.                                                                                               |

### Additional issue discovered in C3

`project_access.yaml` gives admin `link/unlink` actions only against resource
identities, not the relationship identities `optd/projects:task_tag_assignment`
and `optd/projects:task_milestone`. Direct link authorization targets the
relationship identity (`stage_repository.ts:1481–1492, 2883`). Thus the
handoff's claim that this admin can attach tags/milestones is not supported by
the current policy; a super-admin bypass may have masked it.

Add explicit, boundary-scoped relationship read/link/unlink grants and
end-to-end tests using only the advertised pack roles. Do not use super-admin
for pack-role acceptance tests.

## Implementation sequence

### Phase 0 — Freeze intended contracts and add reproductions

- Record accepted policy decisions in the authoritative
  `project-model/model.json` through reviewed directions; regenerate `spec/`
  projections. **Do not hand-edit generated spec files**
  (`project-model/README.md:38–40`).
- Add failing regressions for A1/A2, super-admin decision-to-commit parity,
  A3/A7 visibility, bundled list defaults, and actual relationship-role grants.
- Keep behavior changes to approval policy, import authority, and naming visibly
  separate from bug corrections.

Exit: each confirmed blocker has a focused reproduction and each behavior change
has an accepted contract.

### Phase 1 — Restore safe baseline onboarding

Suggested independently reviewable commits/PRs:

1. Portable proc inspection and actionable diagnostics (A1/A2).
2. Approval eligibility parity and current-valid quorum calculation (A4).
3. Policy-backed project access and scoped slug lookup (A3/A7).
4. Valid list projections and metadata-default parity (A5).

Tests: focused unit tests plus real compiled CLI, PostgreSQL approval-cutoff
races, project-boundary isolation, and an environment genuinely lacking
`/bin/cat`. Do not modify this host's root filesystem to simulate that test.

### Phase 2 — Make the Projects pack usable without operator archaeology

Depends on phase 1 for reliable permission and approval behavior.

1. Correct seed metadata, add explicit initialization help, and test seed stage
   → commit → unchanged replay for both an existing and a new project (C1).
2. Fix relationship policies; document/co-assign approval role for pack admins;
   remove the separate task-completion approval gate as requested (C2,
   implemented locally); retain C3 as a separate general role-policy concern.
3. Optional paired time-entry inputs with conditional hook effects (C5).
4. Required-field guidance and action/lifecycle discoverability (C6/C7).

Keep `prototypes/project-management-pack` and its intentional test fixtures
synchronized. Publish a new immutable pack revision; do not rewrite an installed
revision. Outstanding stages tied to changed hooks/pack definitions must become
stale normally and be restaged.

Exit: a clean non-super-admin pack-role scenario initializes reference data,
creates tasks, attaches tags/milestones, and reaches done without a separate
approver; completion without hours produces no timesheet (C5 remains planned).

### Phase 3 — Repair CLI ergonomics and release trust

These changes can be developed independently, but integrate after phase 1
contracts stabilize.

1. Full per-command help, precise positional diagnostics, consistent input
   sources (A9–A11).
2. Created identity results derived from immutable operations, including replay
   (A6).
3. Explicit human pagination guidance and total option help (A8).
4. Build-stamped runtime identity and release smoke assertions (A12).
5. Correct singular migration kind/target spelling with compatibility tests
   (A13).
6. Consolidated onboarding and process-binding warnings; retain existing
   regression suites and add no-isolate request coverage (A14–A16).

Exit: help alone is sufficient to bootstrap, initialize seeds, create/query/page
records, request/approve/commit a change, and verify the installed release; JSON
remains machine-stable.

### Phase 4 — Add an explicit import/backfill workflow

C4 is a capability design, not a small relaxation of create validation.

- Decide permitted actors, allowed initial states, approval rules, validation
  behavior, and immutable import provenance.
- Use ordinary staged/committed transactions and deterministic operation keys.
  Preserve lifecycle enforcement for ordinary creates.
- Test unauthorized import, cross-project references, completed historical
  tasks, partial-invalid batches, duplicate business keys, retries and
  audit/history.

Exit: historical completed tasks can be loaded without fake work transitions or
fabricated time, under explicitly accepted authority.

### Phase 5 — Rename platform Project to Workspace

Do this last and separately from hotfixes. Keep the pack's work project named
project.

1. Inventory domain/repository names, API routes/DTOs, CLI/context/env fields,
   boundary variants, DB columns/FKs/indexes, generated runtime
   resource/relationship tables, hooks, policies, seeds, queries/cursors,
   authorization payloads, outbox/audit/history, model projections, deployment
   scripts and fixtures.
2. Decide a clean breaking release versus a bounded compatibility window. Do not
   add aliases or dual schemas without an explicit support requirement.
3. Write forward database/data migrations for existing installations. Do not
   edit historical migration definitions or rewrite immutable stage graphs,
   policy evidence, pack revisions or their digests. Define old pending-stage
   and cursor invalidation/replay behavior; provide an upgrade/backout runbook
   and backup requirement.
4. Migrate platform names and generated-table handling. Prove pack publisher
   namespace identities remain unchanged.
5. Only then publish a separate pack revision migrating `work_project_id` to
   domain `project_id`, with data/reference/hook/read-projection migration. The
   platform column name must already be free.

Exit: fresh install and populated upgrade both work; all boundary authorization
tests pass; publisher namespaces are unchanged; existing domain project/task
links and history remain traceable.

## Decisions that must be accepted before implementing their affected phase

- **Project access:** recommend honoring seeded system-admin policy plus
  least-disclosure scoped slug resolution, rather than deleting useful grants
  (phase 1).
- **Super-admin approvals:** recommend preserving the existing explicit bypass
  and repairing commit parity (phase 1). Removing it is a separately reviewed
  behavior change.
- **Agent completion — accepted and implemented locally:** authorized humans and
  agents may close their own tasks without a separate approval. This changes
  only the pack's requirement-producing hook, not platform approval semantics.
- **Pack admin:** recommend explicit manager-role co-assignment for approval
  eligibility initially; a strict single-role superset needs a deliberate
  role/requirement design, not just an extra policy grant (phase 2).
- **Seed UX:** recommend explicit project initialization; no automatic writes
  from global pack apply (phase 2).
- **Import:** choose authority and historical-review semantics before adding a
  state override (phase 4).
- **Rename:** confirm Workspace and breaking-release/compatibility policy before
  touching persisted identities (phase 5).

## Verification performed in this assessment

**47 focused tests passed; 0 failed.**

First run (36 tests): process inspection, anchor selection, redemption secrecy,
approval requirement contracts, queries, CLI contracts including compiled CLI,
and seed repair contracts.

Second run (11 tests): live login request-credential recovery, seed-domain
staging/reconciliation, production PostgreSQL approval revalidation including
observed lifecycle races, and compiled temporary-tool-shell redemption.

Also directly reproduced the empty bootstrap subcommand help and both A10 usage
errors with the current CLI. Source inspection confirms the remaining structural
findings; that is not an end-to-end reproduction of each report.

Not run: full test suite, release/container gate, historical images, full
Projects onboarding with non-super-admin actors, populated rename upgrades, or
pristine NixOS without the workaround symlink. Before release, run
formatting/type checks, model projection checks, all affected integration/E2E
suites, and the full release gate. The passing baseline suites do not prove the
newly identified defects absent.
