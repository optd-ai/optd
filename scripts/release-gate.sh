#!/usr/bin/env bash
set -euo pipefail

printf '\n== focused runtime/lifecycle ==\n'
deno test --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys=uid \
  tests/unit/runtime_artifacts.test.ts tests/integration/postgres_lifecycle.test.ts

printf '\n== real container modes ==\n'
release_image="operant:release-gate-$(git rev-parse --short HEAD)"
export OPERANT_CONTAINER_IMAGE="$release_image"
deno task container-smoke

printf '\n== compose and release artifact contracts ==\n'
OPERANT_POSTGRES_PASSWORD=compose-contract \
OPERANT_BOOTSTRAP_TOKEN=compose-contract \
OPERANT_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  docker compose -f compose.external-postgres.yml config --quiet
artifact_dir="$(mktemp -d -t operant-release-artifacts-XXXXXX)"
trap 'rm -rf "$artifact_dir"' EXIT
bash scripts/release-artifacts.sh "$release_image" "$artifact_dir"
jq -e --arg revision "$(git rev-parse HEAD)" \
  '.source_revision == $revision and .labels["org.opencontainers.image.revision"] == $revision and (.postgres | contains("18.4"))' \
  "$artifact_dir/image-metadata.json" >/dev/null
sha256sum --check "$artifact_dir/SHA256SUMS"

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

printf '\n== leaked container resource scan ==\n'
if docker ps -a --format '{{.Names}}' | grep -E '^operant-(cr|ext)-'; then
  echo 'container release gate leaked containers' >&2
  exit 1
fi
if docker volume ls --format '{{.Name}}' | grep -E '^operant-(cr|ext)-'; then
  echo 'container release gate leaked volumes' >&2
  exit 1
fi
printf '\nrelease gate complete\n'
