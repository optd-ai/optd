# Handoff: papercuts remaining after v0.2.2 / `optd/projects@0.2.0`

**Date:** 2026-10-14
**Supersedes the open items in:** `handoff-papercuts-2026-10-14.md`
**Exercised on:** optctl v0.2.2, server image `f6840b7f`→`63031e42`, pack `optd/projects@0.2.0`, fresh `optd-home-workspaces-v02` volume
**Scenario:** bootstrap → agent authorization → seed → migrate 89 onboarding tasks (23 done, 6 blocked, 1 in progress, 59 todo) with 7 tags, 47 tag links, and 5 milestones, driven end-to-end by an agent.
**Also covers:** subsequent day-to-day agent use of the same workspace — repeated `view`/`update`/`transition` cycles against individual tasks, plus `query --where` filtering for a generated dashboard. Findings from that phase are marked *New in this run*.

---

## Closed since the last handoff — do not re-investigate

Verified fixed in this run. Listed only so nobody spends time on them again.

| Ref | Was | Now |
|---|---|---|
| A1 | `/bin/cat` hardcoded, unusable on NixOS | `Deno.Command("cat", { env: { PATH } })` |
| A2 | procfs failure reported as "process N is gone" | `process inspection requires executable cat on PATH` |
| A3 | `project.create` hardcoded `super_admin`, contradicting a seeded policy row | hardcoded check removed from `manage_workspaces.ts`; flows through the policy layer |
| A5 | bare `list <resource>` failed with `unknown projection field id` | works; `id` is a valid projection field |
| A6 | `create` did not return the created object id | returns `created: { op_000001: <id> }` |
| A12 | server always reported `0.1.0-dev` | reports `v0.2.2` |
| A13 | `add_policie` pluralisation | mapped correctly |
| B | `Project` namespace vs `optd/projects:project` collision | `workspace` throughout; pack's `work_project_id` → `project_id` |
| C2 | agents structurally could not close tasks | agents complete their own tasks, **no approval** — verified `todo → in_progress → done` |
| C3 | `projects_admin` lacked `changeset.approval.decide` | added to `project_manager_approval` |
| C5 | `complete_task` forced `spent_hours` ≥ 0.01 | `spent_hours` and `entry_date` optional |

**Impact of C2 alone:** migrating 23 already-complete tasks cost **zero** human approvals. In the previous release the same work required 11 manual stage-and-approve round trips.

**A6 deserves a specific call-out.** Returning created ids is what made bulk work practical — the previous release forced a query-back-and-match-on-title step, which is how a duplicate-creation bug slipped in last time.

---

## Correction to the previous handoff

### ~~C1 — "seeds are declared but never applied"~~ → **re-filed as a discoverability defect**

**The previous report was wrong.** Seeds are not broken. They require an explicit reconciliation step:

```
optctl --workspace <id> seed commit optd/projects --all
```

That created all 8 rows (4 `task_stage`, 4 `task_tag`) and returned their ids keyed by seed name
(`task_stages_0 … task_tags_7`).

The real defect is that **nothing tells you this step exists**:

- `pack apply` reports `kind: add_seed … status: ready` for each seed, which reads as "applied".
- `optctl metadata seed optd/projects:task_stages` returns `resources: []` — it shows neither the
  declared rows nor any hint that they are pending.
- No AXI `help` entry on the pack, the seeds, or `task_stage` mentions `seed commit`.

Consequently the previous run concluded seeds were broken and hand-built four `task_stage` rows that
the seed command would have created correctly.

**Two wrong guesses were needed to find the right invocation**, both with unhelpful errors:

| Attempt | Result |
|---|---|
| `seed commit optd/projects:task_stages` | `usage_error: expected pack identity publisher/pack, got optd/projects:task_stages` |
| `seed commit optd/projects` | `validation_failed: seed selection must use exactly one of all or unique names` |
| `seed commit optd/projects --all` | ✅ |

**Fix:** either apply seeds during `pack apply`, or surface the pending state — have `metadata seed`
list declared rows and their applied/pending status, and add `optctl seed commit <publisher>/<pack> --all`
to the pack's AXI `help`. The second error should name `--all` as the option it wants.

