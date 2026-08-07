#!/usr/bin/env bash
set -euo pipefail

readonly frozen_release_base="a6715631d48f2c6bf0c03326c909896ba9058164"
readonly gate_label_key="dev.operant.release-gate"
repo_root=""
release_revision=""
release_base=""
run_id=""
state_root=""
source_root=""
source_archive=""
source_archive_sha256=""
artifact_dir=""
release_image_tag=""
release_image_id=""
image_built=false
baseline_ready=false
cleanup_active=false

status_message() {
  printf 'release gate: %s\n' "$*" >&2
}

atomic_sorted_command() {
  local output=$1
  shift
  local raw="${output}.raw.$$"
  local sorted="${output}.new.$$"
  rm -f -- "$raw" "$sorted"
  if ! "$@" >"$raw"; then
    rm -f -- "$raw" "$sorted"
    return 1
  fi
  if ! LC_ALL=C sort -u -- "$raw" >"$sorted"; then
    rm -f -- "$raw" "$sorted"
    return 1
  fi
  if ! mv -f -- "$sorted" "$output"; then
    rm -f -- "$raw" "$sorted"
    return 1
  fi
  rm -f -- "$raw"
}

snapshot_docker() {
  local destination=$1
  mkdir -p -- "$destination" || return 1
  atomic_sorted_command "$destination/images" docker image ls --no-trunc --quiet || return 1
  atomic_sorted_command "$destination/containers" docker container ls --all --no-trunc --quiet || return 1
  atomic_sorted_command "$destination/volumes" docker volume ls --quiet || return 1
  atomic_sorted_command "$destination/networks" docker network ls --no-trunc --quiet || return 1
}

