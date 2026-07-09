# Project Understanding

_Last updated: 2026-07-05 via `/dag brainstorm`._

## Latest Brainstorm Decisions

- **Known:** The `spec/` directory should become the organized, durable version
  of the evolving product understanding. As brainstorming continues, specs
  should be updated alongside `.ai/project.md` rather than leaving decisions in
  chat.
- **Known:** Odoo-style product packs are research scaffolding only. They help
  identify object names and domain breadth, but they are not a commitment to
  clone Odoo, implement Odoo workflows, or copy Odoo fields.
- **Known:** Deployment simplicity is a major constraint. The system should be
  horizontally scalable with no application-node coordination requirement beyond
  Postgres. Avoid designs that require a separate coordination service for
  correctness.
- **Known:** Authorization/policy design uses an internal SQL-lowerable model
  combining RBAC, ABAC, and one-level ReBAC, with OIDC/JWT compatibility for
  external identity providers and a preference for approaches backed by Postgres
  rather than requiring complex distributed infrastructure.
- **Assumed:** “Pause this for now” means avoid over-investing in one tangent
  while still capturing the current decision state in specs.

## 2026-07-05 Pivot: Open-Source Single-Tenant Resource Platform

- **Known:** The default product shape is now open-source and single-tenant
  rather than SaaS multi-tenant. Multi-tenancy may be layered later, but should
  not dominate the core model.
- **Known:** The platform should feel Kubernetes-like: defaults that work,
  declarative resources, user-defined resources, lifecycle hooks, and behavior
  layered on top of resource definitions.
- **Known:** SQLite should be viable for simple/local/single-container
  deployments, while Postgres should be available for concurrency and horizontal
  scaling.
- **Decision:** Use bundled/app-managed local Postgres as the default simple
  deployment model. This gives real Postgres semantics while still allowing
  one-container/one-volume ergonomics and boot-time database startup managed by
  the app.
- **Known:** PGlite is a WASM Postgres option that can run in-process in JS
  runtimes. It is attractive for dev/demo/personal modes, but its
  single-user/single-connection nature means it should not be treated as
  equivalent to server Postgres for concurrency or production semantics without
  validation.
- **Known:** A good CRM prototype flow is: apply a default CRM resource pack,
  create `lead`, validate with schema/database constraints plus scripts,
  normalize/enrich through hooks, convert lead to contact/company/opportunity,
  transition opportunity through lifecycle, and safely deprecate/remove
  resources through previewed config changes.
- **Inferred:** The CRM pack needs configuration primitives for `Pack`,
  `Resource`, `Relationship`, `Lifecycle`, `Action`, `Hook`, inline
  field/resource constraints, `Index`, and `Seed` data. Constraints should
  usually be inline on fields/resources; a separate top-level `Constraint` kind
  is probably unnecessary until constraints need to be shared, independently
  versioned, or cross-resource. For the prototype, table-per-resource storage is
  a better fit than a universal JSONB object table because the user wants to
  expose foreign keys and database-level constraints as configuration.
- **Inferred:** Action/hook behavior should not directly mutate tables. Actions
  define named intentions and can be declarative or hook-backed; hooks return
  validation results, patches, changeset operations, approval requirements, or
  after-commit side effects. The changeset engine remains the only writer.
- **Decision:** Hook parameter transport is one JSON envelope on stdin and one
  JSON result on stdout; logs go to stderr. Do not use CLI args or environment
  variables for structured hook inputs. Env vars are reserved for true
  environment configuration and secrets. Magic files are only referenced from
  the JSON envelope for large artifacts.
- **Decision:** Deno/TypeScript is the only hook runtime for generated/default
  pack hooks because it has no compile step, strong JSON support, built-in
  `fetch`, subprocess APIs, explicit permissions, and agents are generally
  strong at TypeScript.
- **Decision:** Do not require shebangs or runtime metadata for hooks. The
  platform always runs hook scripts with Deno through the hook runner.
- **Decision:** Hook permissions are explicit at the hook level and constrained
  by global policy. The platform hook runner should translate hook permissions
  into Deno flags and reject hooks requesting permissions disabled globally.
- **Decision:** Packs are uploaded/applied through HTTP multipart, even when
  initiated by the CLI from a local directory/archive. Multiline script strings
  in JSON are not the primary upload format. Applied pack config and script
  contents are stored in the database as immutable config revisions; runtime
  filesystem materialization is only a disposable digest cache.
- **Spec:** Pack authoring and layout have graduated into
  `spec/pack-structure.md`: packs use YAML source, normalize to canonical JSON
  internally, avoid advanced YAML features, and use a strict convention-based
  directory layout (`resources/`, `actions/`, `hooks/`, `seeds/`, etc.) so
  `pack.yaml` does not enumerate relative paths. The CLI/server scans expected
  directories. Every child YAML file must include `metadata.name`; names are
  never inferred from filenames. Hook YAML is required for every hook script.
  Packs do not have `docs/`; agent-facing documentation belongs in first-class
  `axi` fields on pack/resource/action/hook/lifecycle/seed documents. Hooks
  reference script file names only; `hooks/` is implied.
- **Research:** AXI CLIs show compact structured output, content-first home
  views, small default schemas, explicit empty states, total/completeness
  markers, structured errors, and contextual `help[]` next-step commands.
  `optctl` should use pack/resource/action `axi` guidance to teach agents how to
  use configured resources at the right time.
- **Decision:** Object type/resource kind names are always lowercase, using
  snake case for multi-word kinds. Display labels can be capitalized, but
  config/API/CLI identifiers must be lowercase to reduce agent capitalization
  mistakes.
