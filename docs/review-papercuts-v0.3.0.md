# Remaining onboarding handoff: v0.3.0 review

Reviewed against published `v0.3.0`, source
`a0aebacf2d1b89bc629321436b629a9640f853a1`, and bundled `optd/projects@0.2.0`.

## Summary

Fix the Projects pack's read permissions and query error translation. Do not
rebuild relationship querying, historical import, or atomic transitions: those
capabilities already exist. Optional transition input and clearer unblock
semantics are smaller follow-ups.

### Cleanup

- Retired `docs/handoff-papercuts-2026-10-14.md`: its unique findings are
  resolved or corrected, and the newer handoff supersedes its open-item
  inventory. The original remains recoverable from the immutable `v0.3.0` Git
  tag.
- Retained `docs/handoff-papercuts-v0.2.2.md` byte-for-byte. It contains genuine
  remaining findings as well as shipped or overstated claims; it is not
  complete.
- Removed the retired file's formatting exclusion and updated its historical
  plan reference. No product code or pack definitions changed in this review.

## Do: fix confirmed gaps

### P1 — N3: Projects roles cannot read archived work

**Confirmed.** A genuine Workspace-scoped `projects_admin` can archive a task,
then receives `not_found` from its view/history and from an `--include-archived`
query. The pack grants `read_archived` to none of its roles.

**Correction:** archive is not a hard delete. The same archived row remains
readable to a super-admin. By-ID view and history already automatically require
`read_archived` for archived rows; they do not need a new flag to provide that
capability. Their rejection of `--include-archived` is a CLI contract
distinction, not proof the underlying read path is missing.

**Recommendation:** deliberately grant archived reads to the appropriate scoped
administrative role, document the existing read paths, and test resource and
relationship history with granted/denied roles and cross-Workspace negatives.
Whether viewers should also see archives is a separate policy decision. Treat
this as reviewed authorization widening, not a silent policy change.

Evidence:

- `prototypes/project-management-pack/policies/project_access.yaml`
- `src/application/services/objects/read_objects.ts:39` and `:90`
- `src/adapters/outbound/postgres/query_policy_sql.ts:236`

### P1 — N4: relationship writes lack corresponding pack read grants

**Confirmed for scoped pack roles, not as a missing platform API.** The
`projects_admin_relationships` rule grants only `link` and `unlink`. The pack's
ordinary read/history rules enumerate resource identities, not
`task_tag_assignment` or `task_milestone`.

The isolated scoped administrator could link successfully but could not query or
view that relationship, even using the correct syntax. A super-admin could query
it and filter by its `from` endpoint:

```text
optctl --workspace <uuid> query relationship optd/projects:task_tag_assignment --where 'from == "<task-uuid>"'
```

**Recommendation:** add deliberate relationship `read`/`history.read` grants for
appropriate roles, with endpoint/Workspace isolation coverage. Reuse the
existing relationship query/view/history APIs. Showing related links inside
resource `view` is a separate presentation improvement, not evidence that links
cannot be queried. Relational traversal inside resource filters is also a
separate feature.

Evidence:

- `prototypes/project-management-pack/policies/project_access.yaml:56`
- `src/adapters/inbound/cli-cliffy/optctl.ts:2523` and `:2577`
- `spec/query-api.md`: relationship context exposes `from` and `to` UUID fields

### P1 — N5: invalid filter expressions become generic server errors

**Reproduced.** Valid equality succeeds, while all three of these return
`internal_error: query could not be completed`, without details:

```text
title ~ "flight"
title zzz "flight"
title.contains("flight")
```

The adapter wraps errors raised through its application callback and rethrows
the underlying error before the outer `ExpressionError` translation can run. The
application service then turns that unclassified error into a generic internal
error.

**Recommendation:** translate expression errors at the physical adapter boundary
into the existing `invalid_expression` contract. The application already maps
that to `bad_request` with expression context; inventing another error code is
unnecessary. Preserve genuine internal-error sanitization. Add malformed-token,
unsupported-function and valid-filter regressions through the real repository.

**Correction:** the grammar is documented in `spec/expression-language.md`; it
is poorly connected to `query --help`, not absent. Link the existing expression
help/validation surface and summarize the supported subset. Substring matching
is not in the shipped subset; adding it is a separate feature, not just an
error-message fix.

Evidence:

- `src/adapters/outbound/postgres/query_policy_sql.ts:184–199`
- `src/application/services/query_objects.ts:248–280`
- `spec/expression-language.md`: operators and disallowed method calls/regex

### P2 — A11: empty transition input remains compulsory

**Reproduced.** `transition ... --to done --version 2` fails locally with
`transition requires --input <JSON-or-file>`.

