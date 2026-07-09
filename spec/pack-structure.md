# Pack Structure

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
  namespace: crm
  name: crm
  version: 0.1.0
spec:
  purpose: Headless CRM resources for leads, contacts, companies, opportunities, and activities.
  axi:
    home:
      resources:
        - crm.lead
        - crm.opportunity
        - crm.contact
        - crm.company
      help:
        - optctl list crm.lead
        - optctl list crm.opportunity
        - optctl search crm.contact <email-or-name>
```

No `includes:` block. No file paths.

## Scanning Rules

When applying a pack directory, `optctl` scans:

| Directory              | File type | Kind expected                                         |
| ---------------------- | --------- | ----------------------------------------------------- |
| `resources/*.yaml`     | YAML      | `kind: Resource`                                      |
| `relationships/*.yaml` | YAML      | `kind: Relationship`                                  |
| `lifecycles/*.yaml`    | YAML      | `kind: Lifecycle`                                     |
| `actions/*.yaml`       | YAML      | `kind: Action`                                        |
| `hooks/*.yaml`         | YAML      | `kind: Hook` metadata, required for every hook script |
| `hooks/*.ts`           | Deno/TS   | hook script paired with `hooks/<name>.yaml`           |
| `policies/*.yaml`      | YAML      | `kind: Policy`                                        |
| `seeds/*.yaml`         | YAML      | `kind: Seed`                                          |

Unknown top-level directories should fail preview unless explicitly ignored by
convention, e.g. `.git`, `.DS_Store`. Packs do not have a general-purpose
`docs/` directory; documentation for agents belongs in first-class `axi` fields
on the relevant Pack, Resource, Action, Hook, Lifecycle, or Seed config.

## File Naming Rules

All pack object identifiers use lowercase snake case.

Rules:

- Resource file name must match `metadata.name`.
  - `resources/lead.yaml` -> `metadata.name: lead`
- Action file name must match `metadata.name`.
  - `actions/convert_lead.yaml` -> `metadata.name: convert_lead`
- Hook script basename should match hook `metadata.name`.
  - `hooks/validate_lead.ts` -> hook name `validate_lead`
- Relationship/lifecycle/seed files follow the same rule.

If `metadata.namespace` is omitted inside child files, it defaults to the pack
namespace.

Every child YAML file must include `metadata.name`. The file basename must match
`metadata.name`. The platform must not infer names from file paths because packs
should have one obvious way to express object identity.

## Hook Authoring

### Option A: Explicit Hook YAML + Script File

For hooks with permissions/input/output schemas, use paired files:

```text
hooks/validate_lead.yaml
hooks/validate_lead.ts
```

`hooks/validate_lead.yaml`:

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
    read: false
    write: false
    env: false
    run: false
  input:
    schema:
      proposed:
        type: object
        resource: lead
        required: true
  output:
    schema: validation.v1
  axi:
    purpose: Validate lead changes before preview/commit.
    whenToUse: Runs automatically; agents normally do not invoke this directly.
```

AXI guidance is first-class wherever it is relevant. Pack-level AXI belongs in
`pack.yaml`; hook-specific AXI belongs in the Hook YAML;
action/resource/lifecycle/seed guidance belongs on those respective documents.

Only the file name is specified, not a relative path. The CLI/server knows hook
scripts live in `hooks/`.

### Script-Only Hooks

Script-only hooks are not supported. Every hook script must have a corresponding
Hook YAML file. This keeps hook permissions, input schema, output schema,
timeout, and AXI guidance explicit.

## Referencing Hooks

Resources/actions/transitions reference hooks by dotted name or local name.

Within the same namespace:

```yaml
hooks:
  validate:
    - ref: validate_lead
```

Cross-namespace:

```yaml
hooks:
  validate:
    - ref: crm.validate_lead
```

The hook definition points to the script file name:

```yaml
spec:
  script: validate_lead.ts
```

No resource/action/lifecycle config should reference `hooks/validate_lead.ts`
directly.

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

## Multipart Upload Mapping

Even when using CLI, pack apply uses HTTP multipart.

`optctl pack preview ./packs/crm` should:

1. Scan the strict directory tree.
2. Validate file locations and names.
3. Build a manifest of discovered files.
4. Submit multipart upload to server.

Multipart parts can preserve paths:

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

## Open Questions

- Should config support templating or generated pack fragments later?
