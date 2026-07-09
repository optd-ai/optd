# Design Proposals

This file captures current proposals for questions that emerged while designing
packs, hooks, resources, changesets, and `optctl`.

## 1. Pack Authoring Format

Promoted to main spec: see [Pack Structure](pack-structure.md).

## 2. Expression Language

Promoted to main spec: see [Expression Language](expression-language.md).

## 3. Hook Output Schema Proposal

Prototype evidence: `prototypes/hooks/` runs real Deno hook scripts and
validates `validation.v1`, `patch.v1`, and `changeset.operations.v1` stdout
shapes.

Hooks write exactly one JSON object to stdout. The hook definition declares its
output schema.

### Common Envelope

All hook outputs may include:

```json
{
  "summary": "short human/agent readable explanation",
  "warnings": [],
  "metadata": {}
}
```

### `validation.v1`

Used by validation hooks.

```json
{
  "allow": true,
  "errors": [
    { "path": "email", "code": "invalid_email", "message": "Email is invalid" }
  ],
  "warnings": [
    {
      "path": "company_name",
      "code": "missing_company",
      "message": "Company improves routing"
    }
  ]
}
```

Rules:

- `allow: false` blocks preview/commit.
- `errors` imply blocked even if `allow` is omitted; prefer requiring `allow`.
- `path` uses field/path notation relative to hook input or proposed object.

### `patch.v1`

Used by normalization hooks.

```json
{
  "allow": true,
  "patches": [
    { "op": "set", "path": "/email", "value": "a@example.com" },
    { "op": "unset", "path": "/temporary_field" }
  ],
  "warnings": []
}
```

Rules:

- Patches modify the proposed changeset, not the database directly.
- Patch paths are constrained to allowed objects/fields for that hook
  attachment.

### `changeset.operations.v1`

Used by action commit/preview hooks.

```json
{
  "operations": [
    {
      "op": "create",
      "resource": "company",
      "as": "company",
      "fields": { "name": "Acme" }
    },
    {
      "op": "create",
      "resource": "contact",
      "as": "contact",
      "fields": { "email": "a@acme.com" }
    },
    {
      "op": "link",
      "relationship": "contact_company",
      "from": "@contact",
      "to": "@company"
    },
    {
      "op": "transition",
      "resource": "lead",
      "id": "lead_123",
      "to": "converted"
    }
  ],
  "summary": "Convert lead into company, contact, and opportunity"
}
```

Rules:

- Operations are declarative and are fed back into the changeset engine.
- Hooks never directly mutate resource tables.
- `as` creates temporary operation-local references addressable as `@name`.

### `approval.v1`

```json
{
  "required_approvals": [
    { "role": "sales_manager", "reason": "Discount exceeds 20%" }
  ],
  "allow": true
}
```

### `side_effect.v1`

For after-commit hooks. Prefer returning side effect intents for the platform to
execute/retry where possible.

```json
{
  "effects": [
    {
      "type": "webhook",
      "url_secret": "crm_slack_webhook",
      "body": { "text": "New lead" }
    }
  ]
}
```

## 4. Changeset Operation Schema Proposal

Prototype evidence: `prototypes/changesets/` runs this operation model through a
Deno HTTP server backed by PGlite.

The changeset operation schema should be the one internal write language for
actions, hooks, CLI, API, and future MCP.

Initial operations:

### `create`

```json
{
  "op": "create",
  "resource": "lead",
  "as": "lead",
  "fields": { "name": "Jane", "email": "jane@example.com" }
}
```

### `update`

```json
{
  "op": "update",
  "resource": "lead",
  "id": "lead_123",
  "set": { "score": 42 },
  "unset": ["temporary_note"]
}
```

### `transition`

```json
{
  "op": "transition",
  "resource": "opportunity",
  "id": "opp_123",
  "to": "proposal"
}
```

### `link`

```json
{
  "op": "link",
  "relationship": "contact_company",
  "from": "contact_123",
  "to": "company_123",
  "fields": { "role": "buyer" }
}
```

### `unlink`

```json
{ "op": "unlink", "relationship": "contact_company", "id": "rel_123" }
```

### `comment`? Open Design Question

Question: should comments be a native operation/platform primitive, or just a
resource/pack feature?

#### Native comments

Native comments would be universal collaboration records attachable to any
resource object.