snapshot_host() {
  local destination=$1
  mkdir -p -- "$destination" || return 1
  python3 - "$destination" "$state_root" <<'PY'
import base64
import json
import os
import pathlib
import tempfile
import sys

out = pathlib.Path(sys.argv[1])
state_root = os.fsencode(sys.argv[2])
boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
self_pid = os.getpid()
processes = []
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit() or int(entry.name) == self_pid:
        continue
    try:
        stat = (entry / 'stat').read_text()
        end = stat.rfind(') ')
        fields = stat[end + 2:].split()
        status = (entry / 'status').read_text().splitlines()
        uid = next(line.split()[1] for line in status if line.startswith('Uid:'))
        processes.append({
            'boot_id': boot,
            'pid': int(entry.name),
            'ppid': int(fields[1]),
            'start_ticks': fields[19],
            'uid': uid,
            'exe': os.readlink(entry / 'exe'),
            'cwd': os.readlink(entry / 'cwd'),
            'cmdline_b64': base64.b64encode((entry / 'cmdline').read_bytes()).decode(),
        })
    except (FileNotFoundError, PermissionError, ProcessLookupError, StopIteration, OSError, ValueError):
        continue
processes.sort(key=lambda item: item['pid'])

temps = []
for parent in (b'/tmp', b'/var/tmp'):
    try:
        names = os.listdir(parent)
    except FileNotFoundError:
        continue
    for name in names:
        path = os.path.join(parent, name)
        try:
            st = os.lstat(path)
        except FileNotFoundError:
            continue
        temps.append({
            'path_b64': base64.b64encode(path).decode(),
            'device': st.st_dev,
            'inode': st.st_ino,
            'mode': st.st_mode,
            'uid': st.st_uid,
        })
temps.sort(key=lambda item: item['path_b64'])

for name, value in [('processes', processes), ('temp-dirs', temps)]:
    fd, temporary = tempfile.mkstemp(prefix=f'.{name}.', dir=out)
    try:
        with os.fdopen(fd, 'w') as stream:
            for item in value:
                stream.write(json.dumps(item, sort_keys=True, separators=(',', ':')) + '\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, out / name)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
PY
}

append_registry() {
  local kind=$1
  local identity=$2
  local name=${3:-}
  [[ "$kind" =~ ^(containers|volumes|networks|images)$ ]] || return 2
  [[ "$identity" != *$'\t'* && "$identity" != *$'\n'* ]] || return 2
  [[ "$name" != *$'\t'* && "$name" != *$'\n'* ]] || return 2
  printf '%s\t%s\n' "$identity" "$name" >>"$state_root/registry/$kind"
  sync -f "$state_root/registry/$kind"
}

verify_source_archive() {
  local actual
  actual=$(sha256sum -- "$source_archive") || return 1
  actual=${actual%% *}
  if [[ -z "$source_archive_sha256" || "$actual" != "$source_archive_sha256" ]]; then
    status_message "immutable source archive changed"
    return 1
  fi
}

verify_source() {
  python3 - "$source_root" "$release_revision" <<'PY'
import hashlib
import os
import pathlib
import stat
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
revision = sys.argv[2]
head = subprocess.run(
    ['git', '-C', str(root), 'rev-parse', '--verify', 'HEAD^{commit}'],
    check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
).stdout.decode().strip()
if head != revision:
    raise SystemExit(f'source revision changed: expected {revision}, got {head}')
raw = subprocess.run(
    ['git', '-C', str(root), 'ls-files', '--stage', '-z'],
    check=True, stdout=subprocess.PIPE,
).stdout
expected = {}
for record in raw.split(b'\0'):
    if not record:
        continue
    metadata, path = record.split(b'\t', 1)
    mode, oid, stage = metadata.split(b' ')
    if stage != b'0':
        raise SystemExit('source snapshot contains an unmerged index entry')
    expected[path] = (mode, oid.decode())

actual_paths = set()
for directory, names, files in os.walk(os.fsencode(root), topdown=True, followlinks=False):
    if directory == os.fsencode(root):
        names[:] = [name for name in names if name != b'.git']
        files = [name for name in files if name != b'.git']
    for name in files:
        actual_paths.add(os.path.relpath(os.path.join(directory, name), os.fsencode(root)))
    for name in list(names):
        path = os.path.join(directory, name)
        if os.path.islink(path):
            actual_paths.add(os.path.relpath(path, os.fsencode(root)))
            names.remove(name)
if actual_paths != set(expected):
    missing = sorted(set(expected) - actual_paths)
    extra = sorted(actual_paths - set(expected))
    raise SystemExit(f'source path set changed: missing={missing!r} extra={extra!r}')

for path, (mode, oid) in expected.items():
    full = os.path.join(os.fsencode(root), path)
    st = os.lstat(full)
    if mode == b'120000':
        data = os.readlink(full)
        if isinstance(data, str):
            data = os.fsencode(data)
    else:
        if not stat.S_ISREG(st.st_mode):
            raise SystemExit(f'tracked path changed type: {path!r}')
        with open(full, 'rb') as stream:
            data = stream.read()
        expected_exec = mode == b'100755'
        actual_exec = bool(st.st_mode & stat.S_IXUSR)
        if expected_exec != actual_exec:
            raise SystemExit(f'tracked executable mode changed: {path!r}')
    digest = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
    if digest != oid:
        raise SystemExit(f'tracked content changed: {path!r}')
PY
}

register_owned_pid() {
  local pid=$1
  python3 - "$pid" "$state_root" "$run_id" <<'PY'
import base64
import json
import os
import pathlib
import sys

pid = int(sys.argv[1])
state = pathlib.Path(sys.argv[2])
run_id = sys.argv[3]
boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

def process_stat(candidate):
    raw = (pathlib.Path('/proc') / str(candidate) / 'stat').read_text()
    fields = raw[raw.rfind(') ') + 2:].split()
    return int(fields[1]), fields[19]

def identity(candidate):
    proc = pathlib.Path('/proc') / str(candidate)
    ppid, start_ticks = process_stat(candidate)
    uid = next(
        line.split()[1] for line in (proc / 'status').read_text().splitlines()
        if line.startswith('Uid:')
    )
    return {
        'pid': candidate,
        'ppid': ppid,
        'start_ticks': start_ticks,
        'uid': uid,
        'exe': os.readlink(proc / 'exe'),
        'cwd': os.readlink(proc / 'cwd'),
        'cmdline_b64': base64.b64encode((proc / 'cmdline').read_bytes()).decode(),
    }

current = identity(pid)
ancestry = []
parent = current['ppid']
while parent > 0:
    try:
        ancestor_ppid, ancestor_start = process_stat(parent)
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError, ValueError):
        break
    ancestry.append([parent, ancestor_start])
    if ancestor_ppid == parent:
        break
    parent = ancestor_ppid
record = {
    **current,
    'boot_id': boot,
    'run_id': run_id,
    'data_dir': str(state),
    'ancestry': ancestry,
}
path = state / 'registry' / 'pids' / f'{pid}.json'
with path.open('x') as stream:
    json.dump(record, stream, sort_keys=True, separators=(',', ':'))
    stream.write('\n')
    stream.flush()
    os.fsync(stream.fileno())
PY
}

