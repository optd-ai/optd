# Handoff: papercuts from a first agent-driven onboarding run

**Date:** 2026-10-14
**Versions exercised:** optctl v0.1.3 → v0.1.6 → v0.1.7; server images `ee5e65ba` (v0.1.3) → `4cd6e87c` (v0.1.6) → `f6840b7f` (v0.1.7)
**Host:** NixOS, rootless Docker, home-manager-managed install
**Scenario:** a human (super_admin) and a Claude Code agent collaboratively bootstrapped a server, installed `optd/projects@0.1.0`, created a Project, and loaded ~48 tasks. Everything below was hit in that one session.

Severity: **P0** blocks a reasonable user outright · **P1** costs significant time or produces wrong beliefs · **P2** friction/polish.

---

## A. Platform / optctl

### A1 — P0 — `readProcFile` hardcodes `/bin/cat`, breaking all auth on NixOS

`src/adapters/outbound/process-inspection/linux.ts:45` shells out to a literal `/bin/cat`:

```ts
const output = await new Deno.Command("/bin/cat", { args: [path], ... });
if (!output.success) throw new Deno.errors.NotFound(`proc record is unavailable: ${path}`);
```

On NixOS `/bin` contains only `sh`; `/usr/bin` only `env`. Every process inspection therefore fails, which means **every credential write and every credential selection fails** — `bootstrap init`, `auth login`, `auth request`, `auth wait`. The product is unusable until the user manually creates `/bin/cat` (requires root).

**Fix:** resolve `cat` via `PATH`, or read procfs directly and grant `--allow-read=/proc`. The existing comment explains the subprocess choice was to stay least-privileged; a PATH lookup preserves that.

### A2 — P1 — procfs failures are reported as "process N is gone"

Same file, lines 77–88: any `Deno.errors.NotFound` becomes `ProcessInspectionError("gone", "process ${pid} is gone")`. With A1 present, a perfectly alive PID reports as gone. We spent a long time chasing process-anchoring theories before discovering the real cause was a missing binary.

**Fix:** distinguish "the helper could not be executed" from "the pid does not exist". The former should surface as a configuration error naming the missing executable.

### A3 — P0 — `project.create` / `project.read` bypass the policy engine, contradicting seeded data

`src/application/services/projects/manage_projects.ts:27-35`:

```ts
const authorized = (auth, action) =>
  auth.roles.includes("system:super_admin") ? { ok: true, value: true } : err({...});
```

All four project actions (`read`, `create`, `update`, `archive`) hardcode a string comparison and never consult the policy engine. Meanwhile `src/adapters/outbound/postgres/migrations.ts:697` seeds:

```
('…215','…201','system:admin','project.create','*','unconditional',null)
```

So the database says `system:admin` may create projects and the code says only super_admin may. That row is dead data. A `system:admin` agent cannot even run `optctl project list`.

**Fix:** route these through the policy engine so the seeded grant means something, or delete the seeded row and document the restriction. Current state is the worst of both — it looks grantable and isn't.

### A4 — P0 — `changeset approve` accepts decisions from principals who cannot satisfy the requirement

Reproduced end to end:

1. Agent stages a task `in_progress → done`. Requirement generated:
   `{key: "task_completion", role: "optd/projects:project_manager", boundary: {type: project, …}, principal_types: ["human_user"], allow_initiator: false, minimum: 1}`
2. Human holding **only `system:super_admin` at the system boundary** runs `optctl changeset approve <cs> <req> --reason "…"`.
3. The call **succeeds**. A decision row is written. `status` flips to **`ready`**.
4. `optctl changeset commit <cs>` fails: `approval_changed: current approvals no longer satisfy the stage`.

The approve endpoint should reject at step 2 with something like "principal does not hold optd/projects:project_manager in this boundary". Instead the user gets a recorded approval, a `ready` status, and a commit error whose wording ("no longer") implies something changed after approval when nothing did.

**Confirmed follow-up.** We then granted the human `optd/projects:project_manager` at the project boundary and re-ran `commit` **without re-approving**. It succeeded. So:

- the approve endpoint validates **nothing** about the approver at decision time;
- `commit` re-evaluates the stored decision against **current** role assignments;
- a decision recorded by an unqualified principal becomes **retroactively valid** the moment that principal is granted the role.

That last property is the real defect: an approval is a point-in-time attestation, and backdating its validity undermines the audit trail. The decision row records `principal_id` and `decided_auth_context_id` but its legitimacy is resolved later against mutable state.

