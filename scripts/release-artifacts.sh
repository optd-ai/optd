#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: release-artifacts.sh IMAGE [OUTPUT_DIR]}"
out="${2:-dist}"

if [[ -n "$(git status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "release artifacts require a clean tracked and untracked source tree" >&2
  exit 1
fi

revision="$(git rev-parse --verify HEAD)"
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
image_revision="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
image_version="$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')"
if [[ -z "$image_revision" || "$image_revision" == "<no value>" || "$image_revision" != "$revision" ]]; then
  printf 'release image/source revision mismatch: source=%s image=%s\n' \
    "$revision" "${image_revision:-missing}" >&2
  exit 1
fi
if [[ -n "${OPERANT_CONTAINER_IMAGE_ID:-}" && "$image_id" != "$OPERANT_CONTAINER_IMAGE_ID" ]]; then
  printf 'release image ID mismatch: expected=%s actual=%s\n' \
    "$OPERANT_CONTAINER_IMAGE_ID" "$image_id" >&2
  exit 1
fi
if [[ -n "${OPERANT_CONTAINER_VERSION:-}" && "$image_version" != "$OPERANT_CONTAINER_VERSION" ]]; then
  printf 'release image version mismatch: expected=%s actual=%s\n' \
    "$OPERANT_CONTAINER_VERSION" "$image_version" >&2
  exit 1
fi

parent="$(dirname "$out")"
name="$(basename "$out")"
mkdir -p "$parent"
staging="$(mktemp -d "$parent/.${name}.staging.XXXXXX")"
backup=""
container_id=""
committed=false
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$container_id" ]]; then
    docker rm -f -v "$container_id" >/dev/null 2>&1 || true
  fi
  rm -rf "$staging"
  if [[ "$committed" != true && -n "$backup" && -e "$backup" && ! -e "$out" ]]; then
    mv "$backup" "$out" || status=1
  fi
  [[ -z "$backup" || ! -e "$backup" ]] || rm -rf "$backup"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

deno compile --frozen --no-prompt \
  --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys=uid \
  --output "$staging/optctl" src/main_optctl.ts

container_id="$(docker create --entrypoint /bin/true "$image")"
labels="$(docker image inspect "$image" --format '{{json .Config.Labels}}')"
image_digest="$(docker image inspect "$image" --format '{{join .RepoDigests ","}}')"
deno_output="$(docker run --rm --entrypoint deno "$image" --version)"
deno_version="${deno_output%%$'\n'*}"
postgres_version="$(docker run --rm --entrypoint /usr/lib/postgresql/18/bin/postgres "$image" --version)"
docker rm -f -v "$container_id" >/dev/null
container_id=""

optctl_sha256="$(sha256sum "$staging/optctl" | awk '{print $1}')"
jq -n \
  --arg image "$image" \
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
  sha256sum optctl image-metadata.json >SHA256SUMS
  sha256sum --check SHA256SUMS
)

if [[ -e "$out" ]]; then
  backup="$(mktemp -d "$parent/.${name}.backup.XXXXXX")"
  rmdir "$backup"
  mv "$out" "$backup"
fi
if ! mv "$staging" "$out"; then
  [[ -z "$backup" || ! -e "$backup" ]] || mv "$backup" "$out"
  exit 1
fi
staging="$parent/.${name}.committed"
committed=true
if [[ -n "$backup" ]]; then
  rm -rf "$backup"
  backup=""
fi
trap - EXIT INT TERM
