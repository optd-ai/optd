#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${OPERANT_PG_BIN_DIR:-}" || ! -x "${OPERANT_PG_BIN_DIR}/postgres" ]]; then
  detected="$(find /usr/lib/postgresql -mindepth 2 -maxdepth 2 -type f -name postgres 2>/dev/null | sort -V | tail -n 1 || true)"
  if [[ -n "${detected}" ]]; then
    export OPERANT_PG_BIN_DIR="$(dirname "${detected}")"
  fi
fi

export OPERANT_DATA_DIR="${OPERANT_DATA_DIR:-/data}"
mkdir -p "${OPERANT_DATA_DIR}"

case "${1:-server}" in
  server)
    exec deno run \
      --allow-read \
      --allow-write \
      --allow-env \
      --allow-net \
      --allow-run \
      src/main_server.ts
    ;;
  optctl)
    shift
    exec optctl "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