- **Decision:** The expression language is now a main spec in
  `spec/expression-language.md`: use a small, hardcoded CEL subset for resource
  constraints, conditional indexes, lifecycle guards, action availability, hook
  attachment conditions, AXI/help conditions, and later policy predicates.
  Expression rules are built into the platform/`optctl`, not configurable by
  packs.
- **Proposal:** Partial indexes are useful for optional unique fields,
  active/non-archived uniqueness, open/activity query speedups, and one-primary
  relationship constraints. For partial indexes, compile a small safe CEL subset
  to Postgres SQL; if the expression cannot compile safely, reject config
  preview rather than falling back to runtime enforcement.
- **Decision direction:** Archive/soft-delete should be a built-in default
  platform capability with generated `archived_at`/`archived_by` fields and
  helpers like `active()`/`archived()` for expressions.
- **Decision:** Hook outputs and changeset operations get explicit versioned
  schemas, starting with `validation.v1`, `patch.v1`, `changeset.operations.v1`,
  `approval.v1`, and `side_effect.v1`.
- **Proposal:** Keep native lightweight comments as a universal platform
  primitive, while allowing packs to define richer domain resources like `note`,
  `activity`, `email_message`, and `call_log`.
- **Decision:** Resource config apply should be Kubernetes-like: desired config
  plus server-side migration preview/reconcile. Safe additive changes can apply
  automatically; risky/destructive changes require explicit
  confirmation/staging. Destructive changes require diff classification, impact
  analysis, staged deprecation by default, optional backfill/export/archive, a
  confirmation token tied to the exact migration plan digest, execution audit,
  and post-migration verification.
- **Research:** Migration destructiveness should be grounded in existing
  patterns: Postgres DDL/locking behavior, `pg-schema-diff` hazard warnings and
  temp DB validation, `pgroll` expand/contract reversible migrations, `sqldef`
  desired-state diffs, Atlas dev DB/linting, and Liquibase preconditions.
  Classify changes across data-loss risk, backward compatibility, constraint
  validity, operational hazards, and reversibility.
- **Spec:** Migration lifecycle has graduated into `spec/migrations.md`.
  Migration detection can stay simple: semantic config diff → map to migration
  primitives → classify safe/risky/destructive with conservative hardcoded rules
  → query live facts only when needed (row counts, violations, dependencies) →
  stage/deprecate destructive changes by default. Large breaking migrations
  should proceed through preview, inspect violations, staged plan, data cleanup
  via ordinary changesets, revalidation, digest-bound confirmation token,
  destructive cleanup, and audit. Type-change backfills support only simple
  generated staged casts initially (`integer -> string`, `integer -> decimal`,
  `decimal -> string`); unsupported casts are blocking, and agents work around
  them by adding a new field, populating it via changesets/action hooks,
  switching readers/writers, and later removing the old field. Executable Deno
  prototypes now live in `prototypes/migration/`: safe/breaking CRM scenarios,
  an end-to-end strict-pack-directory diff mode (`crm-v1` -> `crm-v2`), a broad
  edge fixture covering all implemented migration issue types, a real PGlite
  destructive migration walkthrough using CRM-flavored fixture data with generic
  migration code, a combined CRM pack-diff + PGlite end-to-end walkthrough with
  safe apply, risky review, destructive staging, cleanup/backfill, validation,
  digest-bound confirmation, destructive cleanup, and revision activation, and a
  complex unsupported-cast workaround walkthrough.
- **Prototype finding:** Changeset operation schema has executable evidence in
  `prototypes/changesets/`: a Deno HTTP server backed by PGlite validates JSON
  payloads, normalizes operations, persists previews, revalidates commit-by-id,
  previews diffs via SQL reads, validates required fields/state
  transitions/version conflicts/relationship aliases/minimal policy, commits SQL
  writes transactionally, records audit events, enforces idempotency and
  idempotency conflicts with a SQL table, applies archive semantics, and lets
  action endpoints generate `changeset.operations.v1` operations reused by the
  same preview/commit engine.
- **Prototype finding:** Hook execution has executable evidence in
  `prototypes/hooks/`: a Deno HTTP runner executes real TypeScript hook scripts
  with one JSON envelope on stdin, validates JSON stdout for `validation.v1`,
  `patch.v1`, and `changeset.operations.v1`, captures stderr logs, enforces
  timeouts, translates hook permissions into Deno flags, captures Deno
  permission failures, and rejects permissions disabled by global policy before
  execution.
- **Prototype finding:** Pack upload to SQL schema compilation has executable
  evidence in `prototypes/pack-sql/`: a Deno HTTP server backed by PGlite
  accepts multipart pack uploads, validates strict paths, explicit metadata
  names, and required hook YAML/script references, normalizes JSON-compatible
  YAML, previews compile steps without DB mutation, applies pack revisions
  transactionally, stores source
  files/resource/field/action/hook/relationship/lifecycle/policy/seed metadata
  and script digests, creates actual SQL resource tables with platform columns
  and `required: true` as `not null`, compiles first-class relationships into
  `rel_*` tables, and persists seed records keyed by seed/resource key. Seed
  files are treated as pack sugar whose real execution path should lower into
  ordinary changeset operations.
- **Decisions before vertical slice:** Persist changeset previews by default and
  revalidate commit-by-id; changesets are all-or-nothing single transactions;
  migration cleanup/backfill uses ordinary changesets, not a special migration
  DSL; references are object-to-object only via direct object reference fields
  or first-class relationship tables; include seeds/reference data in the
  vertical slice; include optctl in the vertical slice; policy means
  authorization/who-can-do-what and uses an internal SQL-lowerable policy model;
  ReBAC is limited to one relationship hop and deeper transitive access should
  be denormalized/directly linked; object history is stored in immutable
  `object_versions` JSON snapshots including the current state, generated
  resource tables are mutable query-optimized current projections with
  `current_object_version_id`, audit/events/outbox point to object versions
  where relevant, and outbox is an internal after-commit hook queue while
  user/agent history comes from object versions plus audit/events/comments.