verify_owned_pid() {
  local record=$1
  python3 - "$record" "$state_root" "$run_id" <<'PY'
import base64
import json
import os
import pathlib
import sys

record = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = sys.argv[2]
run_id = sys.argv[3]
if record['run_id'] != run_id or record['data_dir'] != state:
    raise SystemExit(1)
if pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip() != record['boot_id']:
    raise SystemExit(1)

def process_stat(pid):
    raw = (pathlib.Path('/proc') / str(pid) / 'stat').read_text()
    fields = raw[raw.rfind(') ') + 2:].split()
    return int(fields[1]), fields[19]

def identity(pid):
    proc = pathlib.Path('/proc') / str(pid)
    ppid, start_ticks = process_stat(pid)
    uid = next(
        line.split()[1] for line in (proc / 'status').read_text().splitlines()
        if line.startswith('Uid:')
    )
    return {
        'pid': pid,
        'ppid': ppid,
        'start_ticks': start_ticks,
        'uid': uid,
        'exe': os.readlink(proc / 'exe'),
        'cwd': os.readlink(proc / 'cwd'),
        'cmdline_b64': base64.b64encode((proc / 'cmdline').read_bytes()).decode(),
    }
current = identity(record['pid'])
for field in ('pid', 'ppid', 'start_ticks', 'uid', 'exe', 'cwd', 'cmdline_b64'):
    if current[field] != record[field]:
        raise SystemExit(1)
if run_id not in base64.b64decode(current['cmdline_b64']).decode(errors='replace'):
    raise SystemExit(1)
ancestry = []
parent = current['ppid']
while parent > 0:
    ancestor_ppid, ancestor_start = process_stat(parent)
    ancestry.append([parent, ancestor_start])
    if ancestor_ppid == parent:
        break
    parent = ancestor_ppid
if ancestry != record['ancestry']:
    raise SystemExit(1)
PY
}

run_owned() {
  local description=$1
  shift
  setsid bash -c '
    run_id=$1
    state_root=$2
    shift 2
    kill -STOP "$$"
    child=""
    forward() { [[ -z "$child" ]] || kill -TERM "$child" 2>/dev/null || true; }
    trap forward TERM INT HUP
    "$@" & child=$!
    if wait "$child"; then exit 0; else exit $?; fi
  ' "operant-release-owned-$run_id" "$run_id" "$state_root" "$@" &
  local supervisor=$!
  local state=""
  local attempt
  for attempt in {1..200}; do
    [[ -r "/proc/$supervisor/status" ]] || break
    while IFS= read -r line; do
      [[ "$line" == State:* ]] && state=$line
    done <"/proc/$supervisor/status"
    [[ "$state" == *T* ]] && break
    sleep 0.01
  done
  if [[ "$state" != *T* ]]; then
    status_message "owned process failed to enter registration stop: $description"
    kill -KILL "$supervisor" 2>/dev/null || true
    wait "$supervisor" 2>/dev/null || true
    return 1
  fi
  register_owned_pid "$supervisor"
  local record="$state_root/registry/pids/$supervisor.json"
  if ! verify_owned_pid "$record"; then
    status_message "owned process identity changed before start: $description"
    kill -KILL "$supervisor" 2>/dev/null || true
    wait "$supervisor" 2>/dev/null || true
    return 1
  fi
  kill -CONT "$supervisor"
  if wait "$supervisor"; then
    return 0
  else
    return $?
  fi
}

inspect_label() {
  local kind=$1
  local identity=$2
  case "$kind" in
    containers) docker container inspect "$identity" --format "{{index .Config.Labels \"$gate_label_key\"}}" ;;
    volumes) docker volume inspect "$identity" --format "{{index .Labels \"$gate_label_key\"}}" ;;
    networks) docker network inspect "$identity" --format "{{index .Labels \"$gate_label_key\"}}" ;;
    images) docker image inspect "$identity" --format "{{index .Config.Labels \"$gate_label_key\"}}" ;;
    *) return 2 ;;
  esac
}

