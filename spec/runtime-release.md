<!-- generated-by: pi-dag-workflow/project-model; view: view-runtime-release; contract: 1; input: sha256:eeb36e6cf9dd060ab9ea43194770fecdab60f439742aad5265ffb74d99b34e89 -->

# Runtime, architecture, and release

Canonical runtime, architecture, and release decisions and contracts projected from project-model/model.json.

## Outcomes and intent

<a id="obj-int-no-attestation"></a>

### Do not require SBOM, signing, or provenance attestation

SBOM generation, artifact signing, and provenance attestation are explicitly out of scope and are not remaining concerns.

## Concepts

<a id="obj-con-release-gate"></a>

### Exact release gate

A clean exact-HEAD archive produces one frozen image/artifact identity and one complete suite; cleanup is exact for global Docker resources and exact-owned for host processes/temp roots.

## Scenarios

<a id="obj-scn-shutdown"></a>

### Shut down app-managed runtime under load

The server and managed PostgreSQL have live or checkpoint-heavy work. SIGTERM/SIGINT arrives after readiness. Handlers are already armed; server/outbox stop is bounded; PostgreSQL smart then fast then immediate native shutdown is reaped; restart recovers durable state.

**Context.** The server and managed PostgreSQL have live or checkpoint-heavy work.

**Action.** SIGTERM/SIGINT arrives after readiness.

**Expected outcome.** Handlers are already armed; server/outbox stop is bounded; PostgreSQL smart then fast then immediate native shutdown is reaped; restart recovers durable state.

<a id="obj-scn-release"></a>

### Produce and validate one release image

The worktree is clean at an exact HEAD and explicit release base. Run the release gate once. One immutable archive/image/artifact and one complete suite pass; exact global Docker inventory and exact owned host resources return to baseline.

**Context.** The worktree is clean at an exact HEAD and explicit release base.

**Action.** Run the release gate once.

**Expected outcome.** One immutable archive/image/artifact and one complete suite pass; exact global Docker inventory and exact owned host resources return to baseline.

## Decisions

<a id="obj-dec-stack"></a>

### Use Deno, Hono, Cliffy, raw SQL, TypeBox/Ajv, YAML, and TOON

The server runs on Deno with Hono; optctl uses Cliffy and is freshly compilable; persistence uses raw parameterized PostgreSQL SQL; contracts use TypeBox/Ajv; packs use strict YAML to canonical JSON; TOON is the default CLI rendering.

<a id="obj-dec-postgres-only"></a>

### Use PostgreSQL as the production data and coordination layer

Production supports external PostgreSQL through OPERANT_DATABASE_URL or app-managed PostgreSQL under OPERANT_DATA_DIR. PGlite is prototype evidence only and SQLite is out of scope.

<a id="obj-dec-hexagonal"></a>

### Keep orchestration inward and concrete adapters in composition

Application code depends on domain/application ports, adapters own physical/atomic primitives, and composition constructs concrete adapters. Direct and transitive application-to-adapter paths are zero; no allowlist or ratchet remains.

<a id="obj-dec-release-integrity"></a>

### Build once and clean only exact proven release ownership

The gate freezes an explicit-base exact-HEAD archive and full image ID, publishes exact artifacts, runs one complete suite, never prunes, restores global Docker sets byte-for-byte, and removes only durably proven owned processes/temp roots. Successor planning may include the external release path, but repository creation, local or hosted remote mutation, source push, release-tag creation or push, GHCR publication, and GitHub release publication each remain blocked until the user grants explicit later authorization bound to the exact destination, source commit, artifact identity, and effect. Planning, plan approval, and general implementation authority do not authorize those effects.

<a id="obj-dec-release-format-authority"></a>

### Format-check project-model documentation in release validation

Release validation format-checks project-model alongside source, tests, docs, and deno.json. The transitional hand-authored spec corpus remains locally format-addressable but will be removed after reviewed project-model replacement, so the release contract targets the future sole authority rather than creating formatting churn in files selected for deletion.

**Rationale.** Release checks must cover the durable semantic authority that will remain after cutover.

<a id="obj-dec-runtime-modes"></a>

### Use exactly external or app-managed PostgreSQL runtime modes

OPERANT_DATABASE_URL selects exact external PostgreSQL with no fallback. Otherwise Operant owns official PostgreSQL under OPERANT_DATA_DIR over loopback TCP. The default image runs the server under tini with one in-process outbox loop and no database/worker sidecars or generic supervisor.

**Rationale.** These are the two implemented and release-tested modes.

<a id="obj-dec-cli-parser-boundary"></a>

### Keep CLI parsing inside the Cliffy adapter without duplicating domain rules

The compiled optctl executable remains the Cliffy inbound adapter. Cliffy constructs the command/help surface; the adapter may parse argv and map exit statuses directly, provided all schema, authorization, migration, hook, seed, query, and changeset decisions remain server/application contracts and adapter tests cover parsing, help, and exit behavior.

**Rationale.** This describes the tested implementation without weakening the compiled Cliffy boundary or moving business policy into the CLI.

<a id="obj-dec-optd-development-state"></a>

### Require fresh optd state after the pre-release rename

Existing Operant development databases, local credentials and contexts, process bindings, encrypted secret metadata, pack revisions, and publisher-qualified stored references are disposable. The optd migration provides no runtime alias, in-place database upgrade, credential import, or local data-directory migration. Release acceptance starts from fresh optd state.

**Rationale.** No deployed state needs preservation, and fresh-state acceptance avoids hidden compatibility branches.

**Related cross-domain objects**

- supports: [Do not build development-era compatibility](packs-projects.md#obj-int-no-compat)

## Commitments

<a id="obj-com-managed-postgres"></a>

### Make app-managed PostgreSQL lifecycle bounded and native

Readiness is published only after signal handlers are armed. Shutdown uses bounded smart SIGTERM, fast SIGINT, then PostgreSQL immediate SIGQUIT with authoritative reap and crash recovery; external mode never owns the database.

<a id="obj-com-runtime-modes"></a>

### Support exactly app-managed and external PostgreSQL container modes

Without OPERANT_DATABASE_URL the app owns PostgreSQL under OPERANT_DATA_DIR. With it, the app validates and uses external PostgreSQL and never falls back. PostgreSQL 17+ is the documented runtime minimum; acceptance uses 18.4.

<a id="obj-com-release-cleanup"></a>

### Require exact release ownership and cleanup

Every destructive Docker/process action is preceded by exact durable ownership and identity validation. Image cleanup accounts for legacy builder frames and removes exact IDs child-to-parent without force/prune. Cleanup ambiguity blocks success.