---

## New — P1

### N1 — The `link` operation shape is undiscoverable, and has no CLI subcommand

`link`/`unlink` are first-class actions in the pack policy (`projects_admin` has both), but there is no
`optctl link` / `optctl unlink` command. Relationships can only be created by hand-authoring a changeset
operation, and the required shape is documented nowhere.

The correct shape, recovered from `src/adapters/outbound/postgres/commit_repository.ts:1435`:

```json
{ "op": "link",
  "workspace_id": "<ws>",
  "relationship": "optd/projects:task_tag_assignment",
  "from": "<task id>",
  "to": "<tag id>",
  "fields": { "source": "..." } }
```

`relationship_id` is server-allocated — do not supply it.

The natural guess, by analogy with resource `create`, is to put the endpoints in `fields`:

```json
{ "op": "create", "relationship": "...", "fields": { "task_id": "...", "task_tag_id": "..." } }
```

That fails with `validation_failed: request does not satisfy its contract`. The response carries
`details.issues[].path`, but the CLI's rendering truncates it, so the operator sees only the generic
message and cannot tell which field is wrong.

Compounding it: `metadata relationship optd/projects:task_tag_assignment` reports
`from: {resource: task}`, `to: {resource: task_tag}` and `schema.fields: {source}` — accurate, but it
never says those map to top-level `from`/`to` keys rather than schema fields.

**Fix:** add `optctl link <relationship> --from <id> --to <id>` and `unlink`; render
`details.issues[].path` in CLI error output; add an AXI example to relationship metadata.

### N2 — An agent cannot discover the workspace id it needs to request a workspace-scoped role

Bootstrapping a workspace-scoped agent has a circular dependency:

1. `auth request --workspace <uuid>` requires the workspace **UUID**.
2. `workspace list` requires a bearer credential — which the agent does not yet have.
3. `auth request --workspace personal` (slug) fails with
   `validation_failed: authorization request is invalid` — which does not mention that a UUID is required,
   or that the slug was the problem.

So the id must be pasted in by a human. That is tolerable once, but it is the only step in the whole
agent-authorization flow that cannot be self-served, and the error gives no clue why.

**Fix:** accept a slug in `auth request --workspace` (the server can resolve it; the requester is already
proving identity with the request credential), or make the error say
`workspace must be a UUIDv7; slugs are not accepted here`.

### N3 — `--include-archived` exists but cannot be used, making `archive` an irreversible hard delete

`archive` is a first-class policy verb (`projects_admin` has it) and reads as the natural "close without
completing" action. In practice it removes the object from **every** read path, including its comments.

A flag for this already exists — `command_help.ts:43` documents `--include-archived` as
*"Include archived rows when authorized"*, and `optctl.ts:259` parses it into `payload.include_archived`.
It is nonetheless unusable:

| Command | Result with `--include-archived` |
|---|---|
| `list <resource>` | `not_found: requested workspace or definition was not found` |
| `query <resource>` | `not_found: requested workspace or definition was not found` |
| `view <resource> <id>` | `usage_error: view does not accept additional options` |
| `history <resource> <id>` | `usage_error: unknown history option --include-archived` |

The identical query **without** the flag succeeds, so the flag itself is what fails the call.

The likely cause is authorization, not lookup: `query_policy_sql.ts:236` requires
`["read", "read_archived"]` when `include_archived` is set, and **`optd/projects@0.2.0` grants
`read_archived` to none of its four roles** (`grep -c read_archived policies/project_access.yaml` → 0).
So the flag can never be satisfied by any role the pack ships, and the failure is reported as
`not_found` rather than a policy denial — the same misleading code returned for a genuinely absent
definition.

**Observed consequence.** A task was archived to mean "closed, not completed, resurrect later", with a
comment recording why. Afterwards `view` and `history` both returned `not_found: object not found`, so
the task *and its explanatory comment* were unreachable, with no documented way back. The task had to be
recreated and marked `done` instead, leaving an orphaned archived row that no read path can see.

**Fix:**
1. Grant `read_archived` to `projects_admin` (and probably `viewer`) in the pack policy — otherwise the
   flag is dead code for every pack consumer.