cleanup_registered_docker_kind() {
  local kind=$1
  local file="$state_root/registry/$kind"
  local identities="$state_root/cleanup-${kind}.ids"
  local labeled="$state_root/cleanup-${kind}.labeled"
  : >"$identities"
  if [[ -f "$file" ]]; then
    cut -f1 -- "$file" >>"$identities" || return 1
  fi
  case "$kind" in
    containers) atomic_sorted_command "$labeled" docker container ls --all --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    volumes) atomic_sorted_command "$labeled" docker volume ls --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    networks) atomic_sorted_command "$labeled" docker network ls --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    images) atomic_sorted_command "$labeled" docker image ls --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
  esac
  cat -- "$labeled" >>"$identities" || return 1
  LC_ALL=C sort -u -o "$identities" -- "$identities" || return 1
  local identity label
  while IFS= read -r identity; do
    [[ -n "$identity" && "$identity" != pending:* ]] || continue
    if ! label=$(inspect_label "$kind" "$identity" 2>/dev/null); then
      continue
    fi
    if [[ "$label" != "$run_id" ]]; then
      status_message "refusing cleanup after $kind identity/label mismatch: $identity"
      return 1
    fi
    case "$kind" in
      containers) docker container rm --force --volumes "$identity" >/dev/null || return 1 ;;
      volumes) docker volume rm --force "$identity" >/dev/null || return 1 ;;
      networks) docker network rm "$identity" >/dev/null || return 1 ;;
      images)
        if [[ "${OPERANT_RELEASE_KEEP_IMAGE:-0}" != "1" ]]; then
          if [[ "$identity" != "$release_image_id" || -z "$release_image_tag" ]]; then
            status_message "refusing to remove a run-labeled image without its exact registered tag: $identity"
            return 1
          fi
          docker image rm -- "$release_image_tag" >/dev/null || return 1
        fi
        ;;
    esac
  done <"$identities"
}

scan_unregistered_host_markers() {
  python3 - "$state_root/after/host" "$state_root" "$run_id" <<'PY'
import base64
import json
import pathlib
import sys

snapshot = pathlib.Path(sys.argv[1])
state_root = sys.argv[2]
run_id = sys.argv[3]
failures = []
for line in (snapshot / 'processes').read_text().splitlines():
    item = json.loads(line)
    cmdline = base64.b64decode(item['cmdline_b64']).decode(errors='replace')
    if run_id in cmdline:
        failures.append(f'unregistered run-ID process remains: {item["pid"]}')
for line in (snapshot / 'temp-dirs').read_text().splitlines():
    item = json.loads(line)
    path = base64.b64decode(item['path_b64']).decode(errors='surrogateescape')
    if run_id in path and path != state_root:
        failures.append(f'unregistered run-ID temp remains: {path!r}')
if failures:
    print('\n'.join(failures), file=sys.stderr)
    raise SystemExit(1)
PY
}

scan_run_labels_empty() {
  local kind=$1
  local output="$state_root/final-label-$kind"
  case "$kind" in
    containers) atomic_sorted_command "$output" docker container ls --all --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    volumes) atomic_sorted_command "$output" docker volume ls --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    networks) atomic_sorted_command "$output" docker network ls --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    images) atomic_sorted_command "$output" docker image ls --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
  esac
  if [[ -s "$output" ]]; then
    status_message "supplementary exact run-label scan found leaked $kind"
    cat -- "$output" >&2
    return 1
  fi
}

cleanup_owned_processes() {
  local status=0
  local record pid
  shopt -s nullglob
  for record in "$state_root"/registry/pids/*.json; do
    pid=${record##*/}
    pid=${pid%.json}
    [[ -d "/proc/$pid" ]] || continue
    if ! verify_owned_pid "$record"; then
      status_message "refusing TERM after owned PID identity mismatch: $pid"
      status=1
      continue
    fi
    kill -TERM -- "-$pid" 2>/dev/null || status=1
  done
  sleep 1
  for record in "$state_root"/registry/pids/*.json; do
    pid=${record##*/}
    pid=${pid%.json}
    [[ -d "/proc/$pid" ]] || continue
    if ! verify_owned_pid "$record"; then
      status_message "refusing KILL after owned PID identity mismatch: $pid"
      status=1
      continue
    fi
    kill -KILL -- "-$pid" 2>/dev/null || status=1
  done
  shopt -u nullglob
  return "$status"
}