- **Prototype finding:** Policy authorization has executable evidence in
  `prototypes/policies/`: 60 RBAC/ABAC/one-level-ReBAC policy scenarios compile
  to SQL predicates against PGlite and are checked against runtime evaluation
  for parity. Deep ReBAC traversal is rejected as a hard constraint.
- **Prototype finding:** Pagination with policy filtering has executable
  evidence in `prototypes/pagination/`: `POST /queries` accepts compact CEL-like
  filters, AXI default fields, keyset cursors, and field projections; policy
  predicates are pushed into SQL before pagination; cursors are bound to
  filter/sort/actor-policy digest; one-level ReBAC filtering compiles to a join;
  include-archived requires permission.
- **Prototype finding:** History/audit/events/outbox has executable evidence in
  `prototypes/history-outbox/`: committed writes create immutable
  `object_versions` snapshots, update mutable resource projections with
  `current_object_version_id`, write audit/events linked to versions, enqueue
  after-commit outbox work, and record hook executions from workers.
- **Prototype finding:** Hook attachments have executable evidence in
  `prototypes/hook-attachments/`: metadata-driven resource `before_preview`
  normalization and `validate` hooks, action hooks returning
  `changeset.operations.v1`, and after-commit hooks through outbox all compose
  with the Deno stdin/stdout hook contract.
- **Prototype sketch:** `prototypes/optctl-slice/` captures the vertical-slice
  `optctl` command surface and TOON golden output direction for pack, metadata,
  query, view/history, changeset, action, migration, and backup/export commands.
- **Prototype pack:** `prototypes/crm-default-pack/` is the full default CRM
  pack fixture using namespace `default`, with resources for
  leads/contacts/companies/opportunities/notes/activities/tasks/reference data,
  relationship tables, lifecycle/policy metadata, seed rows, real Deno hook
  scripts, and action definitions. A quick Odoo CRM docs pass reinforced
  defaults around leads as qualification before opportunities, pipeline stages,
  lost reasons, similar lead detection by email/phone, sales teams/assignment,
  activities/next actions, scoring/enrichment, expected revenue/probability, and
  reporting; the pack captures those as ordinary config and scripts.
- **Prototype finding:** Integrated vertical-slice evidence now lives in
  `prototypes/vertical-slice/`: a Deno/PGlite HTTP server applies the CRM pack
  by multipart upload, compiles resources/relationships, stores
  lifecycle/policy/action/hook/seed metadata, lowers seeds into ordinary
  committed changesets, runs normalization/validation/action hooks, commits
  generated operations, records object versions/audit/events/outbox, processes
  after-commit hooks, supports `POST /queries`, and exposes object history.
  Current direction: keep Deno for prototype/server semantics now; later Rust
  `optctl` remains an option for lower startup latency while calling the same
  HTTP API.
- **Prototype finding:** A minimal Deno `optctl` shim now lives in
  `prototypes/optctl/`: it can apply the CRM pack, commit changesets from JSON
  files, query resources, preview/commit actions, and inspect history against
  the vertical-slice HTTP server while printing compact TOON-ish output. This is
  a test/client shim, not the final performance-sensitive Rust CLI.
- **Spec:** `spec/mvp-roadmap.md` now records the main missing functionality
  from the prototypes: optctl ergonomics, query/pagination, policy enforcement,
  metadata-driven hooks, validation/correctness, idempotency, migrations, outbox
  durability, concurrency/performance, and pack authoring validation.
- **Decision:** MVP stack is recorded in `spec/mvp-stack.md`: Deno + Hono for
  the server, Deno + Cliffy for `optctl`, Deno/TypeScript for hooks, raw SQL
  with small typed helpers for storage, explicit schemas/tests now, and OpenAPI
  as useful later but not a blocker because `optctl` plus metadata/AXI is the
  primary agent interface. Keep HTTP and TOON boundaries clean so a future Rust
  CLI remains possible if Deno startup/resource use becomes a problem.
- **Spec:** `spec/mvp-planning-requirements.md` records the latest MVP planning
  requirements: platform-engine MVP target, bundled/app-managed Postgres for
  runtime and tests, hexagonal architecture, TypeBox+Ajv as the selected schema
  system for portability and future OpenAPI optionality, use the `yaml` package
  defaults, start with `@toon-format/toon` behind an adapter, keep schemas
  codified even without OpenAPI generation, and integrate migration/policy/hook
  prototypes into the MVP because installing/upgrading packs and enforcing
  policy are core platform requirements.
- **Spec:** `spec/pre-mvp-open-questions.md` records proposals needed before MVP
  planning resumes: container-only production deployment with bundled Postgres
  binary and external URL override, direnv+shell.nix for raw-process integration
  tests, frozen changeset JSON v0 shape, `@bufbuild/cel` AST spike with custom
  SQL lowerer, current policy prototype/config status, hook
  curated-context/API-only access plus built-in secret resource/env injection
  decision, full migration integration requirement, pragmatic durable outbox
  proposal, metadata/home prototype requirement, and TOON output-only / JSON
  input decision.
- **Prototype finding:** Metadata/home support is now exercised in
  `prototypes/vertical-slice/` and `prototypes/optctl/`: `GET /metadata/home`,
  `GET /metadata/packs`, metadata lookup for resources/actions/hooks/policies,
  plus `optctl home` and `optctl metadata resource ...` verify CRM `axi` and
  schema metadata can drive agent-facing output.
