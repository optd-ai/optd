#!/usr/bin/env bash
set -euo pipefail

export OPTD_DATA_DIR="${OPTD_DATA_DIR:-/data}"
export DENO_DIR="${DENO_DIR:-${OPTD_DATA_DIR}/deno}"
mkdir -p "${OPTD_DATA_DIR}" "${DENO_DIR}"

case "${1:-server}" in
  server)
    shift || true
    exec /usr/local/bin/optd "$@"
    ;;
  optctl)
    shift
    exec /usr/local/bin/optctl "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
