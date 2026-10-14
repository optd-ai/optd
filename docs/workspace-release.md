# Workspace breaking release (0.2.0)

This release requires a **fresh database**. It does not migrate Project-era
schemas, stages, credentials, local context selections, or installed Pack
revisions. Existing databases are rejected before migration writes with
`workspace_schema_requires_fresh_database`.

Back up any data you want to retain before replacing an installation. Start the
new server with a new data directory (or a fresh external PostgreSQL database),
bootstrap a human administrator, apply the bundled Packs, and recreate access
assignments. Use a fresh local auth/context store and log in again. Do not point
an old client at the new server or a new client at an old server.

## Names and boundaries

- The platform container is **Workspace**: `optctl workspace`, `--workspace`,
  `OPTD_WORKSPACE`, and `context set-workspace`.
- HTTP routes use `/api/v1/workspaces`; request/response boundaries use
  `workspace_id`, `workspace`, and `all_workspaces`.
- Publisher namespaces are unchanged. The Projects Pack is still
  `optd/projects`, and its work-project resource is still
  `optd/projects:project`.
- Inside that Pack, `project_id` now references a work project; it replaces
  `work_project_id`. Platform scope is always `workspace_id`.
- No old boundary names are accepted as compatibility aliases.
- Both bundled Packs have new immutable `0.2.0` revisions.

## Initialize a Workspace

Apply `prototypes/project-management-pack` with `optctl pack apply`, then create
and select a Workspace:

```zsh
optctl workspace create delivery --display-name Delivery
optctl context set-workspace delivery
optctl seed commit optd/projects --all
optctl list optd/projects:task_stage
optctl list optd/projects:task_tag
```

Seeds remain explicit and per-Workspace; repeat application is idempotent. A
Workspace-scoped Projects administrator may initialize them without being a
platform super-admin. Workflow stages are references to the declared lifecycle,
not a free-form workflow editor.

## Completion and historical import

Authorized humans and agents can complete their own tasks without another
approver. Assignment restrictions, lifecycle transitions, unresolved blocks, and
field validation remain enforced. Completion `hours` and `work_date` are
optional together. Omit both to avoid creating a timesheet; supply both to log
time.

To import a previously completed task, use `create` with `--initial-state done`
and a nonblank `--reason`, in addition to its normal `--input` JSON. This
requires both create and import permission, validates the declared lifecycle
state, and records the state/reason in immutable staging and audit history. It
is not available to Actions or hooks and does not weaken ordinary create
validation.

Successful commits expose a `created` map keyed by operation key (or generated
keys such as `op_000001`). Replaying the commit returns the same identities.

## Inspection and local authentication

Lists honor `axi.list.defaultFields`, accept `id` in projections, and announce
additional pages in text output. JSON envelopes retain their normal cursors.
Metadata includes seed rows, required/optional fields, and Action reads and
availability. Use command-specific `--help` for arguments and options.

Linux process inspection resolves its reader through `PATH`, not `/bin/cat`.
Missing helpers produce an explicit inspection-unavailable error. Authentication
anchors to a verified persistent harness or interactive shell. Unknown launchers
must set `OPTD_AUTH_ANCHOR_PID` to their own live PID; a nearer credential or
isolate boundary cannot be bypassed. Temporary command-shell PIDs are not
durable session anchors.

Release publication still requires the clean exact-source gate documented in
[release.md](release.md). These notes do not establish that a release has passed
that gate or has been published.
