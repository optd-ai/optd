#!/usr/bin/env bash
set -euo pipefail

printf '\n== focused runtime/lifecycle ==\n'
deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys=uid \
  tests/unit/runtime_artifacts.test.ts tests/integration/postgres_lifecycle.test.ts

printf '\n== real container modes ==\n'
deno task container-smoke

printf '\n== typecheck, format, lint ==\n'
deno task check
# Frozen specifications are outside this release chunk; verify all owned code,
# tests, runtime docs, and task configuration without rewriting those files.
deno fmt --check src tests docs deno.json
mapfile -t changed_ts < <(
  { git diff --name-only -- '*.ts'; git ls-files --others --exclude-standard -- '*.ts'; } | sort -u
)
if ((${#changed_ts[@]})); then deno lint "${changed_ts[@]}"; fi

printf '\n== complete public, concurrency, migration, outbox, and regression suite ==\n'
deno task test

printf '\n== release legacy deployment scan ==\n'
if grep -REn 'path: /health|postgres:16|PGlite.*production|SQLite.*production' \
  Dockerfile docker-compose.yml compose.external-postgres.yml k8s docs/runtime.md; then
  echo 'legacy deployment contract found' >&2
  exit 1
fi

git diff --check
printf '\nrelease gate complete\n'
