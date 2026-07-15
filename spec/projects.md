# Platform Projects

## Decision

A platform Project is the runtime data and authorization boundary. It is a
built-in system resource, not a pack installation and not the
`operant/projects:project` proof-pack domain object.

Packs and their active definitions are global. A project's existence does not
copy definitions or automatically apply seeds.

## Record

```text
projects
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
- IDs are canonical at the API/storage boundary. `optctl --project <slug>` may
  resolve a slug to ID and stores that ID in local context alongside the label.
- There is no hard delete or unarchive in MVP.

## Lifecycle

- `project.create` creates an active project.
- `project.update` changes display name/description with expected `version`.
- `project.archive` changes active to archived with expected `version`.
- Repeating archive on an archived project returns its current representation
  without a second state transition.

Reading/listing/creating/updating/archiving uses exact audited system actions
`project.read`, `project.create`, `project.update`, or `project.archive`, not domain changeset operations. List only
returns projects visible under current assignments/policy. It uses the shared auth-context and error contracts.
The final useful project is not specially protected; the last-human-super-admin
invariant remains independent.

## Runtime behavior

- Every domain object, relationship, comment, query, role/policy assignment
  boundary, object version, event, and relevant stage operation has explicit
  project identity.
- New object/action/seed staging against an archived project fails
  `project_inactive`. Reads/history remain available when policy allows.
- Stage records pin the project's ID and version/state as a dependency. Commit
  locks project rows in canonical UUID order and requires them still active;
  concurrent archive serializes and makes a later incompatible commit stale.
- Archiving a project does not cancel already running outbox deliveries; durable
  committed work follows the pinned outbox contract.
- Cross-project changesets are allowed only when every operation names a project
  and current authorization/policy covers every boundary.

## API DTOs

`POST /api/v1/projects`:

```json
{
  "slug": "sales",
  "display_name": "Sales",
  "description": "CRM operating data"
}
```

`POST /api/v1/projects/{project_id}/update`:

```json
{
  "expected_version": 3,
  "display_name": "Revenue Operations",
  "description": null
}
```

At least one mutable field must be present; unknown fields fail.

`POST /api/v1/projects/{project_id}/archive`:

```json
{
  "expected_version": 4
}
```

List defaults to active projects and accepts strict
`status=active|archived|all`, optional exact `slug`, and cursor pagination. Exact
slug lookup returns zero/one item and is how CLI resolves project context. Callers never provide owner/principal/role fields in
project DTOs.

## CLI

```text
optctl project list
optctl project create sales --display-name "Sales"
optctl project view sales
optctl project update sales --display-name "Revenue Operations" --expected-version 3
optctl project archive sales --expected-version 4
optctl context set-project sales
```

The first created project may become the local default only under the explicit
client-context rule in `authentication.md`; the server does not infer project
from process evidence.
