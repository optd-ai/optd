# Initial Operant project-model candidate audit

## Status

**Candidate only — not authoritative and not approved for spec cutover.**

The candidate was built at source HEAD
`7640287c1bf1ad11879b88dac36b81e092923ba4` and is now at revision 13 after
conflict, drift, layout, and information-loss review. It contains 220 typed
objects:

| Collection  | Count |
| ----------- | ----: |
| Workstreams |     9 |
| Intents     |    11 |
| Concepts    |    16 |
| Evidence    |     8 |
| Assumptions |     3 |
| Questions   |    13 |
| Tensions    |     2 |
| Scenarios   |    12 |
| Proposals   |     2 |
| Decisions   |    43 |
| Commitments |    73 |
| Discoveries |    28 |

Installed `pi-dag-workflow` validation passed with zero
schema/relationship/state errors. Every structured repository, test, history,
session-entry, and Git source reference resolved. Model hash and manifest hash
at the time of this report:

- model:
  `sha256:5a7b171a4ea96de7ffa4cea075cc6970ab0711a23e6b96934fc0fd83efa09263`
- candidate manifest:
  `sha256:46120d55b3ce71869c196451f0bb8ce8d341cee55c76f853afffdc9dc22b2244`

Twenty-one reviewed decisions and two implementation commitments carry exact
direct-user acceptance receipts; the rest of the imported governing corpus
remains unaccepted. The source corpus is frozen in
`initial-source-manifest.json`.

## Mapping principles

- Direct user direction, accepted proposal sequences, current normative specs,
  implementation reality, and execution evidence are distinguished in
  `introducedBy` and `sourceRefs`.
- Existing accepted-looking prose was imported as proposed
  intents/concepts/scenarios, candidate decisions, and not-reviewed commitments.
  No acceptance receipts were fabricated.
- Current source/test facts are evidence; they do not automatically make
  conflicting product direction authoritative.
- Superseded ideas—dotted/default identities, one-role-only agent grants,
  credential shopping, mutable preview/commit, per-Project pack revisions,
  server process telemetry, short-lived sessions, project-specific secrets,
  architecture ratchets, reduced container smoke, global host-process stability,
  and attestation work—are not represented as current decisions.
- PostgreSQL 17+ is the documented runtime minimum; PostgreSQL 18.4 and Deno
  2.9.4 are acceptance-shell identities, while the image deliberately pins Deno
  2.8.3 and PostgreSQL 18.4.
- Global Docker before/after equality is exact. Shared-host process/temp
  snapshots are diagnostic; exact Operant-owned process and temporary identities
  must return to zero.

## Validation against implementation

Observed directly at current HEAD during this audit:

- `deno task check`: passed.
- Default-included unit tests: **224 passed / 0 failed**.
- Default-excluded current `tests/unit/cli_contract.test.ts`: **4 passed / 0
  failed** when run directly.
- Strict proof-pack loading and architecture checks passed within the unit
  partition.
- Application-to-adapter architecture inventory reports zero direct/transitive
  paths.
- Candidate model schema/source-reference validation passed with zero failures.

Real PostgreSQL and exact-image behavior was not rerun during this
documentation/model audit because the current shell lacked PostgreSQL binaries
and a release rerun was unnecessary to inspect semantics. The immutable
same-HEAD repair evidence remains the current live-external evidence: PostgreSQL
18.4 matrices and one release gate at **424 passed / 0 failed / 0 ignored**,
with exact Docker restoration.

A non-gating sweep of historical `prototypes/` timed out and exposed two legacy
PGlite parser failures; real-PostgreSQL prototype tests self-skipped without
binaries. Those prototypes are not treated as current implementation evidence.

## Source/model inconsistencies requiring product decisions

### Resolved — public auth wire contract

The user selected the implemented lifecycle API. `spec/auth-api.md` now omits a
single-user GET and specifies `POST .../role-assignments/:assignment_id/disable`
with `expected_version`. Hono, `optctl`, tests, and prose now agree.
`Q-auth-routes` is answered by the accepted `DEC-auth-admin-routes`;
`DISC-auth-route-drift` is integrated.

### Resolved — Projects proof-pack resource identity

The user selected `operant/projects:timesheet`, matching the actual pack,
policy, AXI, and complete shared flow. Project and acceptance specs now agree,
and the noncanonical `timesheet_entry` alias remains absent.
`Q-projects-timesheet-name` is answered by accepted
`DEC-projects-timesheet-identity`; `DISC-timesheet-identity` is integrated.

### Resolved — resource null and clear behavior

The user selected the existing explicit update contract: omission leaves a field
unchanged, `set` assigns only a non-null typed value, and `unset` removes an
optional value. JSON null remains invalid. Operation prose and examples now
match schema and source. `Q-field-null` is answered by accepted
`DEC-field-null-contract`; `DISC-null-contract` is integrated and
`COM-field-null` is accepted.