**Recommendation:** default transition fields to `{}` when `--to` is provided.
Keep explicit input mandatory for create/update and preserve version, lifecycle,
hook and policy checks. A transition that needs to clear a blocked reason still
needs the corresponding field mutation or the completion action.

The older claim about `changeset stage` accepting only a positional file is
already resolved: `--input` and `--file` exist. Seed selection is intentionally
a different operation and should not gain arbitrary JSON input just for
symmetry.

Evidence: `src/adapters/inbound/cli-cliffy/optctl.ts:362–367`.

## Correct before scheduling: N6 is not a blocked-to-done deadlock

**The advertised edge is reachable.** In the isolated scenario, a blocked task
failed completion with an uncleared reason, then succeeded directly in one
transition using an atomic field update:

```text
optctl --workspace <uuid> transition optd/projects:task <task-uuid> --version 2 --to done --input '{"blocked_reason":"","stage_id":"<done-stage-uuid>"}'
```

`--input` is not unused: it becomes the transition's `set` fields. The existing
`complete_task` action also clears `blocked_reason` in its emitted transition.
No intermediate `in_progress` state is required.

**Genuine smaller gaps:** `blocked_reason: null` is rejected, `blocked → todo`
is not an allowed edge, and the error does not explain the existing atomic
completion path. Nullable reasons and returning an unstarted task to `todo` are
pack-model choices. If accepted, update both the lifecycle and the validation
hook together; do not add a lifecycle edge that the hook still rejects.

Evidence:

- `src/adapters/inbound/cli-cliffy/optctl.ts:400–403`
- `prototypes/project-management-pack/hooks/complete_task.ts:15–23`
- `prototypes/project-management-pack/hooks/validate_task.ts`
- `prototypes/project-management-pack/lifecycles/task_flow.yaml`
- `prototypes/project-management-pack/resources/task.yaml`

## Already shipped or corrected

- **C1, N1, N2:** explicit seed guidance, relationship link/unlink adapters and
  metadata examples, and scoped authorization Workspace slug resolution shipped
  in v0.3.0. Do not automatically initialize seeds during global pack install.
- **A8, C6, C7:** early human pagination notices, required-field summaries and
  action/lifecycle cross-links shipped. JSON remains an envelope; totals remain
  opt-in. Exact per-Workspace seed applied/pending status is a separate
  enhancement.
- **C4:** audited historical imports already exist through
  `create --input ... --initial-state ... --reason ...`, with separate
  permission. Ordinary non-initial creates must remain strict. Put import flags
  after the input value, as the current CLI parser expects.
- **A4:** decision/commit approval parity is implemented and regression-tested.
  The documented super-admin bypass is intentional. The handoff's super-admin
  example does not establish that genuinely unqualified principals can approve.
- **A7:** a scoped Projects administrator successfully selected its Workspace by
  slug in this review.
- **A14/A15/A16:** client/server auth responsibilities and process-boundary
  tests are covered. Shared request-only authority supports an already-running
  harness; v0.3.0 additionally prevents inheriting full credentials above a
  recognized agent harness. No new request-credential injection mechanism is
  needed.
- **N1 error truncation:** not confirmed. JSON probe errors retained nested
  field paths, and the CLI renderer has no explicit truncation here. Obtain the
  exact human-output transcript before changing rendering.
- **Unauthenticated home:** do not expose authenticated inventories merely to
  improve onboarding. Minimal welcome/next-step guidance is a separate polish
  item.

## Don't: weaken boundaries to match a mistaken diagnosis

- Do not globally replace hidden-resource `not_found` responses with detailed
  authorization denials; that changes the documented non-enumeration contract.
- Do not make archives universally visible or grant relationship reads to every
  role without a policy decision and negative tests.
- Do not force totals, auto-seed global pack installs, relax ordinary lifecycle
  creates, or remove the explicit import permission/reason.
- Do not rebuild relationship query APIs or invent a new atomic transition path.
- Do not add unsupported substring syntax to help text as if it already works.

## Verification and limits

- **15 focused unit/integration tests passed**: onboarding release behavior,
  Projects scoped onboarding/import, approval parity, and task completion hooks.
- **20 recorded observations** from a fresh isolated source-runtime/compiled-CLI
  scenario, using public CLI setup and synthetic root/scoped users. The scoped
  identity was explicitly verified as `super_admin: false` with only
  `optd/projects:projects_admin`. Owned server/database/auth state was cleaned
  up.
- This review did not contact the main installation or replay the user's
  original transcript. It used source at the published commit, not the installed
  CLI/server.
- Reproduction output: `/tmp/optd-handoff-review-results.json`.
- Focused test log: `/tmp/optd-handoff-review-tests.log`.
- Prior release CI's 502 passing tests are separate evidence; they do not mean
  the newly reported usability gaps are covered or resolved.
