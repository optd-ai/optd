<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-pack-structure; contract: 1; input: sha256:8da2025694ed19c2759ed01527f299772eb5c88dc7cf231fac131a6ce7e282a6 -->

# Pack Structure

Generated exact-contract projection imported into project-model/model.json from the reviewed pack-structure.md source.

## Exact migrated contract

<a id="obj-com-exact-pack-structure-v1"></a>

### Exact v1 contract — Pack Structure

**Migration provenance.** Exact normative contract imported from `spec/pack-structure.md` at `sha256:b785675a461bf23b8d7df58836f85457d20a46ecc2a9b5bc7cdea1dc3006be38`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Decisions

Use YAML as the pack source format and canonical JSON internally.

Use a strict convention-based pack directory layout. The root `pack.yaml`
describes pack metadata and optional pack-level guidance; it must not enumerate
relative file paths.

The CLI/server scans known directories, validates known file naming rules, and
rejects unexpected or misplaced files. This reduces agent mistakes and makes
packs easier to author.

## Goals

- Human/agent-authored pack files use YAML by convention.
- The server normalizes YAML to canonical JSON for validation, storage, diffing,
  and API responses.
- YAML semantics are not part of runtime behavior.
- No relative path lists in `pack.yaml`.
- Hooks reference only hook names or file basenames, not paths.
- Resources/actions/hooks/seeds live in predictable directories.
- `optctl` can package a local pack into HTTP multipart automatically.
- Server can validate that all referenced hooks/scripts exist based on
  conventions.
- Directory structure is strict enough that agents can generate packs reliably.

## Directory Layout

```text
packs/crm/
  pack.yaml

  resources/
    company.yaml
    contact.yaml
    lead.yaml
    opportunity.yaml
    activity.yaml
    lost_reason.yaml
    pipeline_stage.yaml

  relationships/
    contact_company.yaml

  lifecycles/
    opportunity_pipeline.yaml

  actions/
    convert_lead.yaml
    close_won.yaml
    close_lost.yaml

  hooks/
    validate_lead.yaml
    validate_lead.ts
    normalize_lead.yaml
    normalize_lead.ts
    convert_lead.yaml
    convert_lead.ts
    require_primary_contact.yaml
    require_primary_contact.ts
    notify_lead_change.yaml
    notify_lead_change.ts

  roles/
    sales_rep.yaml
    sales_manager.yaml

  policies/
    sales_access.yaml

  seeds/
    pipeline_stages.yaml
    lost_reasons.yaml
```

## Authoring Format

Pack config source files use `.yaml` and are authored as YAML. JSON-compatible
YAML is valid, but JSON is not the preferred authoring style for real packs.

Normalization rules:

- Parse YAML source with the `yaml` package, using merge-key support so common
  YAML authoring patterns normalize deterministically.
- Normalize the parsed value into a JSON-compatible object model.
- YAML anchors, aliases, and merge keys are allowed only as authoring sugar; the
  stored canonical representation must not preserve references or YAML-specific
  identity.
- Reject custom tags, non-JSON scalar values, executable YAML features, and
  multi-document files.
- Avoid implicit scalar surprises by constraining accepted scalar forms where
  needed.
- Validate normalized objects with TypeBox/Ajv JSON Schema validation.
- Store immutable applied pack revisions as canonical JSON plus source file
  records where useful for audit/review.
- API responses and migration diffs operate on canonical JSON, not raw YAML
  text.

## Root `pack.yaml`

The root file should only contain pack-level metadata and optional pack-level
AXI guidance. Pack-level AXI belongs in `pack.yaml`; do not introduce a separate
`axi.yaml` for pack-level docs.

```yaml
kind: Pack
apiVersion: operant.dev/v1
metadata:
  publisher: operant
  name: crm
  version: 0.1.0
spec:
  purpose: Headless CRM resources for leads, contacts, companies, opportunities, and activities.
  axi:
    home:
      resources:
        - operant/crm:lead
        - operant/crm:opportunity
        - operant/crm:contact
        - operant/crm:company
      help:
        - optctl --project ${project} list operant/crm:lead
        - optctl --project ${project} list operant/crm:opportunity
        - optctl --project ${project} search operant/crm:contact <email-or-name>
```

