#!/usr/bin/env bash
set -euo pipefail

export OPERANT_DATA_DIR="${OPERANT_DATA_DIR:-/data}"
export DENO_DIR="${DENO_DIR:-${OPERANT_DATA_DIR}/deno}"
mkdir -p "${OPERANT_DATA_DIR}" "${DENO_DIR}"

case "${1:-server}" in
  server)
    shift || true
    exec /usr/local/bin/operant-server "$@"
    ;;
  optctl)
    shift
    exec /usr/local/bin/optctl "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
