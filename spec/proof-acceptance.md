<!-- generated-by: pi-dag-workflow/project-model; view: view-proof-acceptance; contract: 1; input: sha256:0afb1bbaa01aaf7759c04f7b79892520ae56c61530bef80f8181d460a8188aed -->

# Proof packs and acceptance

Canonical proof packs and acceptance decisions and contracts projected from project-model/model.json.

## Outcomes and intent

<a id="obj-int-real-e2e"></a>

### Require real-boundary acceptance

Unit/static checks codify contracts, but acceptance requires actual Hono, PostgreSQL, freshly compiled optctl, hooks, proof packs, containers, restart/recreation, and exact release identity.

<a id="obj-int-failure-evidence"></a>

### Treat validation failures as evidence

A later green run does not waive a prior failure; reproduce, explain, and directly repair defects or fixture gaps while preserving historical evidence.

## Scenarios

<a id="obj-scn-shared-flows"></a>

### Run identical complete proof flows in both adapters

Host and release-container harnesses are available. Register the shared public-flow matrix against each adapter. Both execute complete CRM and Projects semantics through public Hono/compiled-CLI boundaries with no copied or reduced container smoke.

**Context.** Host and release-container harnesses are available.

**Action.** Register the shared public-flow matrix against each adapter.

**Expected outcome.** Both execute complete CRM and Projects semantics through public Hono/compiled-CLI boundaries with no copied or reduced container smoke.

## Decisions

<a id="obj-dec-shared-public-flows"></a>

### Use the same complete proof-flow drivers on host and exact image

One immutable CRM/Projects driver matrix executes through real Hono, PostgreSQL, hooks, and freshly compiled or in-image optctl for both host and release-container adapters.

<a id="obj-dec-cli-test-registration"></a>

### Run current CLI contract tests in the default test task

tests/unit/cli_contract.test.ts is part of the default deno task test unit discovery and remains in typecheck and focused conformance coverage.

**Rationale.** The compiled CLI is a public boundary; excluding a current passing contract test from the default task creates silent drift.

<a id="obj-dec-axi-query-contract"></a>

### Use executable AXI list and field-search vocabulary

Resource AXI list uses defaultFields. optctl search requires --text and lowers exact equality OR predicates across declared AXI search fields into the ordinary permission-filtered query API; it is not semantic/vector/fuzzy/full-text search. Identities are publisher-qualified snake-case and archive help is named archived.

**Rationale.** This aligns examples and schema with the current compiled CLI and strict pack loader.

## Commitments

<a id="obj-com-proof-packs"></a>

### Keep CRM and Projects as ordinary strict proof packs

CRM exercises actions, approvals, secrets, outbox, and migration. Projects independently exercises generic resources, all seven operations, policy, direct ReBAC, and actions. Neither creates a platform product boundary.
