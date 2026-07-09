# State Machines

## Summary

Object types may define lifecycle rules. The platform enforces allowed
transitions, required fields, permissions, and approvals automatically.

## Example

`todo -> doing -> blocked -> done`

A transition can require:

- Actor permissions.
- Object ownership.
- Required fields.
- Approval.
- Validation predicates.
- Side-effect events.
- Validation or transition scripts.

## State Machine Definition

A lifecycle spec should include:

- State keys and display names.
- Initial state.
- Terminal states.
- Allowed transitions.
- Required fields per state or transition.
- Transition-specific policy requirements.
- Approval requirements.
- Whether transition can be undone or superseded.
- Hook bindings for validation, derived changes, and after-commit behavior.

## Changeset Integration

State transitions are intentions inside changesets. They should be previewable
and revalidated at commit time. Transition hooks should receive the same
structured context used by changeset validation hooks.

## Open Questions

- Can objects have multiple independent state machines?
- Are state machines required for all object types? Assumed no.
- How are cross-object transitions represented, e.g. closing a project closes
  tasks?
