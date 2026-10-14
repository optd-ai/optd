# Platform Workspaces

Authoritative contract; edit this specification directly.

## Exact migrated contract

<a id="obj-com-exact-projects-v1"></a>

### Exact v1 contract — Platform Workspaces

**Migration provenance.** Exact normative contract imported from
`spec/projects.md` at
`sha256:28c4f76c1ab344d7cff1f0a36fcf5adee19095466087d726190e917fd81dc38e`. Text
explicitly labeled historical, research, prototype evidence, or deferred remains
non-normative; all other versioned requirements below preserve the imported
contract semantics as maintained directly in these specifications.

## Decision

A platform Workspace is the runtime data and authorization boundary. It is a
built-in system resource, not a pack installation and not the
`optd/projects:project` proof-pack domain object.

Packs and their active definitions are global. A workspace's existence does not
copy definitions or automatically apply seeds.

## Record

```text
workspaces
- id             uuid primary key                 # server UUIDv7
- slug           text not null unique
- display_name   text not null
- description    text null
- status         text not null                    # active | archived
- version        bigint not null
- created_by_auth_context_id uuid not null
- updated_by_auth_context_id uuid not null
- created_at     timestamptz not null
- updated_at     timestamptz not null
- archived_at    timestamptz null
```

- `slug` is lowercase `[a-z][a-z0-9-]{0,62}` and immutable after creation.
- `display_name` is 1–120 Unicode characters after trim.
- `description` is optional and has a configurable size guardrail.
- IDs are canonical at the API/storage boundary. `optctl --workspace <slug>` may
  resolve a slug to ID and stores that ID in local context alongside the label.
- There is no hard delete or unarchive in MVP.

## Lifecycle

- `workspace.create` creates an active workspace.
- `workspace.update` changes display name/description with expected `version`.
- `workspace.archive` changes active to archived with expected `version`.
- Repeating archive on an archived workspace returns its current representation
  without a second state transition.

Reading/listing/creating/updating/archiving uses exact audited system actions
`workspace.read`, `workspace.create`, `workspace.update`, or
`workspace.archive`, not domain changeset operations. List only returns
workspaces visible under current assignments/policy. It uses the shared
auth-context and error contracts. The final useful workspace is not specially
protected; the last-human-super-admin invariant remains independent.

## Runtime behavior

- Every domain object, relationship, comment, query, role/policy assignment
  boundary, object version, event, and relevant stage operation has explicit
  workspace identity.
- New object/action/seed staging against an archived workspace fails
  `workspace_inactive`. Reads/history remain available when policy allows.
- Stage records pin the workspace's ID and version/state as a dependency. Commit
  locks workspace rows in canonical UUID order and requires them still active;
  concurrent archive serializes and makes a later incompatible commit stale.
- Archiving a workspace does not cancel already running outbox deliveries;
  durable committed work follows the pinned outbox contract.
- Cross-workspace changesets are allowed only when every operation names a
  workspace and current authorization/policy covers every boundary.

## API DTOs

`POST /api/v1/workspaces`:

```json
{
  "slug": "sales",
  "display_name": "Sales",
  "description": "CRM operating data"
}
```

`POST /api/v1/workspaces/{workspace_id}/update`:

```json
{
  "expected_version": 3,
  "display_name": "Revenue Operations",
  "description": null
}
```

At least one mutable field must be present; unknown fields fail.

`POST /api/v1/workspaces/{workspace_id}/archive`:

```json
{
  "expected_version": 4
}
```

List defaults to active workspaces and accepts strict
`status=active|archived|all`, optional exact `slug`, and cursor pagination.
Exact slug lookup returns zero/one item and is how CLI resolves workspace
context. Callers never provide owner/principal/role fields in workspace DTOs.

## CLI

```text
optctl workspace list
optctl workspace create sales --display-name "Sales"
optctl workspace view sales
optctl workspace update sales --display-name "Revenue Operations" --expected-version 3
optctl workspace archive sales --expected-version 4
optctl context set-workspace sales
```

The first created workspace may become the local default only under the explicit
client-context rule in `authentication.md`; the server does not infer workspace
from process evidence.

## Fresh-install Workspace cutover

This is a breaking release, not a compatibility migration. Project-era databases
are rejected before schema writes with workspace_schema_requires_fresh_database.
Operators must back up wanted data and initialize a fresh database. The public
boundary is workspace_id, all_workspaces, /api/v1/workspaces, optctl workspace,
--workspace, and OPTD_WORKSPACE. Old Project boundary aliases are not accepted.
Publisher namespaces do not change. The Projects pack keeps
optd/projects:project, with project_id denoting a work-project reference rather
than platform scope.
