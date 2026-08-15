<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-state-machines; contract: 1; input: sha256:f14f7d265848dba8469bad6d2cfdc5314e7f435848a5d7d37f4ea6d56322d639 -->

# State Machines

Generated exact-contract projection imported into project-model/model.json from the reviewed state-machines.md source.

## Exact migrated contract

<a id="obj-com-exact-state-machines-v1"></a>

### Exact v1 contract — State Machines

**Migration provenance.** Exact normative contract imported from `spec/state-machines.md` at `sha256:746fe79ad8db6c42a7420ed6e9b345dfd6abb6f59cc9e4c29eea2dd280ca83c9`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below are preserved literally.

## Decision

A pack resource may have at most one separate `Lifecycle` definition using the
strict shape in `pack-definition-schemas.md`. Lifecycles are optional; packs use
ordinary validated fields for orthogonal status dimensions.

A lifecycle names one required string field, initial state, states/terminal
flags/required fields, and allowed named transitions with optional CEL condition
and constant `set`/`unset`. Unsupported inline policy, approval, hook, event, or
undo subdocuments are rejected.

## Enforcement

A `transition` changeset operation is staged/committed like every other write:

1. current state and expected object version are dependencies;
2. transition edge/CEL condition and final required fields are validated;
3. exact `transition` policy is evaluated;
4. matching `changeset.before_stage`/`changeset.validate` Hook attachments may
   normalize, reject, warn, or require approval through their standard schemas;
5. commit revalidates current version/lifecycle revision/authorization/approval
   without rerunning hooks; and
6. the committed engine event describes the transition.

Lifecycle configuration does not directly name hooks; hooks attach themselves to
resource/phase and inspect the curated operation/current/proposed context. There
is no generic undo flag. Reversal requires an explicitly allowed reverse
transition or a compensating changeset.

## Frozen v1 boundaries

- Multiple independent machines per resource are deferred.
- A lifecycle transition mutates only its target object.
- Cross-object workflows are semantic actions whose `action.stage` hook emits
  the complete multi-object graph.
- State aliases and inferred transitions are forbidden.