- **Prototype finding:** `prototypes/expression/` shows `@bufbuild/cel` can
  parse CEL into a usable AST, so MVP can avoid writing a parser while still
  owning conservative SQL lowering.
- **Prototype finding:** `prototypes/toon/` verifies `@toon-format/toon` works
  in Deno npm imports for TOON encode/decode behind an adapter.
- **Prototype finding:** `prototypes/secrets/` validates secret permission
  bootstrap: `super_admin` bypasses permission checks, bootstraps an `admin`
  role with secret permissions, and admin users can manage secrets through
  normal permission checks.
- **Prototype finding:** `prototypes/typebox/` validates TypeBox + Ajv across
  YAML pack parsing/normalization, pack config schemas, changeset v0 operation
  schemas, hook envelope/output schemas, Hono boundary validation, metadata
  derivation, and optional future OpenAPI document shape.
- **Prototype finding:** Additional pre-MVP integration spikes now cover
  app-managed Postgres lifecycle (`prototypes/postgres/`, skipped unless PG
  binaries are available), hexagonal Hono/service/port boundaries
  (`prototypes/hexagonal/`), platform DB migrations
  (`prototypes/platform-migrations/`), compiled Deno+Cliffy CLI distribution
  (`prototypes/cliffy/`), policy schema + expression SQL integration
  (`prototypes/policy-expression/`), hook TypeBox + secret injection integration
  (`prototypes/hook-typebox/`), and migration planning from YAML+TypeBox
  validated packs (`prototypes/migration-validated-packs/`).
- **Spec:** MVP route/migration/policy/hook decisions are split into
  `spec/mvp-api-routes.md`, `spec/mvp-migration-integration.md`,
  `spec/mvp-policy-schema.md`, and `spec/mvp-hook-schema.md`.
- **Decision:** Deno hook imports are disallowed initially: no remote imports,
  npm imports, or local relative imports until prototype packs prove the need.
- **Decision:** `optctl` stdout uses TOON. Internal logic can use JSON; stdout
  encodes structured success/error output as TOON.
- **Inferred:** Use one table per resource for business data plus grouped
  platform tables for pack/config registry, changeset/write path,
  audit/events/async, collaboration/artifacts, and migration/operational
  tracking.
- **Decision:** Add first-class metadata APIs/commands (`/metadata`,
  `optctl metadata ...`) so agents can discover packs, resources, actions,
  hooks, lifecycles, AXI guidance, schemas, constraints, and example commands.
  MVP route shape options are captured in `spec/mvp-api-routes.md`.
- **Inferred:** Behavior scripts should be included as files inside a pack
  directory and referenced by relative path. On apply, scripts should be hashed
  and recorded in the config revision so hook execution audit records can refer
  to exact script digests.
- **Inferred:** `Action` and `Hook` have different roles: Action is the
  public/product/API contract for a business intention; Hook is executable
  implementation or lifecycle behavior. Agents should discover/invoke actions,
  while hooks remain implementation details attached to
  actions/resources/transitions/events.
- **Decision:** Use explicit `metadata.namespace` and `metadata.name` for
  persisted identity, while accepting dotted references like
  `crm.commit_convert_lead` as ergonomic config/CLI shorthand that parse to
  `(namespace, name)`.
- **Decision:** Actions are invocable headless “buttons”/business operations
  exposed to agents and users. Hooks are callbacks/executable implementation
  attached to resources, lifecycle transitions, action phases, events, or
  schedules. Hooks do not decide when they run; their attachment point does.
- **Decision:** Hooks should declare their own input schema. Attachment points
  do not invent or remove arbitrary hook inputs; they map available context such
  as `current`, `proposed`, action `input`, `reads`, `related`, transition
  metadata, or constants into the hook's declared inputs. The platform validates
  the mapped input before executing the script.
- **Decision:** Use `required: true` as the only requiredness primitive for
  resource fields and hook inputs. If `required` is omitted, the field/input is
  optional/absent. Hook input is delivered in the canonical stdin JSON envelope;
  missing optional values should be omitted, while empty string is a present
  empty string and can be validated separately.
- **Known:** Lifecycle hooks execute controlled Deno/TypeScript scripts with
  explicit permissions and stdin JSON input.
- **Known:** Validation should support both schema-only validations and runtime
  script validations.
- **Known:** Resource configuration should expose database-level constraints
  such as required fields, unique constraints, foreign-key-like references,
  check constraints, and indexes where supported by the selected backend.
- **Known:** Odoo examples/default product packs should be ordinary
  configuration that users can inspect and hack, not special platform code.
- **Research summary:** Common CRM workflows center on leads, contacts,
  companies/accounts, opportunities/deals, pipeline stages, activities,
  quotes/orders, assignments, follow-ups, forecasting, won/lost closure, and
  reporting. Odoo CRM docs emphasize pipeline organization, lead
  acquisition/enrichment, assignment, activities, lost reasons, recurring plans,
  and reporting. This supports a default headless CRM pack as configuration plus
  scripts.

## Status and Evidence

- **Known:** The repository currently has no application source files, README,
  package manifests, or existing `.ai` project artifacts. It only contains
  `codedb.snapshot` and Git metadata.
- **Known:** This understanding is therefore seeded primarily from the user's
  product vision and light external documentation research.
- **Research note:** Odoo 18.0 user documentation groups apps under broad
  product areas including Essentials, Finance, Sales, Websites, Inventory & MRP,
  HR, Marketing, Services, Productivity, Studio, and General Settings. The Odoo
  docs index at `https://www.odoo.com/documentation/18.0/applications.html` was
  used as the initial product taxonomy reference.
- **Unknown:** The implementation stack, target language, repo conventions, and
  near-term milestone are not yet defined.
