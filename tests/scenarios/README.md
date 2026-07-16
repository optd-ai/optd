# Legacy pre-next-version scenarios

The numbered scenarios in this directory predate the frozen next-version
contracts. They remain historical executable inputs, but scenarios that require
the removed namespace/dotted pack model, `/packs/apply` upload, mutable
changeset preview, or caller-selected object IDs remain registered in
`deno task test` as explicitly ignored historical cases. They must not drive
compatibility code; their source still receives the static `deno task check`
gate.

Current replacements and ownership:

| Legacy scenario                                                                                                                                      | Default-gate replacement / disposition                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `01_pack_preview_apply_crm.ts`                                                                                                                       | Strict preview behavior is replaced by `tests/e2e/pack_preview/strict_preview.test.ts` and `tests/integration/pack_plan_persistence.test.ts`. Atomic apply moves to the dependent atomic-pack-apply slice.                                                                                              |
| `05_pack_migration.ts`                                                                                                                               | Strict diff/plan evidence is replaced by `tests/unit/pack_migration.test.ts`, `tests/integration/pack_plan_persistence.test.ts`, and the compiled-CLI strict preview scenario. Apply/confirmation execution moves to atomic-pack-apply.                                                                 |
| `02_changeset_crm_lead_flow.ts`, `03_query_policy_pagination.ts`, `04_action_hooks_outbox.ts`, `06_project_management_pack.ts`, `99_full_crm_e2e.ts` | These require an activated legacy pack and superseded public DTOs. Their next-version public behavior belongs to the later object/query/stage/hooks/outbox/public-acceptance slices after atomic activation exists. The files are retained here rather than weakened or pointed at historical fixtures. |
| `00_bootstrap.ts`, `00_postgres_bootstrap.ts`, `06_secrets_encryption.ts`                                                                            | Contract-current and still executed by the default gate.                                                                                                                                                                                                                                                |

The pre-next-version `tests/unit/cli_contract.test.ts` matrix is also excluded
from the default runtime test discovery because it asserts removed `pack apply`,
mutable migration apply/confirm, dotted metadata, and legacy action/change-set
commands as one indivisible table. Current CLI routing remains covered by
focused contract tests and compiled-binary E2E; each deferred command group
returns to the default gate with its owning next-version slice.

`tests/fixtures/packs/**` remains unchanged as historical regression input.
Strict acceptance uses the owned proof packs under `prototypes/`.
