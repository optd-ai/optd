#!/usr/bin/env bash
set -euo pipefail

# Frozen clean handoff for this release-hardening repair. Override only with an
# explicit, available ancestor when validating a different committed range.
readonly frozen_release_base="a6715631d48f2c6bf0c03326c909896ba9058164"
readonly repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "release gate requires a clean tracked and untracked source tree" >&2
  git status --short >&2
  exit 1
fi
readonly release_revision="$(git rev-parse --verify HEAD)"
readonly release_base="${OPERANT_RELEASE_BASE_REV:-$frozen_release_base}"
if ! git cat-file -e "${release_base}^{commit}" 2>/dev/null ||
  ! git merge-base --is-ancestor "$release_base" "$release_revision"; then
  printf 'release lint/check baseline is unavailable or not an ancestor: %s\n' \
    "$release_base" >&2
  exit 1
fi

state_dir="$(mktemp -d -t operant-release-gate-state-XXXXXX)"
artifact_dir="$(mktemp -d -t operant-release-artifacts-XXXXXX)"
release_image=""
release_image_id=""
image_built=false

snapshot_docker() {
  docker ps -aq --no-trunc | sort -u >"$1/containers"
  docker volume ls -q | sort -u >"$1/volumes"
  docker network ls -q --no-trunc | sort -u >"$1/networks"
}
snapshot_host() {
  : >"$1/processes.unsorted"
  for proc in /proc/[0-9]*; do
    [[ -r "$proc/cmdline" ]] || continue
    command_line="$(tr '\0' ' ' <"$proc/cmdline" 2>/dev/null)"
    if [[ "$command_line" == *"operant-server"* || "$command_line" =~ /tmp/(operant|container)- ]]; then
      printf '%s %s\n' "${proc##*/}" "$command_line" >>"$1/processes.unsorted"
    fi
  done
  sort -n "$1/processes.unsorted" >"$1/processes"
  rm -f "$1/processes.unsorted"
  find /tmp -mindepth 1 -maxdepth 1 -type d \
    \( -name 'operant-*' -o -name 'container-*' \) -print 2>/dev/null |
    sort -u >"$1/temp-dirs"
}
mkdir -p "$state_dir/before" "$state_dir/after"
snapshot_docker "$state_dir/before"
snapshot_host "$state_dir/before"
: >"$state_dir/owned-volumes"
: >"$state_dir/owned-networks"

