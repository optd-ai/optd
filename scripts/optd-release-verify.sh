#!/usr/bin/env bash
# Always build and test the clean composed HEAD; never consume candidate receipts.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if (( $# != 0 )); then
  echo 'Usage: bash scripts/optd-release-verify.sh' >&2
  exit 2
fi
readonly base=0b44cc6a07b5328e63a77bb888031b5b6ab311cc
# Caller image/skip settings cannot stand in for this invocation's build.
for name in OPTD_CONTAINER_SKIP_BUILD OPTD_CONTAINER_IMAGE OPTD_CONTAINER_IMAGE_ID OPTD_CONTAINER_IMAGE_TAG OPTD_CONTAINER_REVISION OPTD_CONTAINER_VERSION OPTD_RELEASE_GATE_ACTIVE OPTD_RELEASE_BASE OPTD_RELEASE_BASE_REV; do
  if [[ -n "${!name:-}" ]]; then
    printf 'exact-image verifier rejects caller override: %s\n' "$name" >&2
    exit 2
  fi
done
export OPTD_RELEASE_BASE="$base"
exec bash scripts/release-gate.sh
