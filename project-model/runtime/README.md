# Read-only model validation runtime

`deno task model:check` validates the current repository authority and compares
all 62 declared spec projections byte-for-byte. It never writes the model or
specs, accepts no generation mode, and needs only read permission. Validation
failure, missing/changed output, stale generated Markdown, unsafe paths, and
symlinks fail closed. This checks consistency, not user authorization or release
readiness.

## Audit basis

The retained `2f749e5 -> ef65f23 -> 570b807` lineage was inspected as evidence,
not transplanted. Its runtime predates the installed schema's treatment of
historical acceptance receipts and current-understanding source hashes. Those
records are historical evidence, not mandatory current-content attestations. The
dependent identity repairs in `ef65f23` and revision metadata in `570b807`
likewise do not replace the parent's reconciled revision 26 authority.

This runtime is a read-only subset of the installed
`pi-dag-workflow/extensions/dag-workflow/project-model` implementation inspected
on 2026-09-30. Upstream file SHA-256 identities at inspection:

- `model.ts`: `60561ef9a8f75ae00e8f70b016917ec42650d5723035850ac58ed1ab6cb081f8`
- `projector.ts`:
  `5f86496cb2994cacb6ede15fa3dfe063283f57dd69cf047086e74d0fc4b74d9f`
- `types.ts`: `43a9b3a8ece6d7bf73b6d20602fe784acd93e8adafd212c1885517ca584ddd8e`
- `reviews.ts`:
  `7aaf001abe55e9a65ed8299253dcaadb5fb452d89f8724abefcc3134930377b9`

Local changes remove generation/preview, model creation, ID allocation,
unrelated hash/report APIs, and review lookup. Stale-file traversal rejects
symlinks and propagates filesystem errors instead of suppressing them. Rendering
contract v1, structural/reference validation, governing-state projection
eligibility, and historical-record validation remain compatible. No installed
extension is loaded at execution time; no runner, store, or model operation API
is included.

Tests compare fresh deterministic rendering with the frozen projections,
exercise malformed references and deliberately stale outputs, preserve all
authority bytes, and check canonical dependent identities alongside the newer
no-transfer/public repository, DNS, deferred, and effect-boundary text.
Historical records are not rewritten to make old tooling pass.

## Prefix verifier

`bash scripts/optd-integration-verify.sh` runs no-edit formatting, model checks,
application type checks, and the two focused regression suites, followed by a
second model check. Every failed command terminates the wrapper. Regression
tests execute real Deno processes against isolated fixtures, including genuine
model, formatting, type, and test failures. Fixture success is not application
acceptance.

This wrapper is deliberately **prefix-only**. It does not run an image gate,
validate external readiness, or claim release PASS. Later image acceptance must
extend it with an actual gate, not a declared-command receipt.
