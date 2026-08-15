<!-- generated-by: pi-dag-workflow/project-model; view: view-writes-actions; contract: 1; input: sha256:cfe01e4293c3630f3dde82658a9cc8a16a4be5fd5b22aec59cb1d20189656b69 -->

# Immutable writes, Actions, and approvals

Canonical immutable writes, actions, and approvals decisions and contracts projected from project-model/model.json.

## Concepts

<a id="obj-con-changeset-stage"></a>

### Changeset and immutable stage

An authored intention is normalized into an immutable staged operation graph plus dependencies, hook/policy evidence, messages, approvals, and digest; lifecycle facts remain separate.

<a id="obj-con-reviewed-target-effect"></a>

### Reviewed targets and effects

Semantic action reviewed targets are the sole permission targets. Effect manifests constrain emitted operations but never substitute for target permission.

## Scenarios

<a id="obj-scn-action-cutoff"></a>

### Reject a semantic action whose reviewed target authority changed

Action.stage produced valid effects but a target role/policy/ReBAC/object/lineage fact changes before persistence or commit. Stage persistence or commit revalidates the frozen evidence. The action is rejected with no partial facts and the hook is not rerun; permission on emitted effects cannot rescue it.

**Context.** Action.stage produced valid effects but a target role/policy/ReBAC/object/lineage fact changes before persistence or commit.

**Action.** Stage persistence or commit revalidates the frozen evidence.

**Expected outcome.** The action is rejected with no partial facts and the hook is not rerun; permission on emitted effects cannot rescue it.

## Decisions

<a id="obj-dec-immutable-stage"></a>

### Use immutable stage/inspect/commit and run hooks once

Staging validates and executes synchronous hooks once, persists the exact canonical graph/evidence, and returns inspect-equivalent output. Commit never reruns hooks. Duplicate stage creation is non-idempotent.

<a id="obj-dec-seven-operations"></a>

### Restrict writes to seven operation kinds

The authoring/runtime graph supports create, update, transition, archive, link, unlink, and comment. There is no direct CRUD bypass, unarchive, hard delete, or generic undo operation.

<a id="obj-dec-reviewed-target-authority"></a>

### Authorize semantic actions against frozen reviewed targets

Stage and commit authorize the exact ordered reviewed targets and complete cutoff facts. Effects only constrain output kinds/resources and are not permission targets.

<a id="obj-dec-field-null-contract"></a>

### Reject JSON null and clear optional fields with unset

V1 resource field values are never JSON null. In an update, omission leaves an existing field unchanged, set assigns a non-null value that validates against the declared type, and unset removes an optional value. Required fields cannot be unset.

**Rationale.** This preserves the already implemented explicit clear operation, avoids an undeclared nullable type system, and gives omission, assignment, and removal distinct canonical meanings.

<a id="obj-dec-action-read-schema"></a>

### Use strict input-derived Action reads

Each semantic Action read is a unique-name entry with exact resource, snake-case id_from matching $action.input.<field>, a nonempty unique fields projection, and explicit required boolean. Semantic Actions have no implicit $current or $proposed object, camelCase aliases are rejected, and arbitrary or chained reads remain deferred.

**Rationale.** This matches strict pack validation and frozen target/dependency authorization while avoiding undefined current-object semantics and compatibility aliases.

<a id="obj-dec-frozen-approval-revalidation"></a>

### Revalidate rather than recompute frozen approval requirements

Commit revalidates the exact staged approval requirements, current validity, decision authority, quorum, expiry, and stage binding without deriving a different requirement set or rerunning Hooks.

**Rationale.** Immutable staging requires commit to verify frozen evidence rather than rewrite reviewed requirements.

<a id="obj-dec-no-purge-v1"></a>

### Expose archive and compensation, not purge, in v1

Object/history hard purge is not an MVP API operation. Archive and compensating changesets preserve immutable history; any future purge requires an explicit provenance-preserving or tombstoning design.

**Rationale.** The public surface and immutable evidence model contain no purge operation.

## Commitments

<a id="obj-com-field-null"></a>

### Use non-null set values and explicit unset in v1

Resource field schema has no nullable type. Optional means a field may be absent; update omission leaves unchanged, unset removes an optional value, and explicit JSON null is rejected during canonical stage validation.

**Rationale.** This is the reviewed operational contract selected during conflict resolution.

<a id="obj-com-action-reads"></a>

### Use strict action reads keyed by id_from

Action reads are a unique-name map with exact resource, $action.input.<field> id_from, nonempty unique fields projection, and required boolean; unknown/camelCase variants are rejected.

**Rationale.** This is the reviewed Action-read contract selected during conflict resolution.

<a id="obj-com-stage-failure"></a>

### Persist no stage on validation or hook failure

Schema, reference, policy, secret, hook, output, or timeout failure returns a stable error and creates no stage or partial durable facts.

<a id="obj-com-commit-locks"></a>

### Revalidate under canonical PostgreSQL locks

Commit acquires canonical advisory/table/row locks, validates exact stage dependencies, Project/pack/object/authorization/approval facts, and writes all committed facts atomically. Busy/stale/conflict outcomes are stable and partial facts are forbidden.

<a id="obj-com-approval"></a>

### Keep approval requirements frozen and decisions append-only

Stage freezes canonical approval requirements. Distinct-principal decisions are append-only and commit revalidates requirement validity, authority, quorum, and expiry without rerunning hooks or deriving a different requirement set.
