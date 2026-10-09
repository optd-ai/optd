#!/usr/bin/env bash
# Export the already-tested image; consumers must also require gate exit zero.
set -euo pipefail
image=${1:?immutable image ID required}
artifacts=${2:?artifact directory required}
out=${3:?new export directory required}
[[ "$image" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
[[ "$out" == /* && ! -e "$out" && ! -L "$out" ]] || exit 1
# Never overwrite an existing export. Failed exports are retained for diagnosis.
mkdir -- "$out"
cp -- "$artifacts/optctl" "$artifacts/LICENSE" "$artifacts/NOTICE" \
  "$artifacts/image-metadata.json" "$out/"
printf '%s\n' "$image" > "$out/image-id.txt"
docker image save --output "$out/image.tar" "$image"
(cd "$out" && sha256sum optctl LICENSE NOTICE image-metadata.json image-id.txt image.tar > SHA256SUMS)
