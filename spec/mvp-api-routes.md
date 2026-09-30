<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-mvp-api-routes; contract: 1; input: sha256:0aabb5bcfd77e2df616ffd9d01579b8b11d63f611678f8a81f00b55bed36fb11 -->

# MVP API Routes

Generated exact-contract projection imported into project-model/model.json from the reviewed mvp-api-routes.md source.

## Exact migrated contract

<a id="obj-com-exact-mvp-api-routes-v1"></a>

### Exact v1 contract — MVP API Routes

**Migration provenance.** Exact normative contract imported from `spec/mvp-api-routes.md` at `sha256:b6b7896c05a6ad08e8d376ba91956fa19a2c598d31017cff005bda479f0e17d6`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Decision

The MVP uses resource-oriented JSON routes under `/api/v1`. `optctl` is a typed
client and TOON renderer over these contracts. All responses use
[API Response and Error Contract](api-errors.md); auth-specific DTOs are frozen
in [Authentication API](auth-api.md).

Definition identities are publisher-qualified. Runtime project is always a
separate UUID/body/path value. The API has no user-facing `namespace`, dotted
identity alias, actor header, role header, or combined stage-and-commit route.

Operational `/live` and `/ready` remain at server root.

## Route inventory

```text
GET  /live
GET  /ready

# Authentication, users, sessions, requests, recovery, and role assignments
# See auth-api.md for /api/v1/auth/*

# Current authorization and expression discovery
GET  /authorization/authority
GET  /authorization/roles
GET  /expressions/help
POST /expressions/validate

# Platform projects (not optd/projects:project domain objects)
GET  /projects
POST /projects
GET  /projects/{project_id}
POST /projects/{project_id}/update
POST /projects/{project_id}/archive

# Metadata and globally installed definitions
GET  /metadata/home
GET  /metadata/packs
GET  /metadata/packs/{publisher}/{pack}
GET  /metadata/packs/{publisher}/{pack}/resources/{resource}
GET  /metadata/packs/{publisher}/{pack}/relationships/{relationship}
GET  /metadata/packs/{publisher}/{pack}/lifecycles/{lifecycle}
GET  /metadata/packs/{publisher}/{pack}/actions/{action}
GET  /metadata/packs/{publisher}/{pack}/hooks/{hook}
GET  /metadata/packs/{publisher}/{pack}/roles/{role}
GET  /metadata/packs/{publisher}/{pack}/policies/{policy}
GET  /metadata/packs/{publisher}/{pack}/seeds/{seed}

# Multipart pack preview creates a durable migration plan/candidate revision
POST /packs/preview

GET  /migrations/{migration_id}
GET  /migrations/{migration_id}/violations
GET  /migrations/{migration_id}/sql
POST /migrations/{migration_id}/validate
POST /migrations/{migration_id}/apply

# Query/object reads; DTO/pagination are frozen in query-api.md
POST /queries
GET  /projects/{project_id}/objects/{publisher}/{pack}/{resource}/{object_id}
GET  /projects/{project_id}/objects/{publisher}/{pack}/{resource}/{object_id}/history
GET  /projects/{project_id}/relationships/{publisher}/{pack}/{relationship}/{relationship_id}
GET  /projects/{project_id}/relationships/{publisher}/{pack}/{relationship}/{relationship_id}/history

# Immutable staging; operations may span explicit projects
POST /changesets/stage
GET  /changesets/{stage_id}
POST /changesets/{stage_id}/commit
POST /changesets/{stage_id}/cancel
GET  /changesets/{stage_id}/approvals
POST /changesets/{stage_id}/approvals/{requirement_id}/decide

# Semantic actions stage only; CLI direct commit stages then commits returned ID
POST /actions/{publisher}/{pack}/{action}/stage

# Explicit seed expansion stages ordinary immutable operations
POST /packs/{publisher}/{pack}/seeds/stage

GET  /outbox
GET  /outbox/{delivery_id}
GET  /outbox/{delivery_id}/attempts
POST /outbox/{delivery_id}/retry
POST /outbox/{delivery_id}/cancel
POST /outbox/drain

GET  /secrets
POST /secrets
POST /secrets/{secret_id}/rotate
POST /secrets/{secret_id}/disable

GET  /hook-secret-grants
POST /hook-secret-grants
POST /hook-secret-grants/{grant_id}/replace
POST /hook-secret-grants/{grant_id}/revoke

GET  /policy-assignments
POST /policy-assignments
POST /policy-assignments/{assignment_id}/disable
```

## Addressing rules

- `{publisher}`, `{pack}`, and child-name segments are lowercase canonical
  names; the server resolves the one active revision and returns its immutable
  revision ID/digest in metadata.
