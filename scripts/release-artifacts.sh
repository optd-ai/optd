#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: release-artifacts.sh IMAGE [OUTPUT_DIR]}"
out="${2:-dist}"
mkdir -p "$out"

deno task compile:optctl
if [[ "$out" != "dist" ]]; then
  cp dist/optctl "$out/optctl"
fi
sha256sum "$out/optctl" >"$out/SHA256SUMS"

revision="$(git rev-parse HEAD)"
source_dirty=false
if [[ -n "$(git status --short)" ]]; then source_dirty=true; fi

image_id="$(docker image inspect "$image" --format '{{.Id}}')"
image_digest="$(docker image inspect "$image" --format '{{join .RepoDigests ","}}')"
labels="$(docker image inspect "$image" --format '{{json .Config.Labels}}')"
deno_version="$(docker run --rm --entrypoint deno "$image" --version | head -n1)"
postgres_version="$(docker run --rm --entrypoint /usr/lib/postgresql/18/bin/postgres "$image" --version)"
optctl_sha256="$(cut -d' ' -f1 "$out/SHA256SUMS")"

jq -n \
  --arg image "$image" \
  --arg image_id "$image_id" \
  --arg image_digest "$image_digest" \
  --arg revision "$revision" \
  --argjson source_dirty "$source_dirty" \
  --argjson labels "$labels" \
  --arg deno_version "$deno_version" \
  --arg postgres_version "$postgres_version" \
  --arg optctl_sha256 "$optctl_sha256" \
  '{image:$image,image_id:$image_id,image_digest:$image_digest,source_revision:$revision,source_dirty:$source_dirty,labels:$labels,deno:$deno_version,postgres:$postgres_version,optctl_sha256:$optctl_sha256}' \
  >"$out/image-metadata.json"
sha256sum "$out/image-metadata.json" >>"$out/SHA256SUMS"