No `includes:` block. No file paths.

## Scanning Rules

When previewing a pack directory, `optctl` scans:

| Directory              | File type | Kind expected                                         |
| ---------------------- | --------- | ----------------------------------------------------- |
| `resources/*.yaml`     | YAML      | `kind: Resource`                                      |
| `relationships/*.yaml` | YAML      | `kind: Relationship`                                  |
| `lifecycles/*.yaml`    | YAML      | `kind: Lifecycle`                                     |
| `actions/*.yaml`       | YAML      | `kind: Action`                                        |
| `hooks/*.yaml`         | YAML      | `kind: Hook` metadata, required for every hook script |
| `hooks/*.ts`           | Deno/TS   | hook script paired with `hooks/<name>.yaml`           |
| `roles/*.yaml`         | YAML      | `kind: Role`                                          |
| `policies/*.yaml`      | YAML      | `kind: Policy`                                        |
| `seeds/*.yaml`         | YAML      | `kind: Seed`                                          |

Unknown top-level directories should fail preview unless explicitly ignored by
convention, e.g. `.git`, `.DS_Store`. Packs do not have a general-purpose
`docs/` directory; documentation for agents belongs in first-class `axi` fields
on the relevant Pack, Resource, Relationship, Lifecycle, Action, Hook, Role,
Policy, or Seed config.

## File Naming Rules

All pack object identifiers use lowercase snake case.

Rules:

- Resource file name must match `metadata.name`.
  - `resources/lead.yaml` -> `metadata.name: lead`
- Action file name must match `metadata.name`.
  - `actions/convert_lead.yaml` -> `metadata.name: convert_lead`
- Hook script basename should match hook `metadata.name`.
  - `hooks/validate_lead.ts` -> hook name `validate_lead`
- Relationship, lifecycle, role, policy, and seed files follow the same rule.

Pack child definitions are global definition templates and omit runtime project
identity. Applying a pack installs exactly one active server-wide revision; it
does not materialize definitions or seed objects into a selected project.
Runtime objects and explicit seed application carry project IDs separately. The
pack `publisher` is global definition identity/provenance, not a runtime
project. See [Pack Publishers and Projects](pack-publishers-and-projects.md).

Every child YAML file must include `metadata.name`. The file basename must match
`metadata.name`. The platform must not infer names from file paths because packs
should have one obvious way to express object identity.

## Hook authoring and attachment

Every hook uses required paired metadata/script files:

```text
hooks/validate_lead.yaml
hooks/validate_lead.ts
```

```yaml
kind: Hook
apiVersion: operant.dev/v1
metadata:
  name: validate_lead
spec:
  script: validate_lead.ts
  timeout: 2s
  permissions:
    net: false
    env: false
    read: false
    write: false
    run: false
  secrets: []
  effects: { operations: [] }
  output: { schema: validation.v1 }
  attachments:
    - phase: changeset.validate
      resource: lead
      order: 100
      input:
        operation: "$operation"
        current: "$current"
        proposed: "$proposed"
  axi:
    purpose: Validate lead changes during staging before commit.
    whenToUse:
      - Runs automatically; agents normally invoke actions/resources.
```

Only the script filename is specified; paths and script-only hooks are rejected.
The hook owns attachment records. Action/resource/lifecycle files do not contain
a second hook list and never reference `hooks/validate_lead.ts`. Pack-local
attachment targets such as `lead` are qualified against the owning candidate
revision; cross-pack targets must use publisher-qualified identity and become
explicit migration/commit dependencies.

AXI guidance is first-class wherever relevant. Pack-level AXI belongs in
`pack.yaml`; component guidance belongs on its component document. The exact
Hook/attachment/input/permission/output contract is `mvp-hook-schema.md`.

## Prototype Evidence

`prototypes/pack-sql/` validates pack upload and schema compilation against
PGlite as a focused prototype. MVP integration must use real Postgres through
external or app-managed Postgres:

- Uploads a strict pack directory as HTTP multipart.
- Normalizes JSON-compatible YAML into canonical JSON.
- Validates expected paths and hook script references.
- Stores pack revisions, source files, resource/field/action/hook metadata, and
  hook script digests in platform tables.
- Compiles resources into actual SQL tables with platform columns, field SQL
  types, and `required: true` as `not null`.