Pros:

- Consistent UX/API/CLI across all packs.
- Useful for audit-adjacent human/agent collaboration.
- `optctl view` can show recent comments for any object.
- Agents can leave rationale, observations, or handoff notes without each pack
  reinventing notes.
- Easier to implement notifications/mentions later.

Cons:

- Adds product opinion to the platform core.
- Some domains may want specialized note/comment models.
- Comments can blur with audit log, activity, notes, messages, and documents.
- Requires permissions, retention, search, and possible attachments/mentions
  semantics.

Use cases:

- Agent explains why it changed an opportunity stage.
- Human asks follow-up on a lead.
- Sales note on a contact.
- Incident/work item discussion.
- Review/approval discussion around a changeset.

#### Pack-defined comments/notes

Packs define resources like `note`, `activity`, or `message`.

Pros:

- Core stays smaller.
- Packs can customize semantics.
- CRM can distinguish notes, calls, emails, and activities.

Cons:

- Every pack reinvents common collaboration.
- `optctl` cannot provide universal comment behavior.
- Agents must learn pack-specific note/comment models.

#### Proposal

Have a native lightweight `comment` primitive for universal object discussion,
plus allow packs to define richer domain resources like `note`, `activity`,
`email_message`, or `call_log`.

Changeset operation:

```json
{
  "op": "comment",
  "resource": "opportunity",
  "id": "opp_123",
  "body": "Followed up by email."
}
```

Native comments should be:

- append-only or edit-limited
- audited
- permission-checked
- searchable subject to permissions
- optionally linkable to changesets/approvals

Keep v1 comments simple: body, actor, timestamps, target resource/id, optional
changeset id.

### `attach`

```json
{
  "op": "attach",
  "resource": "company",
  "id": "company_123",
  "artifact": "artifact_456"
}
```

### `delete` / `archive`

Prefer soft delete/archive semantics initially:

```json
{ "op": "archive", "resource": "lead", "id": "lead_123" }
```

Hard deletes should be special/destructive and not in early happy-path flows.

### Operation References

Operations may reference earlier operations in the same changeset using `as`
bindings:

```json
{ "op": "create", "resource": "company", "as": "company", "fields": { "name": "Acme" } }
{ "op": "create", "resource": "opportunity", "fields": { "company_id": "@company" } }
```

## 5. Resource Migrations

Promoted to main spec: see [Migrations](migrations.md).

Supporting research and executable evidence remain in:

- [Migration Classification](migration-classification.md)
- [CRM Migration Prototype](crm-migration-prototype.md)
- `prototypes/migration/`

## 6. Pack Structure and Upload Proposal

Canonical details are in [Pack Structure](pack-structure.md).

Decision: use a strict convention-based pack directory layout and HTTP multipart
as the canonical transport for all pack apply flows.

### Strict pack layout

The root `pack.yaml` should contain pack metadata and pack-level AXI guidance
only. It should not enumerate relative paths.

Expected layout:

```text
packs/crm/
  pack.yaml
  resources/
    lead.yaml
    contact.yaml
  relationships/
    contact_company.yaml
  lifecycles/
    opportunity_pipeline.yaml
  actions/
    convert_lead.yaml
  hooks/
    validate_lead.yaml
    validate_lead.ts
  seeds/
    pipeline_stages.yaml
```

Rules:

- CLI/server scans expected directories.
- Unknown top-level directories fail preview except explicitly ignored names
  like `.git`.
- Every child YAML file must include `metadata.name`, and the file basename must
  match it. Names are never inferred from file paths.
- Object type/resource kind names are lowercase snake case.
- Child files inherit the pack namespace when `metadata.namespace` is omitted.
- Hook config references script file names only, e.g.
  `script: validate_lead.ts`; `hooks/` is implied.
- Resource/action/lifecycle config references hooks by name, not path.

### Upload transport

Use HTTP multipart as the canonical transport for all pack apply flows.

### Endpoint Sketch

```text
POST /packs/preview
POST /packs/apply
Content-Type: multipart/form-data
```

Parts:

- `manifest`: required YAML/JSON pack manifest.
- `files[]`: repeated file parts with relative path metadata.
- `mode`: preview/apply flags, or use separate endpoints.

Example part names:

```text
manifest = pack.yaml
file: resources/lead.yaml
file: actions/convert_lead.yaml
file: hooks/convert_lead.yaml
file: hooks/convert_lead.ts
file: seeds/pipeline_stages.yaml
```

Validation:

- Every file is in an expected directory for its kind.
- Every hook has a Hook YAML file, and every hook `script` file name exists in
  `hooks/` as a `.ts` file.
- Hook script paths are file names only, not relative paths.
- No unexpected absolute paths or `..` traversal.
- File basename matches explicit `metadata.name`; missing names are rejected.
- Script contents are Deno-compatible enough for preview validation/typecheck
  policy.
- File digests are computed server-side.
- Normalized config graph is built server-side.

Storage:

- Store normalized config objects in DB.
- Store source files/script text as DB records keyed by digest and config
  revision.
- Cache materialized script files in temp/digest cache for execution.

CLI behavior:

- `optctl pack preview ./packs/crm` packages local files into multipart and
  calls API.
- `optctl pack apply ./packs/crm` does the same and commits if server preview
  passes.

## 7. Deno Imports Policy

Decision: **No imports initially.**

Rules:

- Hook scripts must be self-contained TypeScript/JavaScript.
- No remote URL imports.
- No npm imports.
- No local relative imports initially, unless/until pack module bundling is
  designed.
- Built-in Web/Deno APIs are allowed according to hook permissions.

Rationale:

- Simplifies reproducibility and audit.
- Avoids dependency supply-chain issues.
- Keeps prototype packs easy to reason about.
- Defer until many prototype packs have proven what dependencies are actually
  needed.

## 8. optctl Output Format

Decision: use **TOON** for `optctl` stdout.

Rules:

- Internal logic can use JSON objects.
- Output boundary encodes to TOON.
- stderr is for logs/progress only.
- Errors are structured TOON on stdout with non-zero exit codes.
- Use compact schemas by default.
- Include `help[]` contextual next steps where useful.

## 9. System Tables

Initial table names are selected for the vertical slice. These names should be
used consistently across prototypes/specs unless a later implementation pass
deliberately renames them.

### User Resource Tables

One generated table per resource kind:

- `res_lead`
- `res_contact`
- `res_company`
- `res_opportunity`

Common generated columns:

- `id`
- `version`
- `current_object_version_id`
- `created_at`
- `updated_at`
- `created_by`
- `updated_by`
- `archived_at`
- `archived_by`

Resource-specific fields become ordinary columns where possible.
Extension/dynamic fields can use JSONB later, but the vertical slice should
prefer generated columns for clarity and database constraints.

### Platform Tables

#### Pack/config registry

- `pack_revisions`
  - immutable applied pack revisions; namespace, name, version, status/active,
    created_by, created_at, normalized config digest.
- `pack_files`
  - files included in a pack revision; path, media type, digest, content, bytes,
    kind.
- `resource_definitions`
  - normalized resource definitions by revision; namespace, name, generated
    table name, spec.
- `field_definitions`
  - normalized field definitions by revision; resource, name, type, required,
    object reference target.
- `relationship_definitions`
  - relationship definitions and generated relationship table metadata.
- `lifecycle_definitions`
  - lifecycle definitions, states, transitions, guards, AXI guidance.
- `action_definitions`
  - action definitions by revision/name; input schema, hook refs, availability,
    AXI guidance.
- `hook_definitions`
  - hook definitions by revision/name; script path basename, script digest,
    permissions, timeout, input/output schema, AXI guidance.
- `seed_definitions`
  - seed/reference-data definitions by revision/name.

#### Changeset/write path

- `changesets`
  - id, status, actor, created_at, preview summary, request, validation result,
    idempotency key, committed_at.
- `changeset_operations`
  - normalized operation list, operation order, resource refs, result refs.
- `object_versions`
  - immutable committed object states, including current state; globally unique
    version id, resource/object id, per-object integer version, previous version
    pointer, snapshot JSON, changed fields, changeset id, actor, timestamp.
- `approvals`
  - approval requirements, decisions, actor, timestamp.
- `idempotency_keys`
  - scoped idempotency records for commit-capable operations.

#### Audit/events/async

- `audit_events`
  - immutable accountability/explanation trail for intentions, decisions,
    policy/validation summaries, and optional object version references. Does
    not duplicate full snapshots.