2. Accept `--include-archived` on `view` and `history`, not just `list`/`query`. Inspecting one archived
   object by id is the main thing anyone wants after archiving something.
3. Return `authorization_insufficient` with the missing action named, rather than `not_found`, when
   `read_archived` is absent.

Until then, `archive` should be treated as destructive, and "closed but not done" has no safe
representation — `done` is the only readable terminal state.

### N4 — Tag/relationship links are write-only

52 `task_tag_assignment` links were created and committed successfully. None of them can be read back:

- `query optd/projects:task_tag_assignment` → `not_found: requested workspace or definition was not found`,
  even though `metadata pack optd/projects` lists `task_tag_assignment` as an active relationship and
  `metadata relationship` describes it correctly.
- `view` and `history` on a tagged task show no tag, link or relationship information at all.
- `--where` supports only exact scalar comparison (`priority == "urgent"` works; `title contains "Ramp"`
  fails with `query could not be completed`), so there is no way to filter by anything relational.

Net effect: tags can be written but never queried, listed, or displayed, which makes them useless for
their obvious purpose — categorising work and filtering by category. The same applies to
`task_milestone`, so milestones are equally unreadable.

The workaround was to split work across two `optd/projects:project` records and filter on `project_id`,
which **is** a queryable scalar. That works, but it forces a taxonomy into the project hierarchy that
belongs in tags, and it only supports one dimension.

**Fix:** make relationships queryable (`query <relationship>` with from/to filters), and surface a
task's links in `view`. Without a read path, `link`/`unlink` are write-only verbs.

### N5 — Every `--where` operator failure is reported as `internal_error`, and the grammar is undocumented

Any operator the filter parser does not recognise produces an opaque server-fault error rather than a
usage error naming the problem:

```console
$ optctl ... query optd/projects:task --fields title --where 'title ~ "flight"'
{"ok": false, "error": {"code": "internal_error",
 "message": "query could not be completed", "details": {}}}
```

The key observation is that this is **not specific to `~`**. A deliberately nonsense operator returns
byte-identical output:

```console
$ optctl ... query optd/projects:task --fields title --where 'title zzz "flight"'
{"ok": false, "error": {"code": "internal_error",
 "message": "query could not be completed", "details": {}}}
```

while a known-good operator succeeds:

```console
$ optctl ... query optd/projects:task --fields title --where 'project_id == "<id>"'
{"ok": true, ...}   # 50 items
```

So the parser is failing closed and laundering a *usage* error into an *internal* one, with `details`
empty. Three distinct things are indistinguishable from the caller's side: an unsupported operator, a
malformed expression, and a genuine server fault. `internal_error` also reads as "retry later", which
is the wrong remediation — retrying never helps.

Compounding it, `query --help` documents `--where` only as `<expression>` — "Filter expression." There
is no operator list, no grammar, and no pointer to one. I could not find the supported set documented
anywhere under `spec/` or `docs/`. The only way to learn that `~` is unsupported is to try it and
receive an error that does not say so.

Practical cost: having no substring match and no way to discover that, agent-side filtering falls back
to fetching every row and matching in the client, which drags A8 in behind it — you must also know to
paginate or pass `--include-total`, or you silently filter over the first 50 rows only.

**Fix:** return `usage_error` with the offending token and the supported operator set in `details`; list
the grammar in `query --help`. Separately, confirm whether a substring/`contains` operator exists at all
— if not, that is a feature gap worth its own ticket, since "find the task whose title mentions X" is a
basic need and currently has no server-side answer.

### N6 — `blocked` is a one-way door: the declared `blocked → done` edge is unreachable

Three constraints on `blocked_reason` interact to make one of the pack's own lifecycle edges
impossible to traverse. Each is defensible alone; together they deadlock.

The lifecycle declares six transitions (`metadata lifecycle optd/projects:task_flow`):

```
todo        -> in_progress        todo        -> blocked
blocked     -> in_progress        in_progress -> blocked
in_progress -> done               blocked     -> done        <-- declared, but unreachable
```

Verified on a scratch task created for the purpose:

```console
$ # set blocked_reason, transition to blocked
  OK

$ optctl ... transition optd/projects:task <id> --version N --to done --input '{}'
  blocked_reason_unresolved     # "Done tasks must have no active blocked_reason."

$ optctl ... update optd/projects:task <id> --version N --input '{"blocked_reason":""}'
  blocked_reason_required       # cannot clear it while the task is blocked
```

So `done` requires an empty `blocked_reason`, and `blocked` requires a non-empty one, and nothing
can satisfy both. `blocked → done` is advertised in the lifecycle and can never be taken. The only
exit from `blocked` is the three-step `blocked → in_progress`, clear the reason, `→ done` — which
misrepresents history, since the task was never actually worked on after being unblocked.

**Two further papercuts in the same area:**

**`blocked_reason` cannot be unset, only blanked.** `{"blocked_reason": null}` is rejected with
`Field 'blocked_reason' is not nullable`; only `""` is accepted. Every task that was ever blocked
therefore carries an empty-string field forever, and `blocked_reason == ""` is indistinguishable
from "never blocked" when querying.

**`blocked → todo` is not an edge.** An item that stops being blocked but has not been started
cannot return to `todo`; the only forward edge is `blocked → in_progress`. "Unblocked but not yet
picked up" is unrepresentable, so dashboards either overstate work-in-progress or need a synthetic
convention. This bit a real list: four tasks unblocked at once all had to claim `in_progress`.

**Ordering is enforced but undocumented.** The only valid sequence is transition-then-clear. Nothing
in `metadata resource optd/projects:task`, the lifecycle, or the error text says so — the two errors
each name a rule but neither names the other, so the ordering has to be inferred from hitting both.

**Fix:** let the `blocked → done` transition clear `blocked_reason` as part of the transition (the
transition already takes `--input`, which is otherwise empty here — see A11); make `blocked_reason`
nullable so "not blocked" is representable; and add `blocked → todo`. At minimum, make
`blocked_reason_unresolved` say *how* to resolve it.

---

## Still open from the previous handoff

### C4 — No way to create a record in a non-initial lifecycle state

Unchanged, and now measured. Importing 89 tasks required `create` for all of them plus:

- 23 `done` tasks × 2 transitions (`todo → in_progress → done`, since `todo → done` is not a legal edge)
- 6 `blocked` tasks × 1 transition
- 1 `in_progress` × 1 transition

That is **142 operations to represent 89 facts**, for work that was already complete before the tool
existed. `create` with `state: "done"` returns
`operation_conflict: Create lifecycle field conflicts with initial state`.

**Fix:** an admin-gated `--initial-state`, or a bulk import path that writes terminal states directly.
This matters specifically for agent-driven migration, which is the main way existing work arrives.

### A8 — Pagination is silent — **amended, my earlier fix suggestion was wrong**

`query`/`list` return a page (observed cap 50) with `total: null`. Only `has_more`/`next_cursor` signal
truncation, and neither is prominent in human-readable output. In the previous run this caused 144 rows
to be misread as 50.

**Correction:** I previously proposed "populate `total`". That capability **already exists** — `query`
accepts `--include-total`, and it works:

```console
$ optctl ... query optd/projects:task --where 'project_id == "<id>"'
meta: {"has_more": true, "total": null, ...}          # 50 items

$ optctl ... query optd/projects:task --where 'project_id == "<id>"' --include-total
meta: {"has_more": true, "total": 56, ...}            # 50 items
```

So the defect is narrower than stated, and is **the same shape as N3**: the capability is present but
off by default and invisible at the point of use. `--include-total` is listed in `query --help`, but
nothing in the *output* of a truncated query suggests it exists — you get `total: null` with no hint
that a flag would fill it in. An agent reading `total: null` reasonably concludes the server cannot
count, which is exactly the inference that produced the 144-vs-50 error.

**Revised fix:** either default `--include-total` on (and let callers opt *out* for expensive counts),
or make `total: null` self-describing — e.g. `"total": null, "total_hint": "pass --include-total"`.
At minimum, non-JSON output of a truncated page should print `showing 50 of ? — pass --include-total`.

This is the third instance of one pattern (N3 `--include-archived`, N4 tag links, A8 `--include-total`):
**a working capability that is unreachable from the output of the command that needed it.**