- Confirms preview does not mutate the database while apply does.

Run:

```bash
deno test --allow-read --allow-write --allow-env --allow-net prototypes/pack-sql/pack-sql-server.test.ts
```

## Seed definitions and application

A seed definition has one pack-local resource, one required `key` field, mode
`changeset`, and an ordered non-empty `rows` array. The key must be a required
scalar field covered by a project-scoped unique constraint on that resource;
every row must contain a distinct key and pass the ordinary resource schema.
References use normal structured/local pack references and must resolve during
pack preview.

Seed staging is an explicit per-project reconcile operation against the exact
active pack revision:

1. Resolve selected seed names (or all pack seeds only when the request/CLI
   explicitly sets `all: true`) and sort them by name, then rows by canonical
   key. Empty/unknown/ambiguous selection is rejected.
2. For each row, read the current object with the same project/resource/key.
3. If absent, emit `create` with a server-issued UUIDv7.
4. If present and declared seed fields differ, emit `update` against that
   existing object's UUID and expected version, setting exactly the declared
   seed fields; unspecified object fields are preserved.
5. If equal, emit no operation. Seed application never archives rows removed
   from a later seed revision.

Seed authors never specify platform object IDs. The first creation generates the
UUIDv7; every later reconcile locates and preserves that identity through the
stable project-scoped business key. Concurrent missing-key creation is resolved
by the database unique constraint and normal commit conflict behavior.

Reads and uniqueness facts become frozen stage dependencies. Preview records the
seed effect manifest (`create|update` on its one resource). The invoking caller
must have exact `seed:<publisher>/<pack>:<seed>` permission in the request
project; the invocation-bound internal seed runner receives only that manifest.
Ordinary schema/hooks still apply, and seed definitions are not a privileged
bypass. Concurrent creation/update is caught by normal commit revalidation and
constraints.

CLI `optctl --project <slug> seed stage <publisher>/<pack> --all` returns a
stage, while `seed commit` is the client-side stage-then-commit convenience;
repeatable `--seed <name>` replaces `--all` for explicit subsets.

If reconciliation emits no operations, the seed-stage route returns
`status: unchanged`, selected project/revision/seed names, and `stage: null`
without persisting a stage. Otherwise it returns the complete ordinary immutable
stage representation. Repeating a committed unchanged seed request therefore
creates neither duplicate rows nor object versions. There is no seed-specific
commit endpoint.

## Multipart Upload Mapping

Even when using CLI, pack preview uses HTTP multipart.

`optctl pack preview ./packs/crm` must:

1. Scan the strict directory tree; reject symlinks/hardlinks/special files/path
   traversal. Archive input is not supported in MVP.
2. Validate file locations and names.
3. Build a manifest of discovered files.
4. Submit multipart upload to server.

`POST /api/v1/packs/preview` uses `multipart/form-data`. Every part has form
name `file`, a UTF-8 `filename` equal to one normalized relative pack path, and
bytes as the body (`text/yaml` or `application/typescript`; MIME is advisory).
There are no parallel manifest/identity fields: `pack.yaml` is authoritative.
Duplicate filenames, empty parts, backslashes, absolute/`.`/`..` segments,
symlinks, and unknown form names fail. Configurable total/file/count guardrails
are checked before parsing.

Multipart filenames preserve paths:

```text
pack.yaml
resources/lead.yaml
hooks/validate_lead.yaml
hooks/validate_lead.ts
actions/convert_lead.yaml
seeds/pipeline_stages.yaml
```

Server repeats validation and rejects:

- missing expected paired hook script
- script referenced by hook YAML but not uploaded
- file in wrong directory for its kind
- metadata name mismatch with file basename
- unknown top-level directory
- path traversal or absolute paths

## Benefits

- Agents do not have to maintain path lists.
- File organization teaches the pack model.
- Pack diffs are clean.
- Upload validation is deterministic.
- Hook references are stable names, not paths.
- CLI can produce better errors: “hook `validate_lead` must live at
  `hooks/validate_lead.ts`.”

## Deferred beyond MVP

Config templating and generated pack fragments are not supported. Agents author
the normalized strict pack files directly; revisit only with concrete repetition
evidence.