- `{project_id}`, `{object_id}`, `{stage_id}`, migration/grant/delivery IDs, and
  generated operation/entity IDs are UUIDv7 values. CLI may resolve a project
  slug/name before invoking project-ID routes.
- `POST /queries` carries one explicit `project_id` and one structured
  definition identity `{kind: resource|relationship, publisher, pack, name}`.
  Cross-project list/query is not an MVP query mode.
- A multi-project stage carries `project_id` on each operation. Stage inspection
  exposes the canonical set of affected projects.
- Object reads include project in the path even though object UUIDv7 values are
  globally unique; a mismatch returns safe `not_found`/`project_conflict` per
  the authorization/error contracts.

## Write sequencing

### Packs

`POST /packs/preview` validates multipart source, normalizes definitions, stores
or reuses the content-addressed candidate revision, and creates/returns a
complete durable migration plan with a new UUIDv7. There is no caller
idempotency key; repeated preview may create multiple plan records against
refreshed live facts. It does not activate the pack.
`POST /migrations/{id}/apply` performs the locked transactional activation using
the exact plan/revision; confirmation material for destructive plans is supplied
in that apply body. There is no separate `/packs/apply` upload path or
migration-confirm mutation.

`optctl pack apply <dir>` is client orchestration: preview, render the exact
plan, then apply its returned migration ID when class/status and explicit CLI
flags allow it.

### Changesets and actions

`POST /changesets/stage` and semantic action staging return the exact complete
stage representation later returned by `GET /changesets/{stage_id}`. Commit body
is exactly `{ "lock_timeout": "10s" }`, with the field optional; an omitted body
is equivalent to `{}`. It never accepts replacement operations or reruns stage
hooks. Cancellation body has only optional bounded `reason`.

If a valid stage requires approvals, approval rows are created as part of stage
persistence. Each decision route accepts exactly one `decision` (`approve` or
`reject`) and the reason rules in
[Changeset Approval Contract](changeset-approvals.md). Decisions, cancellation,
and commit serialize on the lifecycle coordination row. Approval does not mutate
the immutable operation graph.

### Seeds

Seed staging accepts:

```json
{
  "project_id": "019b...",
  "seed_names": ["pipeline_stages"],
  "all": false
}
```

Exactly one selection is valid: non-empty unique `seed_names` with `all: false`,
or omitted `seed_names` with `all: true`.

It resolves seed definitions from the exact active pack revision and expands
them into the same frozen operation graph as ordinary staging. Changed
reconciliation returns a normal stage representation; an unchanged reconcile
returns `status: unchanged` and `stage: null`. Commit uses the normal changeset
route. Seed identity/idempotency semantics are frozen in `pack-structure.md`.

## Metadata behavior

Metadata definitions are global, but responses may include current capability/
AXI projections only for an explicit `project_id` query parameter. `optctl`
sends its resolved context project when present. Without it, metadata returns
global definition/schema guidance and labels project-bound capabilities as
requiring a boundary; the server never guesses a project. Safe schema/AXI
definition reads are available to every authenticated human/agent session
(request-only credentials remain limited to auth workflow routes). Default Hook
metadata contains identity/purpose/phases/output/effect summary only. Policy
default metadata exposes identity/AXI/capability summary, not full predicates.
Exact query `include_security=true` on pack/Hook/Policy metadata requires
`pack.inspect_security` and adds full policy rules plus Hook script/ source
digests, network/env/secret-slot/read mappings; secret/grant values/details and
migration SQL remain on their separately authorized routes. Project capability
projections evaluate current authority in that boundary.

## Required request behavior

- Bearer authentication is mandatory except for the explicitly public
  bootstrap/login/readiness endpoints in `auth-api.md`.
- Unknown JSON and multipart fields are rejected.
- Structured identity fields are used in JSON; concatenated dotted aliases are
  rejected.
- `POST /actions/.../stage` body contains `project_id`, action `input`, and
  optional documented stage-request controls only.
- Request lock-timeout override is accepted only on commit/apply routes and is
  bounded/configured as specified by their transactional contracts.
- Filter/sort/projection/cursor bodies use exactly
  [Query and Object Read API](query-api.md); CLI does not invent another query
  language/DTO.

## CLI mapping examples

```text
optctl --project sales view optd/crm:lead 019b...
  -> resolve project `sales` to UUID
  -> GET /api/v1/projects/{project_id}/objects/optd/crm/lead/{object_id}

optctl --project sales action stage optd/crm:convert_lead --input action.json
  -> POST /api/v1/actions/optd/crm/convert_lead/stage

optctl changeset commit 019c...
  -> POST /api/v1/changesets/{stage_id}/commit
```
