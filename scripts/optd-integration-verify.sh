#!/usr/bin/env bash
# Prefix verification only. This does not establish image or release readiness.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if (( $# != 0 )); then
  echo 'Usage: bash scripts/optd-integration-verify.sh (prefix checks only)' >&2
  exit 2
fi
deno fmt --check src tests docs project-model deno.json
deno task model:check
deno task check
deno test -A tests/unit/optd_model_contract.test.ts tests/unit/optd_integration_verify.test.ts
deno task model:check
printf '%s\n' 'PREFIX CHECKS PASSED; image/release acceptance has not been run.'
