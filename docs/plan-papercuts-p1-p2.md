# P1/P2 papercuts remediation

Baseline: published v0.3.0 (`a0aebac`), Projects pack 0.2.0. Findings and
original reproduction evidence are in [the review](review-papercuts-v0.3.0.md).

## Accepted scope and decisions

- **N3:** Projects admins and managers gain scoped `read_archived` on Projects
  resources and the two task relationship definitions. Members/viewers do not.
- **N4:** All four Projects roles gain scoped `read`/`history.read` on
  `task_tag_assignment` and `task_milestone`. Relationship writes stay
  unchanged. Pack loading now accepts those existing read actions on
  relationship targets; other resource mutations and `where`/`relation` clauses
  remain rejected.
- **N5:** The physical query adapter translates invalid user expressions into
  the existing structured bad-request contract. It checks definition-level read
  grants before lowering the user expression, preserving hidden-definition
  behavior. Query help points to the supported expression subset.
- **A11:** Transition field input defaults to `{}` when omitted. Explicit
  invalid input still fails, create/update still require input, and normal
  validation, policy, staging and expected-version checks remain in force.
- **N6:** Add `blocked -> todo` in the lifecycle and validation hook, requiring
  atomic reason clearing. Direct `blocked -> done` already worked and remains
  covered. Completion guidance explains the existing completion action.
- **User decision:** `blocked_reason: ""` is the supported clearing value. Do
  not add nullable fields or accept explicit null. Improving discovery that null
  is unsupported is a **future update**, not part of this implementation.

## Upgrade contract

The modified Projects pack is **0.2.1**; the released 0.2.0 identity is
unchanged. Policy/lifecycle changes require the existing reviewed migration
path. No reset, seed auto-initialization, credential replacement or
historical-row rewrite is performed. CRM's version is unchanged. The shared
Projects acceptance fixture uses a later auxiliary version to exercise its
additional test definitions.

`tests/fixtures/projects-v0.2.0.tar.gz` freezes the complete released pack; see
its adjacent provenance document. The new isolated integration test applies it,
creates records and assignments through public CLI operations, then upgrades the
same database with the existing sessions. It checks:

- `--safe` cannot authorize the risky upgrade; `--reviewed` succeeds.
- Archived task ID/version/object-version/data/history are unchanged.
- Existing seeds remain present without automatic reconciliation.
- All four roles remain non-super-admin and retain their assignments.
- Both relationship definitions support scoped reads/history.
- Archive visibility remains denied to members/viewers.
- Cross-Workspace reads, unauthorized relationship mutations and reads after
  assignment revocation remain denied.
- Archived relationship pagination preserves the public envelope/cursor
  contract.
- Invalid filters report `/where` issues; valid equality works.
- Missing reason clearing, null values and stale versions remain rejected.
- Blocked-to-todo and blocked-to-done clear the reason in one transition.

## Verification status

- All unit tests plus focused onboarding/upgrade integrations: **311 passed, 0
  failed** (`/tmp/optd-papercuts-focused.log`).
- Shared host CRM/Projects matrix plus compiled query and pack-migration checks:
  **13 passed, 0 failed** (`/tmp/optd-papercuts-host.log`).
- `spec:check`: all 62 directly maintained specifications passed.
- Container acceptance and full exact-image gate: pending.
- No release publication or installation is authorized by this task.

The historical handoff remains unchanged as input evidence. This document
records implementation disposition; successful focused tests are not full
release acceptance.