cleanup_and_compare() {
  local primary_status=$?
  local cleanup_status=0
  if [[ "$cleanup_active" == true ]]; then
    return
  fi
  cleanup_active=true
  trap - EXIT INT TERM HUP
  set +e

  if [[ -n "$state_root" && -d "$state_root" ]]; then
    cleanup_owned_processes || cleanup_status=1
    cleanup_registered_docker_kind containers || cleanup_status=1
    cleanup_registered_docker_kind volumes || cleanup_status=1
    cleanup_registered_docker_kind networks || cleanup_status=1
    cleanup_registered_docker_kind images || cleanup_status=1

    cd "$repo_root" || cleanup_status=1
    if [[ -n "$source_root" && -e "$source_root/.git" ]]; then
      git -C "$repo_root" worktree remove --force -- "$source_root" >/dev/null 2>&1 || cleanup_status=1
    fi
    [[ -z "$artifact_dir" || ! -e "$artifact_dir" ]] || rm -rf -- "$artifact_dir" || cleanup_status=1

    scan_run_labels_empty containers || cleanup_status=1
    scan_run_labels_empty volumes || cleanup_status=1
    scan_run_labels_empty networks || cleanup_status=1
    if [[ "${OPERANT_RELEASE_KEEP_IMAGE:-0}" != "1" ]]; then
      scan_run_labels_empty images || cleanup_status=1
    fi

    if [[ "$baseline_ready" == true ]]; then
      snapshot_docker "$state_root/after/docker" || cleanup_status=1
      snapshot_host "$state_root/after/host" || cleanup_status=1
      local kind
      for kind in images containers volumes networks; do
        if ! cmp -s -- "$state_root/before/docker/$kind" "$state_root/after/docker/$kind"; then
          status_message "exact Docker inventory delta ($kind)"
          diff -u -- "$state_root/before/docker/$kind" "$state_root/after/docker/$kind" >&2 || true
          cleanup_status=1
        fi
      done
      # Full process and top-level temp snapshots are retained for exact audit.
      # Concurrent unrelated host activity is never treated as ownership; only
      # this cryptographic run marker or an exact registry identity can block
      # and authorize host cleanup.
      scan_unregistered_host_markers || cleanup_status=1
    fi

    rm -rf -- "$state_root" || cleanup_status=1
  fi

  if ((primary_status != 0)); then
    ((cleanup_status == 0)) || status_message "cleanup also failed while preserving primary status $primary_status"
    exit "$primary_status"
  fi
  exit "$cleanup_status"
}

signal_exit() {
  local status=$1
  exit "$status"
}

# Validate every caller-controlled identity before allocating gate state or
# taking any resource snapshot.
repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
if [[ "${OPERANT_RELEASE_GATE_ACTIVE:-0}" == "1" ]]; then
  status_message "nested release-gate execution is forbidden"
  exit 1
fi
if ! release_revision=$(git rev-parse --verify 'HEAD^{commit}'); then
  status_message "HEAD is not an exact commit"
  exit 1
fi
if [[ ! "$release_revision" =~ ^[0-9a-f]{40}$ ]]; then
  status_message "HEAD did not resolve to a full commit object ID"
  exit 1
fi
if ! source_status=$(git status --porcelain=v1 --untracked-files=all); then
  status_message "could not verify source cleanliness"
  exit 1
fi
if [[ -n "$source_status" ]]; then
  status_message "requires a clean tracked and untracked source tree"
  git status --short >&2 || true
  exit 1
fi
if [[ -n "${OPERANT_RELEASE_BASE:-}" && -n "${OPERANT_RELEASE_BASE_REV:-}" && "$OPERANT_RELEASE_BASE" != "$OPERANT_RELEASE_BASE_REV" ]]; then
  status_message "conflicting OPERANT_RELEASE_BASE and legacy OPERANT_RELEASE_BASE_REV"
  exit 1
fi
release_base=${OPERANT_RELEASE_BASE:-${OPERANT_RELEASE_BASE_REV:-$frozen_release_base}}
if [[ ! "$release_base" =~ ^[0-9a-f]{40}$ ]]; then
  status_message "release base must be a full 40-character commit object ID: $release_base"
  exit 1