is_owned_name() {
  [[ "$1" =~ ^/?operant-(cr|ext)- ]]
}
cleanup_and_compare() {
  local original_status=$?
  local cleanup_status=0
  trap - EXIT INT TERM
  set +e

  mkdir -p "$state_dir/current"
  snapshot_docker "$state_dir/current" || cleanup_status=1
  comm -13 "$state_dir/before/containers" "$state_dir/current/containers" >"$state_dir/new-containers"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    name="$(docker inspect "$id" --format '{{.Name}}' 2>/dev/null)"
    gate_label="$(docker inspect "$id" --format '{{index .Config.Labels "dev.operant.release-gate"}}' 2>/dev/null)"
    if is_owned_name "$name" || [[ "$gate_label" == "$release_revision" ]]; then
      docker inspect "$id" --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
        2>/dev/null >>"$state_dir/owned-volumes"
      docker inspect "$id" --format '{{range .NetworkSettings.Networks}}{{println .NetworkID}}{{end}}' \
        2>/dev/null >>"$state_dir/owned-networks"
      docker rm -f -v "$id" >/dev/null 2>&1 || cleanup_status=1
    fi
  done <"$state_dir/new-containers"

  snapshot_docker "$state_dir/current" || cleanup_status=1
  comm -13 "$state_dir/before/volumes" "$state_dir/current/volumes" >"$state_dir/new-volumes"
  sort -u -o "$state_dir/owned-volumes" "$state_dir/owned-volumes"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    if grep -Fxq "$id" "$state_dir/owned-volumes" || is_owned_name "$id"; then
      docker volume rm -f "$id" >/dev/null 2>&1 || cleanup_status=1
    fi
  done <"$state_dir/new-volumes"

  snapshot_docker "$state_dir/current" || cleanup_status=1
  comm -13 "$state_dir/before/networks" "$state_dir/current/networks" >"$state_dir/new-networks"
  sort -u -o "$state_dir/owned-networks" "$state_dir/owned-networks"
  while IFS= read -r id; do
    [[ -n "$id" ]] || continue
    name="$(docker network inspect "$id" --format '{{.Name}}' 2>/dev/null)"
    if grep -Fxq "$id" "$state_dir/owned-networks" || is_owned_name "$name"; then
      docker network rm "$id" >/dev/null 2>&1 || cleanup_status=1
    fi
  done <"$state_dir/new-networks"

  snapshot_host "$state_dir/current" || cleanup_status=1
  cut -d' ' -f1 "$state_dir/before/processes" | sort -n >"$state_dir/before-pids"
  cut -d' ' -f1 "$state_dir/current/processes" | sort -n >"$state_dir/current-pids"
  comm -13 "$state_dir/before-pids" "$state_dir/current-pids" >"$state_dir/new-pids"
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    command_line="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null)"
    if [[ "$command_line" == *"operant-server"* || "$command_line" =~ /tmp/(operant|container)- ]]; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done <"$state_dir/new-pids"
  sleep 1
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -KILL "$pid" 2>/dev/null || true
  done <"$state_dir/new-pids"

  snapshot_host "$state_dir/current" || cleanup_status=1
  comm -13 "$state_dir/before/temp-dirs" "$state_dir/current/temp-dirs" >"$state_dir/new-temp-dirs"
  while IFS= read -r path; do
    [[ "$path" =~ ^/tmp/(operant|container)-[^/]+$ ]] && rm -rf -- "$path"
  done <"$state_dir/new-temp-dirs"
  if [[ "$image_built" == true && "${OPERANT_RELEASE_KEEP_IMAGE:-0}" != "1" ]]; then
    docker image rm "$release_image_id" >/dev/null 2>&1 || cleanup_status=1
  fi

  snapshot_docker "$state_dir/after" || cleanup_status=1
  snapshot_host "$state_dir/after" || cleanup_status=1
  for kind in containers volumes networks processes temp-dirs; do
    if ! cmp -s "$state_dir/before/$kind" "$state_dir/after/$kind"; then
      printf 'release gate resource delta (%s):\n' "$kind" >&2
      diff -u "$state_dir/before/$kind" "$state_dir/after/$kind" >&2 || true
      cleanup_status=1
    fi
  done
  if docker ps -a --format '{{.Names}}' | grep -E '^operant-(cr|ext)-' >&2; then
    echo 'supplementary owned container scan found a leak' >&2
    cleanup_status=1
  fi
  if docker volume ls --format '{{.Name}}' | grep -E '^operant-(cr|ext)-' >&2; then
    echo 'supplementary owned volume scan found a leak' >&2
    cleanup_status=1
  fi
  if docker network ls --format '{{.Name}}' | grep -E '^operant-(cr|ext)-' >&2; then
    echo 'supplementary owned network scan found a leak' >&2
    cleanup_status=1
  fi

  rm -rf "$artifact_dir" "$state_dir"
  if ((original_status != 0)); then exit "$original_status"; fi
  exit "$cleanup_status"
}
trap cleanup_and_compare EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '\n== clean source identity ==\n'
printf 'source revision: %s\nrelease range: %s..%s\n' \
  "$release_revision" "$release_base" "$release_revision"

