<!-- generated-by: pi-dag-workflow/project-model; view: view-packs-projects; contract: 1; input: sha256:10ebba6220b7eae39f64777db793dfdbbb1a72629a4499d372a606715bc75b31 -->

# Packs, Projects, and resources

Canonical packs, projects, and resources decisions and contracts projected from project-model/model.json.

## Outcomes and intent

<a id="obj-int-no-compat"></a>

### Do not build development-era compatibility

There are no deployed users or customer databases requiring legacy aliases, routes, schemas, identifiers, or incompatible secret data to survive the current cutover. Ordinary pack migrations remain supported.

<a id="obj-int-no-registry"></a>

### Do not build a pack registry yet

Packs are installed from local sources with optctl; registry discovery, trust, and distribution protocols are outside the current product.

<a id="obj-int-no-extension-system"></a>

### Use ordinary packs rather than a separate extension system

Do not add an extension API or arbitrary plugin runtime for the MVP; pack definitions, migrations, hooks, policies, and actions are the extension mechanism.

## Concepts

<a id="obj-con-publisher-pack"></a>

### Publisher-qualified pack

A globally installed immutable definition bundle identified by publisher/pack, with one active revision server-wide and child identities publisher/pack:name.

<a id="obj-con-platform-project"></a>

### Platform Project

A built-in UUIDv7 runtime data and authorization boundary, distinct from pack publisher and from any proof-pack domain project resource.

<a id="obj-con-resource-object-version"></a>

### Resource, object, and version

A resource is a global definition; an object is a Project-scoped UUIDv7 current projection; object versions are immutable committed snapshots.

<a id="obj-con-seed-reconciliation"></a>

### Active-only seed reconciliation

Seed business keys are Project-scoped and unique only among active rows; archived matches are absent and create fresh active UUIDv7 objects.

<a id="obj-con-migration-plan"></a>

### Atomic migration plan

An immutable classified pack migration plan applies as one locked transaction; complex changes use explicit intermediate revisions and ordinary cleanup changesets.

## Scenarios

<a id="obj-scn-pack-apply"></a>

### Preview and atomically activate a pack

A strict local pack source targets the global server. An authorized actor previews exact files and applies the immutable plan. SQL, metadata, activation, token consumption, and audit commit in one transaction; one global revision becomes active or no change occurs.

**Context.** A strict local pack source targets the global server.

**Action.** An authorized actor previews exact files and applies the immutable plan.

**Expected outcome.** SQL, metadata, activation, token consumption, and audit commit in one transaction; one global revision becomes active or no change occurs.

<a id="obj-scn-archived-seed"></a>

### Reconcile a seed whose business key exists only archived

Only archived generations match the Project-scoped seed key. Seed staging/reconciliation runs. A new active UUIDv7 object is created; archived rows/history remain immutable; repeat is unchanged.

**Context.** Only archived generations match the Project-scoped seed key.

**Action.** Seed staging/reconciliation runs.

**Expected outcome.** A new active UUIDv7 object is created; archived rows/history remain immutable; repeat is unchanged.

<a id="obj-scn-transitional-migration"></a>

### Perform a breaking CRM migration explicitly

A live CRM v1 schema needs a destructive v2 change. Apply an additive transitional revision, migrate data through ordinary public changesets, then apply destructive cleanup with exact confirmation. Every pack revision activates atomically, public data remains coherent, and no hidden backfill/cast DSL or partial plan is used.

**Context.** A live CRM v1 schema needs a destructive v2 change.

**Action.** Apply an additive transitional revision, migrate data through ordinary public changesets, then apply destructive cleanup with exact confirmation.

**Expected outcome.** Every pack revision activates atomically, public data remains coherent, and no hidden backfill/cast DSL or partial plan is used.

## Decisions

<a id="obj-dec-global-packs-project-facts"></a>

### Install one global pack revision and scope runtime facts by Project

Publisher-qualified packs and definitions are global with one active revision; runtime objects, relationships, changesets, assignments, and policy evaluation carry explicit UUIDv7 Project scope.

<a id="obj-dec-qualified-identity"></a>

### Use publisher/pack:name without aliases

Canonical definition identity is publisher/pack:name. The publisher has no @ prefix; dotted default.* and legacy namespace aliases are rejected.

<a id="obj-dec-uuidv7"></a>

### Use server-issued UUIDv7 platform identities

Platform IDs are lowercase server-issued UUIDv7 values; domain-readable keys belong in separate constrained fields.

<a id="obj-dec-strict-pack-source"></a>

### Use strict convention-based YAML pack source

Pack preview scans a fixed directory grammar, rejects unknown files/fields/aliases, pairs hook YAML/TS, normalizes to canonical JSON, and does not support include/path-list/archive input.

<a id="obj-dec-atomic-migrations"></a>

### Apply each migration plan atomically

Safe, risky, and destructive classification is intrinsic; a whole immutable plan applies under locks in one transaction. Explicit transitional revisions and normal cleanup changesets handle hard changes.

<a id="obj-dec-projects-timesheet-identity"></a>

### Use operant/projects:timesheet as the canonical proof-pack resource

The Projects proof pack uses the publisher-qualified resource identity operant/projects:timesheet. The timesheet_entry variant is not canonical and no compatibility alias is provided.

**Rationale.** Pack YAML, policies, AXI metadata, shared host/container flows, and E2E already agree on timesheet. Aligning prose avoids a broad rename and preserves the no-alias rule.

<a id="obj-dec-project-member-resource"></a>

### Model Projects membership as a domain resource

operant/projects:project_member remains an explicit resource because membership carries role, active uniqueness, history, and policy-visible lifecycle. Generic relationships may target read-only system:principal, but that does not replace the richer membership object.

**Rationale.** This corrects the rationale while preserving the implemented proof-pack model.

<a id="obj-dec-optd-api-namespace"></a>

### Use optd.dev/v1 as the Pack API namespace

Strict optd Pack documents use apiVersion optd.dev/v1. The user controls optd.dev, and current successor-planning evidence observes TXT _optd-control.optd.dev exactly as pi-dag-workflow=b1c0895ca2a37f9b592044e84c7e75ad. Release readiness requires this separately supplied Cloudflare TXT challenge to be freshly observed at both authoritative nameservers and at least two independent validating resolvers; missing, stale, inconsistent, or ambiguous evidence fails closed. operant.dev/v1 is rejected rather than accepted as an alias; historical evidence may retain it only when explicitly non-normative.

**Rationale.** The user selected optd.dev/v1 and made control of optd.dev a release prerequisite.

**Related cross-domain objects**

- supports: [Use one complete optd identity before the first release](product.md#obj-dec-optd-identity-matrix)

## Commitments

<a id="obj-com-active-seeds"></a>

### Replace archived seed matches with fresh active UUIDv7 objects

Named Project-scoped business-key uniqueness applies only where active. Archived matches are absent; reconciliation creates a fresh active UUIDv7, preserves history, and deterministic races yield one winner and zero loser facts.