### Resolved — Action-read schema

The user selected the strict executable form: snake-case `id_from` from
`$action.input.<field>`, a nonempty unique `fields` projection, and explicit
`required`. Semantic Actions have no implicit `$current`/`$proposed` object and
no camelCase aliases. Both specs now match source. `Q-action-read-schema` is
answered by accepted `DEC-action-read-schema`; `DISC-action-read-contract` is
integrated and `COM-action-reads` is accepted.

### Resolved — Hook actor transport

The user selected explicitly mapped, phase-specific server-derived actor DTOs.
`action.stage` receives `{id, principal_type}`; `event.after_commit` receives
`{id, human_user_id, auth_context_id}`; changeset hooks receive none. Roles,
credentials, tokens, ambient authority, and caller-provided identity remain
excluded. Both specs now match source. `Q-hook-actor` is answered by accepted
`DEC-hook-actor-dto`; `DISC-hook-actor-contract` is integrated.

### Resolved — stable error registry

The user selected one canonical transport registry. Malformed JSON/non-object
transport is 400; well-formed schema/domain failure including unknown fields is
`validation_failed`/422; lock deadlines are `commit_busy` or
`pack_install_busy`/423. The unused `commit_lock_timeout` alias was removed.
Generic Hono parsing, the central status registry, tests, and prose now agree.
`Q-error-registry` is answered by accepted `DEC-error-registry`;
`DISC-error-codes` is integrated.

## Additional implementation/spec drift

The medium batches are resolved: requester cancellation is current,
semantic/vector search is explicitly deferred, split Hono routes are inventoried
and contract-tested, the CLI contract joins default unit discovery, release
formatting covers project-model, reset identity is separated from nonce entropy,
approvals remain frozen, Hook source pairing is strict, runtime modes are exact,
purge is future-only, Projects membership has the correct domain rationale,
outbox counters distinguish generations, AXI examples match the executable query
contract, and the old readiness result is explicitly historical.

All identified source/spec semantic conflicts are now represented by accepted
`DEC-*` objects and integrated `DISC-*` records. Remaining work is completeness
and cleanup: prove every useful spec section is represented in generated
project-model documentation before deleting the hand-authored corpus.

## Repository hygiene and validation gaps

- `spec/README.md` still says `.ai/project.md` is the current notebook, but that
  file was explicitly retired and is absent. `project-model/model.json` is
  intended to replace it.
- No root `README.md` exists.
- `prototypes/crm-default-pack.scope.md` still uses pre-publisher `default`
  identity and omits a current relationship.
- `tests/scenarios/README.md` describes retained scenario files that no longer
  exist.
- Hono imports `UploadedPackFile` through an outbound YAML-adapter re-export
  rather than its domain definition. This is low-severity sibling-adapter
  coupling, not a violation of the existing application-to-adapter test.
- Cliffy is used for help construction while production parsing/dispatch is
  hand-written, despite the implementation-boundary wording.

## Historical/prototype disposition

The current corpus classification is:

- 41 current normative/target contracts;
- 4 supporting research/prototype evidence files;
- 7 explicitly historical/superseded walkthroughs;
- 1 current meta/readiness audit whose final readiness claim is stale.

The initial candidate did not overwrite or reclassify any file. Conflict review
now updates affected specs as an intermediate consistency step. The selected
final direction is to replace the entire hand-authored `spec/` corpus with
reviewed deterministic project-model projections after every conflict and
omission is resolved. The directory remains only as generated workflow output,
not a second semantic authority.

## Cutover gate

Projection routing places all 155 governing objects exactly once across 62 safe
generated views. Forty-two current normative files are preserved literally in
exact-contract commitments. Eleven historical/supporting files are also
preserved literally but carry explicit non-normative dispositions. The
section-level report maps all 53 files and 890 headings with zero unresolved
sections. The deterministic replacement preview replaces 53 hand-authored files
and adds nine domain overview files; it deletes no path.

Three independent blocking audits found and drove closure of stale contract
wording, missing exact wire/schema/state detail, the migration-classification
authority delegation, stale preservation/session evidence, README mapping, link
counts, and loopback/Cliffy ambiguity. A fresh revision-13 audit then returned
PASS. Mechanical comparison confirms exact bodies, 213/213 source references,
194 local links, generated paths, placement, and authoritative-state simulation.

## Cutover completion

The user explicitly approved candidate manifest
`sha256:46120d55b3ce71869c196451f0bb8ce8d341cee55c76f853afffdc9dc22b2244` and
the recorded 53-replace/9-add/0-delete set. The isolated migration cutover
advanced the model to authoritative revision 14, accepted all 155 governing
objects, generated all 62 projection paths, and reported zero stale paths. The
receipt and post-cutover conformance evidence are preserved alongside this
audit.
