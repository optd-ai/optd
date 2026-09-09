<!-- generated-by: pi-dag-workflow/project-model; view: view-product; contract: 1; input: sha256:0281cf56da4ebbaf51910e0344b7b1625319cfa4e776fecf2e74e98c3406706e -->

# Product direction

Canonical product direction decisions and contracts projected from project-model/model.json.

## Outcomes and intent

<a id="obj-int-platform-engine"></a>

### Provide an operational data platform for AI agents

Build an API-first operational data platform that lets agents safely operate structured business data and workflows without making CRM or Projects the product boundary.

<a id="obj-int-single-tenant-oss"></a>

### Default to open-source single-tenant operation

Optimize the core for self-hosted, single-tenant deployments; horizontal scaling may use PostgreSQL coordination, but SaaS multi-tenancy is not the design center.

<a id="obj-int-agent-ergonomics"></a>

### Keep agent operation discoverable and low-friction

Agents should authenticate once per process identity, discover capabilities through stable APIs/CLI/AXI, receive compact machine-readable output, and avoid repeated escalation or prompt loops.

## Concepts

<a id="obj-con-axi-toon"></a>

### AXI and TOON interface

HTTP JSON is protocol truth; compiled optctl provides stable commands, default TOON, optional JSON, metadata, and AXI guidance for agents.

## Decisions

<a id="obj-dec-error-registry"></a>

### Use one canonical transport error registry

Malformed JSON or a non-object transport shape returns HTTP 400 with bad_request or invalid_json. A well-formed request that violates schema or domain rules, including unknown fields, aliases, invalid values, or duplicate query parameters, returns HTTP 422 validation_failed. Commit and pack-install lock deadlines return HTTP 423 commit_busy and pack_install_busy respectively. The unused commit_lock_timeout alias is removed.

**Rationale.** Stable code, status, and retryability are machine contracts. This classification distinguishes transport parsing from semantic validation and retains only codes actually emitted by bounded lock paths.

<a id="obj-dec-route-inventory"></a>

### Keep the public route inventory aligned with split Hono modules

The canonical route inventory includes current authorization authority/roles and expression help/validate endpoints. Route-source contract tests inspect app, auth, authorization, and project route modules together so split registration cannot hide current public routes.

**Rationale.** API-first clients require discoverable current routes and an inventory that follows actual composition.

<a id="obj-dec-optd-identity-matrix"></a>

### Use one complete optd identity before the first release

The canonical product and repository are optd and optd-ai/optd. The server executable is optd; optctl and /api/v1 remain unchanged. Runtime configuration uses OPTD_*; filesystem/XDG, PostgreSQL defaults and internal product-owned symbols/channels, Docker/Compose/Kubernetes resources, release ownership labels, source metadata, and image identity use optd. Built-in proof packs use publisher identities optd/crm and optd/projects. Old Operant spellings remain only where explicitly classified as historical evidence or adversarial rejected input; there are no runtime compatibility aliases. The canonical hosted repository is created new and public in optd-ai from the complete validated local Git history rather than transferred from an existing hosted repository. Active optd-ai administration and destination absence must be reverified immediately before creation.

**Rationale.** One pre-release identity avoids compatibility code and mixed branding while preserving stable API and CLI concepts.

**Related cross-domain objects**

- affects: [Use publisher/pack:name without aliases](packs-projects.md#obj-dec-qualified-identity)
- affects: [Build once and clean only exact proven release ownership](runtime-release.md#obj-dec-release-integrity)
- affects: [Use exactly external or app-managed PostgreSQL runtime modes](runtime-release.md#obj-dec-runtime-modes)
- supports: [Do not build development-era compatibility](packs-projects.md#obj-int-no-compat)

<a id="obj-dec-optd-license"></a>

### Release optd under Apache License 2.0

The optd source repository and first public release use Apache License 2.0. The repository includes the canonical LICENSE text and any required notices; generated artifacts and release metadata identify the license consistently.

**Rationale.** Apache-2.0 is permissive and includes an explicit patent grant appropriate for an operational platform engine.