**Fix:** validate the approver against the requirement at decision time and persist the satisfying role assignment with the decision; don't mark `ready` unless requirements are genuinely satisfied; reword `approval_changed` to distinguish "never satisfied" from "invalidated by a later change".

### A5 — P1 — default `list` projection requests a field that does not exist

```
$ optctl --project <id> list optd/projects:task_stage
ok: false
error: { code: bad_request, message: "unknown projection field id" }
```

`list` with no `--fields` injects `id`, which is not a valid projection field, so **the bare command fails for every resource**. `query` works, and `list --fields name,state` works. The resource AXI help recommends `query`, which is probably why this went unnoticed.

**Fix:** make the default projection valid (or allow `id` as a projection field, which users will expect anyway — see A8).

### A6 — P1 — `create` does not return the created object's id

A create response returns `id` (changeset id) and `stage_id` (staging id), neither of which is the created object. The only way to learn the new object's id is to re-query and match on a field you hope is unique. This makes scripted/bulk creation awkward and is how we ended up needing title-matching to perform follow-up transitions.

**Fix:** include created object ids (keyed by operation key) in the commit response.

### A7 — P1 — `context set-project <slug>` requires `project.read`, i.e. super_admin

Slug resolution calls `resolveProject`, which needs `project.read` — gated by A3. An agent with full `projects_admin` rights *inside* a project therefore cannot set that project as its context by slug, and must pass raw UUIDs on every single command.

**Fix:** allow slug→id resolution for principals with any assignment in that boundary.

### A8 — P2 — pagination is silent

`query` returns a page (observed cap 50) with `total: null`. We briefly believed there were 50 tasks when there were 144. Nothing in the default human-readable output signals truncation except `has_more`, which is easy to miss.

**Fix:** populate `total`, or print an explicit "showing N of M" line in non-JSON output.

### A9 — P1 — subcommand `--help` documents no options

`optctl bootstrap init --help`, `pack preview --help`, `create --help` etc. all print only `-h, --help`. Required flags (`--username`, `--password-stdin`, `--input`, `--display-name`, `--safe`/`--reviewed`) are discoverable only by triggering a usage error or reading the source. We read the embedded JS out of the compiled binary with `strings` to learn the CLI surface.

**Fix:** declare options per subcommand so help renders them.

### A10 — P2 — misleading usage errors

- `optctl context add --server http://…` → *"context add requires --server <origin>"* — but `--server` **was** supplied; the missing argument is the context **name**, parsed from `positional[2]`. The error names the wrong thing.
- `optctl changeset approve <cs>` (omitting the requirement id) → *"stage id must be a lowercase UUIDv7"*, referring to the *second* positional, not the one supplied.

**Fix:** error on the actually-missing argument.

### A11 — P2 — inconsistent input conventions

`create`/`update`/`transition` take `--input <JSON-or-file>`; `changeset stage` takes a bare positional **file path only** (`changeset stage requires exactly one JSON file`). Inline JSON works in one and not the other.

**Fix:** accept `--input <JSON-or-file>` uniformly.

### A12 — P2 — server always reports `version: 0.1.0-dev`

`status live` / `status ready` reported `0.1.0-dev` on the v0.1.3, v0.1.6 *and* v0.1.7 images. The packaging README already warns about this, which suggests it is known — but it means the one obvious upgrade check is useless, and the only reliable signal is the image digest.

**Fix:** stamp the release version at build time.

### A13 — P2 — migration change kind prints `add_policie`

`pack apply` output contains `kind: add_policie` and `target: { policie: "optd/projects:project_access" }` — naive de-pluralisation of "policies". Cosmetic but user-visible in every pack apply.

### A14 — documentation — process binding is client-side only

`optctl` enforces the process anchor; the **server does not**. A bearer token lifted from a stale/orphaned binding still authenticates fine over plain `curl`. We verified this: after the anchor process died and `auth doctor` reported `process_binding_stale`, the token still returned `ok: true` from `/api/v1/auth/me`. Only explicit `auth revoke` killed it (and revocation *is* correctly enforced).

This is defensible design, but it is easy to assume anchoring is a server-side control. **Fix:** state it plainly in `spec/authentication.md`.

### A15 — regression tests worth adding (all fixed, none covered before)

Three real defects were found and fixed inside 24h across v0.1.4–v0.1.7. Each deserves a test:

- **Anchor walk-up** (fixed 0.1.7): credentials must bind to the nearest recognised harness, not the immediate parent. Verified working — `auth anchor` now resolves a Claude Code tool-shell to the `claude` PID with no `exec` trickery.
- **Missing request credential** (v0.1.6 regression, fixed 0.1.7): `auth login` did not persist an authorization-request credential, so `auth request` returned `authentication_required` and the agent flow was dead.
- **Credential leak on redeem** (≤0.1.6): `auth wait` printed the raw bearer token to stdout, which landed in an agent transcript verbatim. 0.1.7 correctly returns only the authorization and binding.

### A16 — design gap — an agent cannot bootstrap inside an already-running harness

Request-only authority comes from `auth isolate`, which must **wrap the child process at launch**. There is no way to grant request authority to a harness that is already running, so the only remedy is to restart the agent under `optctl auth isolate -- <agent>`. For long-lived interactive sessions (and for a `claude --resume`, which mints a new PID) this is a recurring tax.

Worth considering: a human-initiated `auth grant-request --pid <ancestor>` that deposits request-only authority into an existing tree the human can name.

---

## B. Rename: platform `Project` is a namespace, and the name collides

### The problem

Two distinct concepts share one word:

| Concept | What it is | Fields |
|---|---|---|
| Platform **`Project`** | authorization boundary + data namespace; the `--project` flag; boundary types `project` / `all_projects` | `id, slug, displayName, description, status, version, createdAt, updatedAt, archivedAt` |
| **`optd/projects:project`** | a *work project* record living inside one | `name, status, owner_id, visibility, start_date, target_date, description` |

The pack also has `work_project_id` foreign keys, which exist only to disambiguate from the platform's `project_id`. A new user reads `credential is not authorized for project.create` as "I can't make a project" when it means "I can't make a namespace".

### Collision analysis of candidate names

Measured against the current tree (`grep -ril` over `src/`):

| Candidate | `src/` files | `migrations.ts` hits | Verdict |
|---|---|---|---|
| `namespace` | 6 | 20 | ❌ **Collides.** Already a column: `pack_revisions(namespace, name, active)`, part of `primary key(revision, namespace, name)`; also used in `policy_engine.ts`, `resource_ddl.ts`, `hook_runner.ts`, `outbox_processing_repository.ts`. Reusing it for the boundary would overload a term that already means "pack publisher namespace". |
| `scope` | 0 | 0 | ⚠️ Mechanically free, but semantically overloaded in an authz codebase that already has capabilities, boundaries and authorization contexts. "Scope" will be read as OAuth-style permission scope. |
| `workspace` | 0 | 0 | ✅ Clean. |
| `tenant` | 0 | 0 | ✅ Clean and accurate (it *is* the multi-tenancy unit). |
| `realm` | 0 | 0 | ✅ Clean, though Keycloak-flavoured. |

### Recommendation

**`Workspace`** — mechanically free, immediately legible to users as "a container my stuff lives in", and it does not pretend to be an authz primitive the way `scope` does. **`Tenant`** is the runner-up and is more precise, but reads as operator-facing rather than user-facing.

Explicitly **avoid `namespace`** (real collision) and **avoid `scope`** (semantic collision with authorization vocabulary).

### Rename surface

- `Project` domain type, `ProjectStatus`, `ProjectRepository`, `manage_projects.ts`
- actions `project.read|create|update|archive`
- CLI: `optctl project *` group, the global `--project` flag, `OPTD_PROJECT` env var, `context set-project`
- boundary types `project` / `all_projects` → `workspace` / `all_workspaces`
- DB `project_id` columns and the `projects` table
- **pack-side:** `work_project_id` can revert to plain `project_id` once the collision is gone — which is a good test of whether the rename actually worked.

Suggested sequencing: rename the platform concept first, leave `optd/projects:project` alone (it is correctly named), then drop the `work_` prefix in a follow-up pack revision.

---

## C. Pack `optd/projects@0.1.0`

### C1 — P0 — seeds are declared but never applied; a fresh install cannot create a task

`seeds/task_stages.yaml` declares four rows (`todo`/`in_progress`/`blocked`/`done`, sequences 10/20/30/90) and `seeds/task_tags.yaml` declares four tags, both `mode: changeset`. After a clean `pack apply` reporting `add_seed … status: ready` for both:

```
$ optctl --project <id> query optd/projects:task_stage
data: { items: [] }

$ optctl metadata seed optd/projects:task_stages
data: { …, resources: [] }
```

Zero rows. Because `task.stage_id` is **required** and references `task_stage`, **no task can be created at all** until an operator hand-builds the stages. We created all four manually before anything worked.

**Fix:** apply seed rows during `pack apply` (or at first project creation), and make `metadata seed` show the declared rows rather than an empty `resources: []`.

### C2 — P0 — agents cannot complete tasks, and we want them to