mapfile -t release_ts < <(
  git diff --name-only --diff-filter=ACMR "$release_base..$release_revision" -- '*.ts' |
    while IFS= read -r path; do [[ -f "$path" ]] && printf '%s\n' "$path"; done |
    sort -u
)
if ((${#release_ts[@]} == 0)); then
  echo 'release range selected no TypeScript files; refusing incomplete lint/check coverage' >&2
  exit 1
fi
printf 'effective committed TypeScript coverage (%d files):\n' "${#release_ts[@]}"
printf '  %s\n' "${release_ts[@]}"
printf 'COMMAND: deno lint -- <effective files above>\n'
deno lint -- "${release_ts[@]}"
printf 'COMMAND: deno check <effective files above>\n'
deno check "${release_ts[@]}"

printf '\n== typecheck and format ==\n'
printf 'COMMAND: deno task check\n'
deno task check
printf 'COMMAND: deno fmt --check src tests docs deno.json\n'
deno fmt --check src tests docs deno.json

printf '\n== exact one-time release image build ==\n'
release_version="release-gate-${release_revision:0:12}"
release_image="operant:${release_version}-$$"
printf 'COMMAND: docker build --pull=false --no-cache ... --tag %s .\n' "$release_image"
docker build --pull=false --no-cache \
  --label "dev.operant.release-gate=$release_revision" \
  --build-arg "OPERANT_REVISION=$release_revision" \
  --build-arg "OPERANT_VERSION=$release_version" \
  --tag "$release_image" .
image_built=true
release_image_id="$(docker image inspect "$release_image" --format '{{.Id}}')"
image_revision="$(docker image inspect "$release_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
image_version="$(docker image inspect "$release_image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
[[ -n "$release_image_id" && "$image_revision" == "$release_revision" && "$image_version" == "$release_version" ]] || {
  printf 'built image identity mismatch: id=%s revision=%s version=%s\n' \
    "$release_image_id" "$image_revision" "$image_version" >&2
  exit 1
}
export OPERANT_CONTAINER_IMAGE="$release_image"
export OPERANT_CONTAINER_IMAGE_ID="$release_image_id"
export OPERANT_CONTAINER_REVISION="$release_revision"
export OPERANT_CONTAINER_VERSION="$release_version"
export OPERANT_CONTAINER_SKIP_BUILD=1
export OPERANT_RELEASE_GATE_ID="$release_revision"
printf 'exact image: %s\nexact image ID: %s\ncontainer build mode: skip-build/reuse\n' \
  "$OPERANT_CONTAINER_IMAGE" "$OPERANT_CONTAINER_IMAGE_ID"

printf '\n== Compose and release artifact contracts ==\n'
OPERANT_POSTGRES_PASSWORD=compose-contract \
OPERANT_BOOTSTRAP_TOKEN=compose-contract \
OPERANT_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  docker compose -f compose.external-postgres.yml config --quiet
bash scripts/release-artifacts.sh "$release_image" "$artifact_dir"
jq -e --arg revision "$release_revision" --arg image_id "$release_image_id" --arg version "$release_version" \
  '.source_dirty == false and .source_revision == $revision and .image_id == $image_id and .labels["org.opencontainers.image.revision"] == $revision and .labels["org.opencontainers.image.version"] == $version and (.postgres | contains("18.4"))' \
  "$artifact_dir/image-metadata.json" >/dev/null
(cd "$artifact_dir" && sha256sum --check SHA256SUMS)

printf '\n== complete real-PG and exact-image container suite ==\n'
printf 'COMMAND: OPERANT_CONTAINER_SKIP_BUILD=1 deno task test\n'
deno task test

printf '\n== post-suite exact image identity ==\n'
[[ "$(docker image inspect "$release_image" --format '{{.Id}}')" == "$release_image_id" ]]
[[ "$(docker image inspect "$release_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$release_revision" ]]

printf '\n== release legacy deployment scan and diff check ==\n'
if grep -REn 'path: /health|postgres:16|PGlite.*production|SQLite.*production' \
  Dockerfile docker-compose.yml compose.external-postgres.yml k8s docs/runtime.md; then
  echo 'legacy deployment contract found' >&2
  exit 1
fi
git diff --check

printf '\nrelease gate complete; exact image is removed on EXIT (set OPERANT_RELEASE_KEEP_IMAGE=1 to retain it)\n'