- **Known:** The deployment model should support SQLite for simple single-node
  deployments and Postgres for horizontal scaling with Postgres as the only
  required coordination point.

## Working Vision

**Known:** Build an API-first operational data platform for AI agents: not a
database, CRM, Airtable clone, or automation tool, but a control plane for safe
business operations.

The core philosophy is:

> If an AI agent is allowed to modify your business, it should do so through a
> system that enforces correctness by default.

**Inferred positioning:** This is a "business object operating system" analogous
to Kubernetes for business operations. Kubernetes gives infrastructure engineers
safer primitives than raw Linux processes; this platform should give AI agents
safer business primitives than raw database rows.

## Product Goals

- **Known:** Provide object types rather than exposing raw tables.
- **Known:** Put all writes through a changeset engine with preview, validation,
  authorization, transition checks, locking, transactionality, audit,
  events/webhooks, and commit semantics.
- **Known:** Let agents submit intentions, not row mutations.
- **Known:** Make state machines, approvals, RBAC, auditability, optimistic
  locking, idempotency, events, rollback/recovery, and extension points default
  platform capabilities.
- **Known:** Support AI-friendly interaction patterns: read, reason, preview,
  commit, recover.
- **Known:** Support SQLite and Postgres storage modes. SQLite is for
  simple/local installs; Postgres is for scale-out/concurrency. The
  single-tenant open-source model is now the default design center.
- **Inferred:** The system should be useful underneath CRMs, support tools,
  project-management tools, workflow apps, and agentic operational software.

## Intended Users and Use Cases

- **AI agents:** Need to answer "Can I do this?" before "How do I update this
  row?" and need safe, introspectable primitives for operational work.
- **Developers building AI applications:** Need reusable governance and
  data-operation primitives instead of rebuilding RBAC, auditing, approvals,
  history, idempotency, and state transitions for every app.
- **Operations teams / business owners:** Need confidence that AI-driven changes
  are reviewable, reversible, permissioned, and policy-compliant.
- **Admins / platform owners:** Need to define object types/resources,
  extensions, transition rules, policies, constraints, hooks, ownership, and
  indexing/queryability.

Example operational intentions:

- Create task
- Update contact
- Attach note
- Link objects
- Transition deal
- Delete reminder
- Approve/reject proposed change
- Undo a committed change where supported

## Core Abstractions

### Object Types

**Known:** Users create object types such as:

- Task
- Project
- Contact
- Company
- Deal
- Ticket
- Run
- Incident
- Document

**Inferred:** Object types are platform-level business resources with built-in
capabilities, not thin wrappers around database tables.

### Built-in Capabilities Every Object Should Gain

Identity:

- UUID
- Tenant
- Timestamps
- Version
- Creator
- Last modifier

Collaboration:

- Comments
- Attachments
- Labels/tags
- Links/relationships

Governance:

- RBAC
- Audit history
- Optimistic locking
- Soft delete
- Approvals
- Ownership

AI/API:

- Semantic search
- Summaries
- MCP tools
- REST API
- CLI

### Changeset Engine

**Known desired write path:**

1. Preview changeset
2. Validate
3. RBAC / policy checks
4. Transition rules
5. Optimistic lock checks
6. Transaction
7. Audit
8. Webhook/event
9. Commit

**Known:** Every write should follow this exact path. Agents never directly
update rows; they submit an intention bundled into a transaction.

Capabilities implied by this model:

- Atomicity
- Previews/diffs
- Approval workflows
- Rollback / undo semantics where feasible
- Idempotency
- Conflict detection
- Auditable intent and outcome

### State Machines

**Known:** Object types can define lifecycle rules such as
`todo -> doing -> blocked -> done`.

State-machine policy dimensions:

- Allowed transitions
- Required fields by state or transition
- Permissions by transition
- Approval requirements
- Ownership requirements
- Validation hooks

### Extensions

**Known:** Users should not need migrations every time an agent wants more
metadata.

Example extension namespaces for `Task`:

- `github`
- `forecasting`
- `sales-agent`
- `jira-sync`

**Known:** Extensions can add fields without polluting core object definitions.
Only declared extension fields become queryable/indexed.

**Open tension:** The extension system needs to balance flexibility, type
safety, validation, indexability, search, and backend portability across
SQLite/Postgres.

### Policies

Every action is evaluated against:

- RBAC
- Tenant isolation
- Transition rules
- Validation
- Object ownership

before touching storage.

## API Philosophy

**Known:** The API is action-oriented, not CRUD-oriented.

Candidate actions:

- Create object
- Preview changes
- Commit changes
- Search
- Query
- Approve
- Reject
- Undo

**Inferred:** `PATCH /objects/:id` style APIs should be avoided or treated as
lower-level internals. Public APIs should preserve intent, previewability,
recoverability, and policy checks.

## Architecture Sketch

**Known initial storage direction:**

- SQLite mode for simple/local/single-container deployments
- Postgres mode for concurrency and horizontal scaling
- Single-tenant by default; no `tenant_id` required in the core OSS model
- JSON/JSONB for extensible properties depending on backend
- Relations and foreign-key-like constraints exposed through resource
  configuration
- Event/outbox tables

**Inferred core components:**

- Object type registry
- Extension registry / schema registry
- Changeset builder and previewer
- Schema and runtime validation engine
- Policy/RBAC/ABAC engine
- State-machine engine
- Hook/script execution engine
- Optimistic locking/versioning layer
- Transaction orchestrator
- Audit/event store
- Webhook/event dispatcher
- Query/search/indexing layer
- Semantic indexing/summarization subsystem
- MCP/REST/CLI API adapters

**Spec-driven development idea:** Use `spec/` markdown files to define
conceptual contracts before implementation. Candidate spec documents:

- `spec/vision.md`
- `spec/object-model.md`
- `spec/changesets.md`
- `spec/policies.md`
- `spec/state-machines.md`
- `spec/extensions.md`
- `spec/events-audit.md`
- `spec/api-actions.md`
- `spec/storage-postgres.md`
- `spec/odoo-object-map.md`

These are suggestions only; `/dag brainstorm` did not create them.

## Constraints and Non-goals

### Known / Strongly Indicated Constraints

- Correctness by default matters more than raw CRUD convenience.
- Agents should be guided toward previewable, policy-checked operations.
- Single-tenant OSS deployment is the default design center; multi-tenancy is
  optional/future layering.
- Audit, history, and idempotency are platform primitives.
- Extension fields must be declared to become queryable/indexed.
- Initial storage should be Postgres, not a bespoke database.

### Non-goals / Positioning Boundaries

- Not a database.
- Not a CRM.
- Not Airtable.
- Not an automation tool.
- Not "Odoo clone" at the field/workflow level.
- Not necessarily a UI-first product.
- Not direct SQL/table mutation as the product abstraction.

### Conflicts / Tensions

- **Flexibility vs. governance:** AI agents need adaptable metadata, but
  enterprise safety requires schemas, policies, and audits.
- **Generic object platform vs. domain-specific usefulness:** Object types
  should be reusable across domains, but users will expect domain primitives
  that feel native.
- **Action API vs. developer familiarity:** Developers know CRUD; the platform
  wants action/intent semantics.
- **JSONB extension flexibility vs. query/index quality:** Declared extension
  fields help, but schema evolution and indexing strategy need careful design.
- **Undo/rollback promise vs. real-world side effects:** Some
  events/webhooks/external integrations may be irreversible.
- **Odoo coverage vs. product focus:** Replicating Odoo's object surface is
  useful for completeness research, but the platform should not inherit all Odoo
  assumptions.

## Validation Intent

The work is successful when:

- The project has durable specs in `spec/` that explain the platform without
  relying on chat history.
- A developer can read the specs and understand the object model, changeset
  lifecycle, policy model, extension model, and API philosophy.
- An AI agent can determine whether an intended action is allowed before
  committing changes.
- Every write can be previewed, validated, authorized, conflict-checked,
  committed atomically, audited, and emitted as an event.
- Odoo-inspired object coverage is mapped as object names grouped by product
  area without prematurely copying Odoo's field model.
- The platform's differentiation remains clear: safe operational primitives for
  AI agents, not tables-with-a-UI.

## Odoo-Inspired Object Name Inventory

Purpose: create a broad object-name catalog inspired by Odoo's product grouping.
This is not a commitment to implement all products, copy fields, or replicate
Odoo workflows. It is a completeness lens for eventual object primitives.

### Cross-App / Essentials

- Activity
- Stage
- Comment
- Attachment
- Label
- Tag
- Contact
- Company
- Address
- Product
- Product Category
- Unit of Measure
- Pricelist
- Import Job
- Export Job
- Report
- Saved Filter
- Search View
- Rich Text Document
- In-App Purchase Credit

### Finance: Accounting and Invoicing

- Chart of Accounts
- Account
- Journal
- Journal Entry
- Journal Item
- Tax
- Tax Group
- Tax Unit
- Fiscal Position
- Fiscal Year
- Fiscal Period
- Customer Invoice
- Vendor Bill
- Credit Note
- Refund
- Payment
- Payment Term
- Payment Provider
- Payment Method
- Batch Payment
- Bank Account
- Cash Account
- Bank Statement
- Bank Transaction
- Reconciliation
- Reconciliation Model
- Internal Transfer
- Asset
- Deferred Revenue
- Deferred Expense
- Loan
- Budget
- Analytic Account
- Analytic Plan
- Analytic Line
- Tax Return
- Tax Carryover
- Intrastat Declaration
- Accounting Report
- Localization Package
- EDI Document
- Invoice Sequence
- Incoterm

### Finance: Expenses and Payments

- Expense
- Expense Category
- Expense Report
- Expense Policy
- Receipt
- Reimbursement
- Payment Transaction
- Payment Token
- Payment Link
- Payment Acquirer / Provider Configuration

### Sales: CRM

- Lead
- Opportunity
- Deal
- Sales Team
- Sales Pipeline
- Pipeline Stage
- Activity Plan
- Lost Reason
- Campaign Source
- Contact Enrichment Request

### Sales: Sales Orders

- Quotation
- Sales Order
- Sales Order Line
- Customer
- Pricelist
- Discount
- Coupon
- Loyalty Program
- Promotion
- Delivery Method
- Shipping Rule
- Sales Commission
- Sales Report

### Sales: Point of Sale

- POS Session
- POS Order
- POS Order Line
- POS Payment
- POS Register
- POS Configuration
- Cash In/Out
- Receipt
- Floor Plan
- Table
- Restaurant Order
- Tip

### Sales: Subscriptions, Rental, Members

- Subscription
- Subscription Plan
- Subscription Template
- Subscription Invoice
- Renewal
- Churn Reason
- Rental Order
- Rental Product
- Rental Period
- Pickup
- Return
- Member
- Membership
- Membership Level
- Membership Invoice

### Websites

- Website
- Web Page
- Page Version
- Menu Item
- Redirect
- Domain
- SEO Metadata
- Website Form
- Visitor
- Tracking Event
- Cookie Consent

### eCommerce

- Shop
- Cart
- Cart Line
- Checkout
- Online Order
- Product Listing
- Product Variant
- Product Attribute
- Product Attribute Value
- Wishlist
- Product Review
- Shipping Carrier
- Abandoned Cart

