#!/usr/bin/env bash
# Verify the composed proposal, including its own exact-source image gate.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if (( $# != 0 )); then
  echo 'Usage: bash scripts/optd-integration-verify.sh' >&2
  exit 2
fi
deno fmt --check src tests docs project-model deno.json
deno task model:check
deno task check
deno test -A tests/unit/optd_model_contract.test.ts tests/unit/optd_integration_verify.test.ts tests/unit/optd_distribution.test.ts
deno test -A tests/e2e/foundation/compiled_cli_smoke.test.ts
deno test -A tests/e2e/full_crm/compiled_cli.test.ts
deno test -A tests/support/public_flows/equivalence.test.ts
deno task test
deno task model:check
bash scripts/optd-release-verify.sh
printf '%s\n' 'COMPOSED VERIFICATION PASSED, including the exact-source release gate.'