- `events`
  - committed domain/platform facts with optional object version references and
    minimal routing payloads. Does not duplicate full snapshots.
- `outbox`
  - async after-commit hook queue derived from committed events, claimable with
    Postgres locks. Side effects are powered by hooks.
- `hook_executions`
  - hook id, script digest, permissions, stdin digest, stdout summary,
    stderr/log refs, duration, exit code.

#### Collaboration/artifacts

- `object_comments`
  - native universal comments; target resource, target id, body, actor,
    timestamps, optional changeset id.
- `artifacts`
  - uploaded/generated blobs and metadata.
- `attachments`
  - links artifacts to resource objects or comments.

#### Migration/operational tracking

- `schema_migrations`
  - platform schema migration tracking.
- `migration_plans`
  - generated pack/resource migration plans and execution records.
- `migration_steps`
  - individual migration steps, classifications, SQL/operation text, status.
- `resource_health_checks`
  - optional validation results after migrations.

## 10. Metadata API and Commands Proposal

The agent needs first-class metadata discovery. Metadata is how `optctl` teaches
available packs/resources/actions/hooks/lifecycles and how to use them.

### HTTP API Sketch

Route shape needs more investigation. The earlier sketch
`GET /metadata/resources/{namespace}.{name}` is ambiguous-looking even though
the intent was “get the resource type identified by namespace + name,” e.g.
`crm.lead`.

It does **not** mean “show all resource types in namespace `{namespace}` named
`{name}`”; it means exactly one resource type whose namespace is `crm` and name
is `lead`.

Clearer options to investigate:

#### Option A: dotted id path segment

```text
GET /metadata/resources/crm.lead
GET /metadata/actions/crm.convert_lead
```

Pros: matches CLI shorthand. Cons: parsing/escaping ambiguity if names ever
contain dots; less REST-explicit.

#### Option B: namespace and name as separate path segments

```text
GET /metadata/namespaces/crm/resources/lead
GET /metadata/namespaces/crm/actions/convert_lead
```

Pros: unambiguous and REST-like. Cons: more verbose.

#### Option C: query parameters

```text
GET /metadata/resources?namespace=crm&name=lead
GET /metadata/actions?namespace=crm&name=convert_lead
```

Pros: simple filtering model. Cons: less clean for canonical self links.

Current preference: CLI uses dotted shorthand (`crm.lead`), while HTTP API
likely uses separate namespace/name path segments for clarity.

Provisional API:

```text
GET /metadata
GET /metadata/namespaces
GET /metadata/namespaces/{namespace}
GET /metadata/namespaces/{namespace}/packs
GET /metadata/namespaces/{namespace}/packs/{pack}
GET /metadata/namespaces/{namespace}/resources
GET /metadata/namespaces/{namespace}/resources/{name}
GET /metadata/namespaces/{namespace}/resources/{name}/actions
GET /metadata/namespaces/{namespace}/actions
GET /metadata/namespaces/{namespace}/actions/{name}
GET /metadata/namespaces/{namespace}/hooks
GET /metadata/namespaces/{namespace}/lifecycles/{name}
GET /metadata/search?q=...
```

### CLI Sketch

```text
optctl metadata
optctl metadata packs
optctl metadata pack crm
optctl metadata resources
optctl metadata resource crm.lead
optctl metadata actions crm.lead
optctl metadata action crm.convert_lead
optctl metadata search lead
```

### Metadata Resource Output Should Include

For a resource:

- kind/name/namespace
- purpose and `axi.whenToUse`
- fields and required fields
- constraints
- relationships
- lifecycle states/transitions
- available actions
- list/detail/search AXI guidance
- example commands

For an action:

- purpose
- input schema
- availability rules
- preview/commit behavior type
- required permissions/approvals
- hook references but not raw source by default
- example commands

For a pack:

- purpose
- resources
- actions
- active revision
- installed files/digests summary
- home/help guidance

### optctl Discovery Behavior

- `optctl` with no args shows a content-first home dashboard generated from
  active pack metadata and AXI guidance.
- `optctl metadata resource crm.lead` is the canonical fallback when an agent is
  unsure how to use a resource.
- `optctl view crm.lead <id>` should show available actions for that object
  state.
- `optctl list crm.lead` should show resource-specific `help[]` from `axi.list`.