### eLearning, Forum, Blog, Live Chat

- Course
- Lesson
- Quiz
- Quiz Question
- Quiz Attempt
- Certification
- Learner Enrollment
- Forum
- Forum Post
- Forum Topic
- Forum Answer
- Vote
- Blog
- Blog Post
- Blog Category
- Blog Author
- Live Chat Channel
- Live Chat Conversation
- Chat Operator
- Chat Transcript
- Chatbot Script

### Inventory

- Warehouse
- Location
- Storage Category
- Product
- Product Variant
- Lot
- Serial Number
- Package
- Packaging
- Stock Quant
- Stock Move
- Stock Move Line
- Transfer
- Picking
- Operation Type
- Putaway Rule
- Reordering Rule
- Route
- Procurement Rule
- Inventory Adjustment
- Scrap
- Landed Cost
- Delivery Order
- Receipt
- Return
- Reservation

### Manufacturing (MRP)

- Bill of Materials
- BOM Line
- Manufacturing Order
- Work Order
- Work Center
- Routing
- Operation
- Component
- Byproduct
- Production Lot
- Production Schedule
- Master Production Schedule
- Capacity Plan
- Manufacturing Backorder

### Purchase

- Vendor
- Vendor Pricelist
- Purchase Agreement
- Request for Quotation
- Purchase Order
- Purchase Order Line
- Purchase Receipt
- Vendor Bill
- Blanket Order
- Call for Tender

### Barcode, Quality, Maintenance, PLM, Repairs

- Barcode Rule
- Barcode Nomenclature
- Barcode Scan Event
- Quality Point
- Quality Check
- Quality Alert
- Quality Team
- Quality Worksheet
- Maintenance Equipment
- Maintenance Request
- Maintenance Team
- Preventive Maintenance Schedule
- Engineering Change Order
- ECO Stage
- Product Revision
- Document Revision
- Approval Route
- Repair Order
- Repair Line
- Repair Fee
- Repair Part

### HR: Employees and Attendance

- Employee
- Department
- Job Position
- Manager Assignment
- Work Location
- Contract
- Resume Line
- Skill
- Certification
- Attendance
- Check In
- Check Out
- Work Schedule
- Resource Calendar

### HR: Appraisals, Frontdesk, Fleet, Payroll, Time Off

- Appraisal
- Appraisal Goal
- Feedback Request
- Frontdesk Station
- Visitor
- Visit
- Appointment
- Fleet Vehicle
- Vehicle Contract
- Driver
- Odometer Reading
- Fuel Log
- Service Log
- Payroll Rule
- Salary Structure
- Payslip
- Payslip Batch
- Work Entry
- Leave Type
- Time Off Request
- Allocation
- Holiday Calendar

### HR: Recruitment, Referrals, Lunch

- Job Applicant
- Recruitment Stage
- Job Posting
- Interview
- Offer
- Referral
- Referral Reward
- Lunch Vendor
- Lunch Product
- Lunch Order
- Lunch Alert

### Marketing

- Mailing List
- Mailing Contact
- Email Campaign
- SMS Campaign
- Marketing Campaign
- Marketing Automation
- Automation Trigger
- Automation Activity
- Mailing Trace
- UTM Campaign
- UTM Medium
- UTM Source
- Social Account
- Social Post
- Social Stream
- Event
- Event Track
- Event Session
- Event Registration
- Event Ticket
- Sponsor
- Survey
- Survey Question
- Survey Answer
- Survey Response
- Marketing Card

### Services: Project, Timesheets, Planning, Field Service, Helpdesk

- Project
- Task
- Subtask
- Milestone
- Sprint / Iteration
- Task Stage
- Task Dependency
- Timesheet Entry
- Timesheet Sheet
- Billable Time
- Planning Slot
- Shift
- Resource Assignment
- Field Service Order
- Worksheet
- Onsite Appointment
- Helpdesk Ticket
- Ticket Stage
- SLA Policy
- SLA Status
- Support Team
- Canned Response
- Escalation

### Productivity: Documents, Sign, Spreadsheet, Dashboards, Knowledge

- Document
- Folder
- Workspace
- Document Tag
- Document Request
- Document Share
- Signature Request
- Sign Template
- Signer
- Signature Field
- Spreadsheet
- Spreadsheet Revision
- Dashboard
- Dashboard Widget
- KPI
- Knowledge Article
- Knowledge Workspace
- Knowledge Category
- Knowledge Version

### Productivity: Calendar, Appointments, Discuss, Data Cleaning, WhatsApp, VoIP, To-do

- Calendar Event
- Meeting
- Attendee
- Reminder
- Appointment Type
- Appointment Slot
- Booking
- Channel
- Direct Message
- Message
- Thread
- Reaction
- Data Cleaning Rule
- Duplicate Candidate
- Merge Request
- WhatsApp Account
- WhatsApp Template
- WhatsApp Message
- Phone Call
- Call Queue
- Call Log
- VoIP Device
- To-do
- Personal Task

### Studio / Customization

- Custom Model
- Custom Field
- View
- View Component
- Action
- Server Action
- Automation Rule
- Approval Rule
- PDF Report
- Menu Item
- Module
- App

### General / Administration / Integrations / IoT

- User
- Group
- Role
- Permission
- Access Rule
- Record Rule
- Company
- Tenant
- Multi-Company Rule
- Digest Email
- Email Template
- Mail Server
- Inbound Message
- Outbound Message
- DNS Configuration
- Integration
- OAuth Connection
- API Key
- Webhook
- Connector
- IoT Box
- IoT Device
- Printer
- Scale
- Camera
- Measurement Tool
- Footswitch
- Screen
- Localization
- System Setting
- Audit Log