fi
if ! resolved_base=$(git rev-parse --verify "${release_base}^{commit}") ||
  [[ "$resolved_base" != "$release_base" ]] ||
  [[ "$(git cat-file -t -- "$release_base")" != commit ]] ||
  ! git merge-base --is-ancestor "$release_base" "$release_revision"; then
  status_message "release base is unavailable, not exact, or not an ancestor: $release_base"
  exit 1
fi

IFS= read -r run_uuid </proc/sys/kernel/random/uuid
run_id=${run_uuid//-/}
if [[ ! "$run_id" =~ ^[0-9a-f]{32}$ ]]; then
  status_message "could not generate a cryptographically unique gate run ID"
  exit 1
fi
state_root=$(mktemp -d -t "operant-release-gate-${run_id}-XXXXXX")
trap cleanup_and_compare EXIT
trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM
trap 'signal_exit 129' HUP

chmod 0700 -- "$state_root"
mkdir -p -- "$state_root/registry/pids" "$state_root/before/docker" "$state_root/before/host" "$state_root/after/docker" "$state_root/after/host"
for kind in containers volumes networks images; do : >"$state_root/registry/$kind"; done
printf '%s\t%s\n' "$state_root" state-root >"$state_root/registry/temps"
sync -f "$state_root/registry"
source_root="$state_root/source"
source_archive="$state_root/source.tar"
artifact_dir="$state_root/artifacts"
printf '%s\t%s\n' "$source_root" source-worktree >>"$state_root/registry/temps"
printf '%s\t%s\n' "$source_archive" immutable-archive >>"$state_root/registry/temps"
printf '%s\t%s\n' "$artifact_dir" artifacts >>"$state_root/registry/temps"
sync -f "$state_root/registry/temps"

snapshot_docker "$state_root/before/docker"
snapshot_host "$state_root/before/host"
baseline_ready=true

printf '\n== clean immutable source identity ==\n'
printf 'gate run ID: %s\nsource revision: %s\nrelease range: %s..%s\n' "$run_id" "$release_revision" "$release_base" "$release_revision"

git archive --format=tar --output="$source_archive" "$release_revision"
sync -f "$source_archive"
source_archive_sha256=$(sha256sum -- "$source_archive")
source_archive_sha256=${source_archive_sha256%% *}
chmod 0400 -- "$source_archive"
verify_source_archive
git worktree add --detach -- "$source_root" "$release_revision" >/dev/null
verify_source

release_paths="$state_root/release-ts.zlist"
git -C "$source_root" diff --name-only -z --diff-filter=ACMR "$release_base..$release_revision" -- '*.ts' >"$release_paths"
sync -f "$release_paths"
mapfile -d '' -t release_ts <"$release_paths"
filtered_ts=()
for path in "${release_ts[@]}"; do
  [[ -f "$source_root/$path" ]] && filtered_ts+=("$path")
done
release_ts=("${filtered_ts[@]}")
if ((${#release_ts[@]} == 0)); then
  status_message "release range selected no TypeScript files; refusing incomplete lint/check coverage"
  exit 1
fi
printf 'effective committed TypeScript coverage (%d files):\n' "${#release_ts[@]}"
printf '  %q\n' "${release_ts[@]}"

export OPERANT_RELEASE_GATE_ACTIVE=1
export OPERANT_RELEASE_GATE_ID="$run_id"
export OPERANT_RELEASE_GATE_REGISTRY="$state_root/registry"
export OPERANT_RELEASE_SOURCE_REVISION="$release_revision"
export OPERANT_RELEASE_SOURCE_ROOT="$source_root"

cd "$source_root"
printf 'COMMAND: deno lint -- <effective NUL-collected files above>\n'
run_owned effective-lint deno lint -- "${release_ts[@]}"
verify_source
printf 'COMMAND: deno check -- <effective NUL-collected files above>\n'
run_owned effective-check deno check -- "${release_ts[@]}"
verify_source

printf '\n== typecheck and format ==\n'
printf 'COMMAND: deno task check\n'
run_owned typecheck deno task check
verify_source
printf 'COMMAND: deno fmt --check src tests docs deno.json\n'
run_owned format deno fmt --check src tests docs deno.json
verify_source

printf '\n== exact one-time release image build ==\n'
release_version="release-gate-${release_revision:0:12}"
release_image_tag="operant:${release_version}-${run_id}"
printf 'COMMAND: docker build --pull=false --no-cache ... --tag %s - < immutable git archive\n' "$release_image_tag"
append_registry images "pending:$release_image_tag" "$release_image_tag"
verify_source_archive
run_owned image-build bash -c 'exec docker build --pull=false --no-cache \
  --label "$1=$2" --build-arg "OPERANT_REVISION=$3" \
  --build-arg "OPERANT_VERSION=$4" --tag "$5" - <"$6"' \
  operant-build "$gate_label_key" "$run_id" "$release_revision" "$release_version" "$release_image_tag" "$source_archive"
verify_source_archive
verify_source
image_built=true
release_image_id=$(docker image inspect "$release_image_tag" --format '{{.Id}}')
image_revision=$(docker image inspect "$release_image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
image_version=$(docker image inspect "$release_image_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
image_gate_id=$(docker image inspect "$release_image_id" --format "{{index .Config.Labels \"$gate_label_key\"}}")
if [[ ! "$release_image_id" =~ ^sha256:[0-9a-f]{64}$ || "$image_revision" != "$release_revision" || "$image_version" != "$release_version" || "$image_gate_id" != "$run_id" ]]; then
  status_message "built image identity mismatch: id=$release_image_id revision=$image_revision version=$image_version gate=$image_gate_id"
  exit 1
fi
append_registry images "$release_image_id" "$release_image_tag"
export OPERANT_CONTAINER_IMAGE="$release_image_id"
export OPERANT_CONTAINER_IMAGE_TAG="$release_image_tag"
export OPERANT_CONTAINER_IMAGE_ID="$release_image_id"
export OPERANT_CONTAINER_REVISION="$release_revision"
export OPERANT_CONTAINER_VERSION="$release_version"
export OPERANT_CONTAINER_SKIP_BUILD=1
printf 'exact immutable image ID: %s\ncontainer build mode: skip-build/reuse\n' "$release_image_id"

printf '\n== Compose and release artifact contracts ==\n'
OPERANT_IMAGE="$release_image_id" \
OPERANT_POSTGRES_PASSWORD=compose-contract \
OPERANT_BOOTSTRAP_TOKEN=compose-contract \
OPERANT_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  run_owned compose-config docker compose -f compose.external-postgres.yml config --quiet
verify_source
run_owned release-artifacts bash scripts/release-artifacts.sh "$release_image_id" "$artifact_dir"
verify_source
jq -e --arg revision "$release_revision" --arg image_id "$release_image_id" --arg version "$release_version" \
  '.source_dirty == false and .source_revision == $revision and .image_id == $image_id and .labels["org.opencontainers.image.revision"] == $revision and .labels["org.opencontainers.image.version"] == $version and (.postgres | contains("18.4"))' \
  "$artifact_dir/image-metadata.json" >/dev/null
(cd "$artifact_dir" && sha256sum --check SHA256SUMS)

printf '\n== complete real-PG and exact-image container suite ==\n'
printf 'COMMAND: OPERANT_CONTAINER_SKIP_BUILD=1 deno task test\n'
run_owned complete-suite deno task test
verify_source

printf '\n== post-suite exact image identity ==\n'
[[ "$(docker image inspect "$release_image_id" --format '{{.Id}}')" == "$release_image_id" ]]
[[ "$(docker image inspect "$release_image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$release_revision" ]]
if [[ "$(docker image inspect "$release_image_tag" --format '{{.Id}}')" != "$release_image_id" ]]; then
  status_message "mutable convenience tag drifted from the frozen image ID"
  exit 1
fi

printf '\n== release legacy deployment scan and diff check ==\n'
if grep -REn 'path: /health|postgres:16|PGlite.*production|SQLite.*production' \
  Dockerfile docker-compose.yml compose.external-postgres.yml k8s docs/runtime.md; then
  status_message "legacy deployment contract found"
  exit 1
fi
git diff --check "$release_base..$release_revision"
verify_source

printf '\nrelease gate complete; immutable image is removed on EXIT (set OPERANT_RELEASE_KEEP_IMAGE=1 to retain it)\n'
