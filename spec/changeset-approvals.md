<!-- generated-by: pi-dag-workflow/project-model; view: view-exact-changeset-approvals; contract: 1; input: sha256:87f633a25584aa5c71626f972a54cb77bf8c0a41ac5b4a7110057fd9d107a644 -->

# Changeset Approval Contract

Generated exact-contract projection imported into project-model/model.json from the reviewed changeset-approvals.md source.

## Exact migrated contract

<a id="obj-com-exact-changeset-approvals-v1"></a>

### Exact v1 contract — Changeset Approval Contract

**Migration provenance.** Exact normative contract imported from `spec/changeset-approvals.md` at `sha256:d8a9b5c262e9a96e972c58e3a06a342ba528e331e09d148093435f298b9bb14c`. Text explicitly labeled historical, research, prototype evidence, or deferred remains non-normative; all other versioned requirements below preserve the imported contract semantics as updated by accepted project-model decisions.

## Decision

Approval requirements are frozen stage output. Decisions are append-only human
or agent facts; they never alter the immutable operation graph. Approval is not
a second hook phase and commit never reruns requirement-producing hooks.

## Requirement schema

A trusted stage hook may emit `required_approvals[]`:

```json
{
  "key": "manager_discount",
  "role": "optd/crm:sales_manager",
  "boundary": {
    "type": "project",
    "project_id": "019b7a2e-7c10-7000-8000-000000000001"
  },
  "minimum": 1,
  "principal_types": ["human_user"],
  "allow_initiator": false,
  "expires_at": null,
  "reason": "discount exceeds the manager threshold"
}
```

- `key`: lowercase snake-case, unique after hook chaining. Requirements with the
  same canonical content/key coalesce; same key with different content fails
  stage.
- `role`: one exact global role identity. Wildcards and permission expressions
  are forbidden.
- `boundary`: exactly one project/all-project/system boundary using the normal
  assignment schema. A project boundary must be one of the stage's affected
  projects.
- `minimum`: integer 1–10; default 1.
- `principal_types`: non-empty subset of `human_user|agent_user`; default is
  `[human_user]` so human review is explicit unless the pack says otherwise.
- `allow_initiator`: default false. When false, the principal that created the
  stage cannot satisfy the requirement, including through another credential.
- `expires_at`: optional RFC 3339 instant later than stage creation and within a
  configurable maximum approval window. Null means the requirement itself does
  not expire.
- `reason`: required safe text persisted/displayed to reviewers.

The server canonicalizes and assigns each requirement a UUIDv7. Approval
requirements participate in the immutable stage representation/digest but not
the operation-graph digest.

## Decision authority

The exact system action is `changeset.approval.decide`. To approve or reject, an
authenticated principal must:

1. be allowed that action for the stage/requirement boundary;
2. have the requirement's exact role currently effective in that boundary;
3. have an allowed principal type;
4. satisfy the initiator rule; and
5. act before requirement expiration.

`system:super_admin` may bypass policy/role possession but not authentication,
principal-type, initiator, expiration, structural, or audit rules.
Caller-supplied roles are never accepted.

One principal may record at most one decision per requirement. A decision is
immutable. A mistaken decision requires a new stage; there is no approval
revocation/update endpoint.

## State

- A stage with no requirements begins `ready`.
- A stage with requirements begins `awaiting_approval`.
- A requirement is satisfied by `minimum` distinct currently valid approving
  principals.
- Any valid rejection makes the stage `rejected` terminal.
- When all requirements are satisfied, lifecycle becomes `ready`.
- `rejected`, `cancelled`, and `committed` stages accept no new decisions.

Decision insertion and lifecycle projection update occur in one transaction
while locking `staged_changeset_lifecycle` first. Concurrent duplicate decisions
resolve through the unique `(requirement_id, principal_id)` constraint and
return the existing decision.

## Commit revalidation

Under the stage lifecycle lock, commit loads frozen requirements and decisions.
In its one authorization-cutoff SQL statement it verifies each approving
principal still exists/is active and still has the exact effective role in the
required boundary; agent approval also requires an active authorization chain.
It checks principal type, initiator, expiration, distinct quorum, and rejection.

A previously satisfied requirement that no longer satisfies returns
`approval_changed` and writes nothing. Pack/hook changes use normal
`stage_stale: pack_revision_changed`; commit does not derive new approval
requirements from current hook code.

## API and CLI

```text
GET  /api/v1/changesets/{stage_id}/approvals
POST /api/v1/changesets/{stage_id}/approvals/{requirement_id}/decide
```

Decision body:

```json
{
  "decision": "approve",
  "reason": "reviewed customer impact"
}
```

`reason` is optional for approval and required/non-empty for rejection.

```text
optctl changeset approvals <stage-id>
optctl changeset approve <stage-id> <requirement-id> [--reason ...]
optctl changeset reject <stage-id> <requirement-id> --reason ...
```

The decision response returns the complete current stage representation. It does
not automatically commit.