## Object Model Themes Emerging From the Odoo Inventory

- Many Odoo modules share the same primitives: stages, activities, messages,
  attachments, users, companies, products, documents, approvals, and reports.
- The platform may need a small number of powerful base object capabilities
  rather than one bespoke framework per product.
- Several domain objects are really specializations of generic concepts:
  - `Ticket`, `Task`, `Field Service Order`, `Maintenance Request`,
    `Repair Order`, and `Quality Alert` are all work items with lifecycle,
    ownership, SLA/priority, comments, attachments, and links.
  - `lead`, `opportunity`, `Deal`, `Applicant`, and `Subscription Renewal` are
    pipeline objects with stages and conversion/close semantics.
  - `Invoice`, `Vendor Bill`, `Payment`, `Expense Report`, and `Payslip` are
    financial documents with approval, posting, audit, and reversal constraints.
  - `Document`, `Knowledge Article`, `Spreadsheet`, and `Sign Template` are
    content objects with versions, permissions, and collaboration.
- Odoo breadth suggests the platform should separate **universal object
  infrastructure** from **domain packs** or **object templates**.

## Risks

- The platform can become too abstract if object primitives are not grounded in
  real operational workflows.
- Trying to cover all Odoo-like objects too early may dilute the core
  changeset/policy engine.
- The changeset engine could become complex if every domain-specific validation
  is encoded centrally.
- Enterprise governance features may slow developer onboarding unless APIs and
  specs are very clear.
- Semantic search/summaries over operational data raise permissions, freshness,
  and auditability questions.
- Event/webhook side effects complicate undo semantics.
- SQLite/Postgres portability with indexed extension fields needs careful
  migration/index lifecycle design.

## Open Decisions and Unknowns

- What is the first concrete product slice: generic object platform,
  task/project domain, CRM domain, support/helpdesk domain, or Odoo object
  inventory spec?
- What language/framework will be used?
- What is the desired spec style: RFCs, executable examples, OpenAPI-like
  contracts, state-machine diagrams, or lightweight markdown narratives?
- How strict should object schemas be before first commit?
- Are object/resource types core-defined, pack-defined, user-defined, or
  layered?
- How are extension schemas versioned?
- How are policy rules authored: declarative DSL, code hooks, SQL/RLS, external
  policy engine, or hybrid?
- What is the relationship between RBAC, ABAC, ownership, resource constraints,
  and object lifecycle permissions?
- What counts as a reversible/undoable change?
- How should webhooks/events participate in transactions or outbox delivery?
- How will semantic search respect RBAC/ABAC, ownership, and local resource
  permissions?
- Should Odoo-inspired product packs be examples, built-in templates, or just
  research scaffolding?

## Suggested GrillMe Starting Points

These are exploratory seeds only. A future `/dag grillme` pass may keep, merge,
split, rewrite, drop, or add questions.

- **First product slice:** Choose between building the core changeset engine
  spec first vs. grounding it in one domain such as Tasks/Projects, CRM/Deals,
  or Helpdesk/Tickets.
- **Object type authority:** Decide whether object/resource types are
  platform-defined, pack-defined, user-defined, or layered.
- **Changeset semantics:** Clarify preview format, validation output,
  idempotency keys, conflict reporting, partial failures, and approval handoff.
- **State machine model:** Explore whether lifecycle rules are optional per
  object type or a universal primitive.
- **Extension schema lifecycle:** Decide how extension fields are declared,
  validated, indexed, migrated, deprecated, and permissioned.
- **Policy model:** Compare RBAC-only, RBAC+ownership, ABAC, relation-based
  access control, PostgreSQL RLS, and policy-engine approaches.
- **Undo vs. compensation:** Define where rollback is literal database reversal
  vs. compensating changes vs. impossible after external side effects.
- **Odoo object inventory:** Treat the Odoo-derived list as research scaffolding
  in `spec/odoo-object-map.md`; decide later what level of coverage is enough.
- **API ergonomics:** Explore how to make action-oriented APIs feel natural to
  developers accustomed to CRUD.
- **AI interaction contract:** Define what an agent needs to inspect before
  acting: capabilities, allowed actions, required approvals, expected diffs, and
  recovery paths.

## GrillMe understanding update

## MVP spec consistency pass

- Added `spec/mvp-acceptance-criteria.md` defining the executable MVP done-state: CRM default fixture applies as-is, second Odoo-inspired project-management pack is required, app-managed/external Postgres runtime, policy/security/output/API acceptance.
- Added `spec/mvp-implementation-boundaries.md` freezing the hexagonal module layout and adapter boundaries for subagent implementation.
- Added `spec/project-management-pack.md` defining `default.project_management@0.1.0` with project/task/stage/milestone/tag/timesheet resources, lifecycle, actions, hooks, policies, seeds, and acceptance path.
- Resolved spec inconsistencies:
  - SQLite references updated: MVP is Postgres-only; SQLite is out of MVP scope.
  - PGlite clarified as prototype-only, not runtime/integration-test default.
  - YAML normalization clarified: use `yaml` package with merge-key support; anchors/aliases/merge keys are authoring sugar; reject custom tags/non-JSON/multi-doc features.
  - Metadata routes aligned to Proposal A (`/metadata/resources/{namespace}/{resource}` etc.); `optctl` keeps dotted IDs and translates.
  - Pre-MVP questions now say ready for MVP planning instead of paused.
  - CRM design research marked historical; `prototypes/crm-default-pack/` is canonical for MVP.
- Verification: `deno fmt spec` and focused prototype tests passed: 26 passed | 0 failed. App-managed Postgres test skipped runtime exercise due missing local PG binaries, as expected outside direnv/nix-provided PG tools.