The generated requirement for `in_progress → done` is:

```json
{ "key": "task_completion",
  "role": "optd/projects:project_manager",
  "principal_types": ["human_user"],
  "allow_initiator": false,
  "minimum": 1 }
```

`principal_types: ["human_user"]` makes this structurally impossible for an agent regardless of role. An agent that did 100% of the work cannot record that the work is done, so an agent-maintained task list silently rots at `in_progress`.

**Desired:** agents should be able to close tasks.

Options, roughly in order of preference:

1. Add `agent_user` to `principal_types` for `task_completion`, and let the *policy* decide authority. An agent acting under a human's authorization lineage (`root_authorization_id`, `authorization_ancestry_ids`) is already attributable.
2. Make `principal_types` a pack-author knob with a documented default rather than a hardcoded value, so operators can choose.
3. Keep the human gate only where it earns its keep — e.g. require it when `spent_hours` is being written (a billing-adjacent fact) but not for a plain state change.

Note `allow_initiator: false` is a separate, defensible control: agent stages → human approves is a reasonable pattern. But today the agent is excluded from *both* sides, which is stricter than intended.

### C3 — P1 — `projects_admin` and `project_manager` are not nested, and the "admin" is weaker

From `policies/project_access.yaml`:

| | `projects_admin` | `project_manager` |
|---|---|---|
| read / create / update / archive / transition / comment | ✅ | ✅ |
| `link` / `unlink` | ✅ | ❌ |
| `changeset.approval.decide` | ❌ | ✅ |

Neither is a superset. The role named *admin* **cannot approve task completion**, while the role named *manager* can but cannot attach tags or milestones. We picked `projects_admin` specifically for `link`/`unlink` (tags, milestones) and consequently could not complete a single task.

**Fix:** make `projects_admin` a strict superset of `project_manager`, or rename to make the split explicit.

### C4 — P1 — no way to create a record in a non-initial lifecycle state

```
$ optctl … create optd/projects:task --input '{"state":"done", …}'
ok: false
error: { code: operation_conflict, message: "Create lifecycle field conflicts with initial state" }
```

Reasonable for interactive use, painful for **import/migration**, which is exactly what an agent does when it moves an existing list into optd. Loading 11 already-completed items required create → `transition` → `transition` (because `todo → done` is not a legal edge), i.e. 33 operations and 11 human approvals for work that was already finished before the tool existed.

**Fix:** an explicit import/backfill path (`--initial-state`, admin-gated), or a bulk seed-style loader.

### C5 — P1 — `complete_task` forces timesheet entry

`actions/complete_task.yaml` requires `spent_hours` (0.01–24.00, so **zero is not expressible**) and `entry_date`, and the hook creates a `timesheet` row. For administrative work ("join Slack channels", "enable the team calendar") there is no meaningful hours figure, and fabricating one pollutes timesheet data.

**Fix:** make `spent_hours`/`entry_date` optional, and only create the timesheet row when supplied.

### C6 — P2 — `metadata resource` field ordering buries required fields

Fields come back unordered, so `work_project_id` (required) and `blocked_reason` appeared *below* optional fields. Reading the first screen of `metadata resource optd/projects:task` and building a create payload from it produces a `validation_failed` on a required field you never saw.

**Fix:** sort required fields first, or group `required` / `optional`.

### C7 — P2 — `availability` and lifecycle disagree in presentation

`complete_task` declares `availability.states: [in_progress, blocked]`, and the lifecycle does permit `blocked → done` (`blocked_to_done_6`). Correct — but the lifecycle's six transitions are only visible via `metadata lifecycle`, and nothing cross-references them from the action. A summary table (`from → to`, which action drives it) in `metadata lifecycle` would help.

---

## D. What a fix-up agent should verify afterwards

1. On a NixOS box with no `/bin/cat`: `bootstrap init`, `auth login`, `auth request`, `auth wait` all succeed. (A1/A2)
2. `system:admin` can `project list` — or the seeded `project.create` grant is deleted and the restriction documented. (A3)
3. `changeset approve` by a principal lacking the required role is **rejected at decision time**, not at commit. (A4)
4. `optctl list <resource>` with no `--fields` succeeds. (A5)
5. `pack apply` on a clean server yields four `task_stage` rows and four `task_tag` rows, and a task can be created immediately with no manual setup. (C1)
6. An agent principal can take a task to `done` under some supported configuration. (C2)
7. `projects_admin` can do everything `project_manager` can. (C3)
8. Renaming `Project` does not collide with `pack_revisions.namespace`. (B)
