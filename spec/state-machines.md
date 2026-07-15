# State Machines

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

Lifecycle configuration does not directly name hooks; hooks attach themselves
to resource/phase and inspect the curated operation/current/proposed context.
There is no generic undo flag. Reversal requires an explicitly allowed reverse
transition or a compensating changeset.

## Frozen v1 boundaries

- Multiple independent machines per resource are deferred.
- A lifecycle transition mutates only its target object.
- Cross-object workflows are semantic actions whose `action.stage` hook emits
  the complete multi-object graph.
- State aliases and inferred transitions are forbidden.