### A11 — Inconsistent input conventions

`create`/`update`/`transition` take `--input <JSON-or-file>` and accept inline JSON.
`changeset stage` takes a **bare positional file path only** (`changeset stage requires exactly one JSON file`).
`seed commit` takes neither. Scripting across them needs three different calling conventions.

**New in this run — `transition` requires `--input` even when it carries no data.** A state change that is
fully specified by `--to` is still rejected:

```console
$ optctl --workspace <ws> transition optd/projects:task <id> --version 6 --to in_progress
{"ok": false, "error": {"code": "usage_error",
 "message": "transition requires --input <JSON-or-file>"}}

$ optctl --workspace <ws> transition optd/projects:task <id> --version 6 --to in_progress --input '{}'
{"ok": true, ...}
```

`--input '{}'` is pure ceremony here: `--to` already names the destination state and `--version` already
carries the concurrency check, so there is no field data left to supply. Unlike `create`/`update`, which
genuinely need a payload, the common `transition` case has none. This is worth separating from the
convention mismatch above because the fix is different — the others need **alignment**, this one needs
`--input` to become **optional when `--to` is present**.

The error message does name the missing flag, so it costs one failed call rather than a debugging session.
But it is the kind of thing that breaks naive scripting: a caller that builds `transition` invocations
from `--to` alone works for zero resources, and `{}` is not an obvious thing to think to pass.

**Fix:** default `--input` to `{}` when `--to` is supplied.

### A14 — Process binding is client-side only (documentation)

Still worth stating plainly in `spec/authentication.md`: `optctl` enforces the process anchor; the server
does not. A token taken from a stale binding still authenticates. Only `auth revoke` invalidates it.

---

## Unverified in this release

### A4 — `changeset approve` accepted a decision from a principal who could not satisfy the requirement

Previously confirmed: the approve endpoint recorded a decision from a human holding only
`system:super_admin` against a requirement demanding `optd/projects:project_manager`, flipped status to
`ready`, then failed at commit with `approval_changed`. Granting the role later made the **already-recorded**
decision valid retroactively.

**Not retested here**, because pack 0.2.0 no longer requires approval for task completion, so the path
did not arise. The defect is in the approval engine rather than the pack, so it is probably still present.

**Worth a regression test regardless:** a decision by a principal lacking the required role should be
rejected at decision time, and the satisfying role assignment should be persisted with the decision so
validity cannot be backdated.

---

## Minor / judgement calls

- **`optctl home` now requires authentication.** In 0.1.x it returned active packs, resources and
  capabilities unauthenticated; it now returns nothing. Probably intended, but it removes the only
  pre-auth way to confirm a pack applied, and `home` is what the CLI's own usage text points you at
  first (`optctl --help` → "run optctl home").
- **`metadata resource` field ordering** (prev. C6) still lists required fields interleaved with optional
  ones. Reading the first screen of `metadata resource optd/projects:task` and building a payload from it
  still misses `project_id`.
- **Lifecycle/action cross-reference** (prev. C7): `complete_task` declares
  `availability.states: [in_progress, blocked]` and the lifecycle does permit `blocked → done`, but the
  six transitions are only visible via `metadata lifecycle`, with nothing linking the two.

---

## Suggested verification for whoever picks this up

1. `pack apply` on a clean workspace yields usable `task_stage` rows **without** a separate command — or
   `metadata seed` clearly reports them as pending and names the command. (C1 re-filed)
2. `optctl link`/`unlink` exist, and a malformed relationship operation names the offending field. (N1)
3. `auth request --workspace <slug>` either works or explains itself. (N2)
4. A bulk import can create a terminal-state record in one operation. (C4)
5. `changeset approve` by an unqualified principal fails at decision time. (A4)
6. `transition --to <state>` succeeds without `--input`. (A11)
7. An unsupported `--where` operator returns `usage_error` naming the token, not `internal_error`. (N5)
8. A truncated `query` tells the caller how to get a total, rather than reporting `total: null`. (A8)
9. A blocked task can reach `done` in one transition, and `blocked_reason` accepts `null`. (N6)
