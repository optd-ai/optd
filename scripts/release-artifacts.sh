#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: release-artifacts.sh IMMUTABLE_IMAGE_ID [OUTPUT_DIR]}
out=${2:-dist}
gate_label_key="dev.operant.release-gate"
gate_id=${OPERANT_RELEASE_GATE_ID:-}
registry=${OPERANT_RELEASE_GATE_REGISTRY:-}
revision=""
image_id=""
parent=""
parent_real=""
parent_identity=""
name=""
staging=""
backup=""
failed_publication=""
committed=false
cleanup_active=false
container_sequence=0
containers=()

fail() {
  printf 'release artifacts: %s\n' "$*" >&2
  exit 1
}

reject_symlink_components() {
  local candidate=$1
  local absolute component current=""
  absolute=$(realpath -m -s -- "$candidate")
  if [[ "$candidate" == /* ]]; then
    current=/
  else
    current=$PWD
  fi
  IFS='/' read -r -a components <<<"${absolute#/}"
  current=/
  for component in "${components[@]}"; do
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ -L "$current" ]]; then
      fail "symlink path component is forbidden: $current"
    fi
  done
}

verify_parent_identity() {
  local current
  current=$(stat -Lc '%d:%i:%f:%u' -- "$parent_real") || return 1
  [[ "$current" == "$parent_identity" ]]
}

sync_path() {
  sync -f -- "$1"
}

append_registry() {
  local kind=$1
  local identity=$2
  local resource_name=${3:-}
  [[ -n "$registry" && -d "$registry" ]] || return 0
  printf '%s\t%s\n' "$identity" "$resource_name" >>"$registry/$kind"
  sync -f "$registry/$kind"
}

remove_container() {
  local id=$1
  local label
  [[ -n "$id" ]] || return 0
  if [[ -n "$gate_id" ]]; then
    label=$(docker container inspect "$id" --format "{{index .Config.Labels \"$gate_label_key\"}}") || return 1
    [[ "$label" == "$gate_id" ]] || return 1
  fi
  docker container rm --force --volumes "$id" >/dev/null
}

run_image_command() {
  local entrypoint=$1
  shift
  local container_name="operant-artifact-${gate_id:-standalone}-$$-$container_sequence"
  container_sequence=$((container_sequence + 1))
  local -a label_args=()
  [[ -z "$gate_id" ]] || label_args=(--label "$gate_label_key=$gate_id")
  local id
  append_registry containers "pending:$container_name" "$container_name"
  id=$(docker container create --name "$container_name" "${label_args[@]}" --entrypoint "$entrypoint" "$image_id" "$@")
  containers+=("$id")
  append_registry containers "$id" "$container_name"
  local status=0
  docker container start --attach "$id" || status=$?
  if ! remove_container "$id"; then
    ((status == 0)) && status=1
  fi
  containers=("${containers[@]:1}")
  return "$status"
}

cleanup() {
  local primary_status=$?
  local cleanup_status=0
  if [[ "$cleanup_active" == true ]]; then
    return
  fi
  cleanup_active=true
  trap - EXIT INT TERM HUP
  set +e

  local id
  for id in "${containers[@]}"; do
    remove_container "$id" || cleanup_status=1
  done

  if [[ "$committed" != true && -n "$parent_real" ]]; then
    if [[ -d "$parent_real" ]] && ! verify_parent_identity; then
      printf 'release artifacts: output parent identity changed during rollback\n' >&2
      cleanup_status=1
    else
      if [[ -n "$out" && -e "$out" ]]; then
        failed_publication=$(mktemp -d "$parent_real/.${name}.failed.XXXXXX") || cleanup_status=1
        if [[ -n "$failed_publication" ]]; then
          rmdir -- "$failed_publication" || cleanup_status=1
          mv -- "$out" "$failed_publication" || cleanup_status=1
        fi
      fi
      if [[ -n "$backup" && -e "$backup" ]]; then
        mv -- "$backup" "$out" || cleanup_status=1
        sync_path "$parent_real" || cleanup_status=1
        backup=""
      fi
      [[ -z "$failed_publication" || ! -e "$failed_publication" ]] || rm -rf -- "$failed_publication" || cleanup_status=1
    fi
  fi

  [[ -z "$staging" || ! -e "$staging" ]] || rm -rf -- "$staging" || cleanup_status=1
  if [[ -n "$backup" && -e "$backup" ]]; then
    if [[ "$committed" == true ]]; then
      rm -rf -- "$backup" || cleanup_status=1
    else
      printf 'release artifacts: retained prior-output backup after unsafe rollback: %s\n' "$backup" >&2
      cleanup_status=1
    fi
  fi

  if ((primary_status != 0)); then
    ((cleanup_status == 0)) || printf 'release artifacts: rollback also failed while preserving primary status %s\n' "$primary_status" >&2
    exit "$primary_status"
  fi
  exit "$cleanup_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

if [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  fail "an immutable full image ID is required, not a mutable tag: $image"
fi
if ! source_status=$(git status --porcelain=v1 --untracked-files=all); then
  fail "could not verify source cleanliness"
fi
if [[ -n "$source_status" ]]; then
  fail "requires a clean tracked and untracked source tree"
fi
revision=$(git rev-parse --verify 'HEAD^{commit}')
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || fail "source HEAD is not an exact commit"
if [[ -n "${OPERANT_RELEASE_SOURCE_REVISION:-}" && "$revision" != "$OPERANT_RELEASE_SOURCE_REVISION" ]]; then
  fail "source revision changed: expected=$OPERANT_RELEASE_SOURCE_REVISION actual=$revision"
fi
image_id=$(docker image inspect "$image" --format '{{.Id}}')
[[ "$image_id" == "$image" ]] || fail "image ID did not resolve exactly: expected=$image actual=$image_id"
image_revision=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
image_version=$(docker image inspect "$image_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
if [[ -z "$image_revision" || "$image_revision" == "<no value>" || "$image_revision" != "$revision" ]]; then
  fail "image/source revision mismatch: source=$revision image=${image_revision:-missing}"
fi
if [[ -n "${OPERANT_CONTAINER_IMAGE_ID:-}" && "$image_id" != "$OPERANT_CONTAINER_IMAGE_ID" ]]; then
  fail "image ID mismatch: expected=$OPERANT_CONTAINER_IMAGE_ID actual=$image_id"
fi
if [[ -n "${OPERANT_CONTAINER_VERSION:-}" && "$image_version" != "$OPERANT_CONTAINER_VERSION" ]]; then
  fail "image version mismatch: expected=$OPERANT_CONTAINER_VERSION actual=$image_version"
fi

parent=$(dirname -- "$out")
name=$(basename -- "$out")
[[ "$name" != . && "$name" != .. && "$name" != */* ]] || fail "invalid output directory name"
reject_symlink_components "$parent"
mkdir -p -- "$parent"
reject_symlink_components "$parent"
parent_real=$(realpath -e -- "$parent")
[[ -d "$parent_real" && ! -L "$parent_real" ]] || fail "output parent must be a real directory"
if [[ -e "$out" || -L "$out" ]]; then
  [[ ! -L "$out" ]] || fail "output directory must not be a symlink"
  [[ -d "$out" ]] || fail "existing output must be a directory"
fi
parent_identity=$(stat -Lc '%d:%i:%f:%u' -- "$parent_real")
verify_parent_identity || fail "output parent identity was not stable"
staging=$(mktemp -d "$parent_real/.${name}.staging.XXXXXX")
chmod 0700 -- "$staging"
sync_path "$parent_real"

# Compile only from the already validated detached exact-HEAD source. The gate
# revalidates every tracked byte immediately after this script returns.
deno compile --frozen --no-prompt \
  --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys=uid \
  --output "$staging/optctl" src/main_optctl.ts

labels=$(docker image inspect "$image_id" --format '{{json .Config.Labels}}')
image_digest=$(docker image inspect "$image_id" --format '{{join .RepoDigests ","}}')
deno_output=$(run_image_command deno --version)
deno_version=${deno_output%%$'\n'*}
postgres_version=$(run_image_command /usr/lib/postgresql/18/bin/postgres --version)

optctl_sha256=$(sha256sum -- "$staging/optctl" | awk '{print $1}')
jq -n \
  --arg image "$image_id" \
  --arg image_id "$image_id" \
  --arg image_digest "$image_digest" \
  --arg revision "$revision" \
  --argjson labels "$labels" \
  --arg deno_version "$deno_version" \
  --arg postgres_version "$postgres_version" \
  --arg optctl_sha256 "$optctl_sha256" \
  '{image:$image,image_id:$image_id,image_digest:$image_digest,source_revision:$revision,source_dirty:false,labels:$labels,deno:$deno_version,postgres:$postgres_version,optctl_sha256:$optctl_sha256}' \
  >"$staging/image-metadata.json"
(
  cd "$staging"
  sha256sum -- optctl image-metadata.json >SHA256SUMS
  sha256sum --check SHA256SUMS
)
for artifact in optctl image-metadata.json SHA256SUMS; do sync_path "$staging/$artifact"; done
sync_path "$staging"
verify_parent_identity || fail "output parent identity changed before publication"

if [[ -e "$out" ]]; then
  backup=$(mktemp -d "$parent_real/.${name}.backup.XXXXXX")
  rmdir -- "$backup"
  verify_parent_identity || fail "output parent identity changed before backup rename"
  mv -- "$out" "$backup"
  sync_path "$parent_real"
fi
verify_parent_identity || fail "output parent identity changed before publication rename"
mv -- "$staging" "$out"
staging=""

# This deliberately remains before commit. A signal delivered immediately
# after the publication rename therefore runs EXIT rollback and restores the
# prior output (or removes a first publication).
if [[ -n "${OPERANT_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE:-}" ]]; then
  : >"$OPERANT_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE"
  sync_path "$OPERANT_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE"
  while [[ -e "$OPERANT_RELEASE_ARTIFACT_AFTER_PUBLISH_FILE" ]]; do sleep 0.01; done
fi

sync_path "$out"
verify_parent_identity || fail "output parent identity changed after publication rename"
sync_path "$parent_real"
# The durable parent sync is the transaction's final commit point. Ignore new
# termination signals only for the non-rollbackable backup discard that follows.
trap '' INT TERM HUP
committed=true
if [[ -n "$backup" ]]; then
  rm -rf -- "$backup"
  backup=""
  sync_path "$parent_real"
fi
trap - EXIT INT TERM HUP
