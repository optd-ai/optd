#!/usr/bin/env bash
set -euo pipefail

# This invocation owns the export; nested gate-contract tests must not inherit it.
release_export_dir=${OPTD_RELEASE_EXPORT_DIR:-}
unset OPTD_RELEASE_EXPORT_DIR

readonly frozen_release_base="a6715631d48f2c6bf0c03326c909896ba9058164"
readonly gate_label_key="dev.optd.release-gate"
repo_root=""
release_revision=""
release_base=""
run_id=""
state_root=""
source_root=""
source_archive=""
source_archive_sha256=""
immutable_dockerfile=""
artifact_dir=""
release_image_tag=""
release_image_id=""
image_built=false
build_accounting_started=false
build_accounting_complete=false
baseline_ready=false
cleanup_active=false
owned_sequence=0

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
  atomic_sorted_command "$destination/images" docker image ls --all --no-trunc --quiet || return 1
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
index = subprocess.run(
    ['git', '-C', str(root), 'diff', '--cached', '--quiet', revision, '--'],
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
)
if index.returncode != 0:
    raise SystemExit('source index differs from immutable commit')
raw = subprocess.run(
    ['git', '-C', str(root), 'ls-tree', '-rz', '--full-tree', revision],
    check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
).stdout
expected = {}
for record in raw.split(b'\0'):
    if not record:
        continue
    metadata, path = record.split(b'\t', 1)
    mode, object_type, oid = metadata.split(b' ')
    if object_type != b'blob' or mode not in (b'100644', b'100755', b'120000'):
        raise SystemExit(
            f'unsupported immutable tree entry: mode={mode!r} type={object_type!r} path={path!r}'
        )
    if path in expected:
        raise SystemExit(f'duplicate immutable tree path: {path!r}')
    expected[path] = (mode, oid.decode())
object_format = subprocess.run(
    ['git', '-C', str(root), 'rev-parse', '--show-object-format'],
    check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
).stdout.decode().strip()
if object_format not in ('sha1', 'sha256'):
    raise SystemExit(f'unsupported Git object format: {object_format}')

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
        if not stat.S_ISLNK(st.st_mode):
            raise SystemExit(f'tracked symlink changed type: {path!r}')
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
    hasher = hashlib.new(object_format)
    hasher.update(b'blob ' + str(len(data)).encode() + b'\0' + data)
    if hasher.hexdigest() != oid:
        raise SystemExit(f'tracked content changed from immutable commit blob: {path!r}')
PY
}

register_owned_pid() {
  local pid=$1
  if [[ "${OPTD_RELEASE_TEST_PRE_REGISTRATION_FAILURE:-0}" == 1 && ! -e "$state_root/pre-registration-failure-injected" ]]; then
    : >"$state_root/pre-registration-failure-injected"
    return 1
  fi
  python3 - "$pid" "$state_root" "$run_id" <<'PY'
import base64
import json
import os
import pathlib
import stat
import sys

pid = int(sys.argv[1])
supplied_state = pathlib.Path(sys.argv[2])
state = pathlib.Path(os.path.abspath(supplied_state))
if not supplied_state.is_absolute() or supplied_state != state:
    raise SystemExit('state root is not an exact canonical absolute path')
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
registry = state / 'registry'
pids = registry / 'pids'
directory_flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW

def open_without_symlinks(path):
    descriptor = os.open('/', directory_flags)
    try:
        for component in path.parts[1:]:
            following = os.open(component, directory_flags, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise

def check_directory(descriptor, path_entry, description):
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode):
        raise RuntimeError(f'{description} is not a directory')
    if opened.st_uid != os.geteuid() or stat.S_IMODE(opened.st_mode) != 0o700:
        raise RuntimeError(f'{description} is not private and owned')
    if (opened.st_dev, opened.st_ino) != (path_entry.st_dev, path_entry.st_ino):
        raise RuntimeError(f'{description} path identity changed')
    return opened

state_fd = registry_fd = pids_fd = record_fd = -1
created = False
try:
    state_fd = open_without_symlinks(state)
    registry_fd = os.open('registry', directory_flags, dir_fd=state_fd)
    pids_fd = os.open('pids', directory_flags, dir_fd=registry_fd)
    state_identity = check_directory(
        state_fd, os.stat(state, follow_symlinks=False), 'state root'
    )
    registry_identity = check_directory(
        registry_fd,
        os.stat('registry', dir_fd=state_fd, follow_symlinks=False),
        'registry root',
    )
    pids_identity = check_directory(
        pids_fd,
        os.stat('pids', dir_fd=registry_fd, follow_symlinks=False),
        'PID registry',
    )
    data = (json.dumps(record, sort_keys=True, separators=(',', ':')) + '\n').encode()
    old_umask = os.umask(0o077)
    try:
        record_fd = os.open(
            f'{pid}.json',
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
            0o600,
            dir_fd=pids_fd,
        )
        created = True
    finally:
        os.umask(old_umask)
    os.fchmod(record_fd, 0o600)
    metadata = os.fstat(record_fd)
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or metadata.st_uid != os.geteuid()
        or stat.S_IMODE(metadata.st_mode) != 0o600
    ):
        raise RuntimeError('created PID registry record is not a private owned regular file')
    entry = os.stat(f'{pid}.json', dir_fd=pids_fd, follow_symlinks=False)
    if (metadata.st_dev, metadata.st_ino) != (entry.st_dev, entry.st_ino):
        raise RuntimeError('created PID registry record path identity changed')
    view = memoryview(data)
    while view:
        written = os.write(record_fd, view)
        if written <= 0:
            raise RuntimeError('could not write PID registry record')
        view = view[written:]
    os.fsync(record_fd)
    metadata_after = os.fstat(record_fd)
    entry_after = os.stat(f'{pid}.json', dir_fd=pids_fd, follow_symlinks=False)
    if (
        (metadata.st_dev, metadata.st_ino) != (metadata_after.st_dev, metadata_after.st_ino)
        or (metadata.st_dev, metadata.st_ino) != (entry_after.st_dev, entry_after.st_ino)
        or metadata_after.st_nlink != 1
        or metadata_after.st_uid != os.geteuid()
        or stat.S_IMODE(metadata_after.st_mode) != 0o600
    ):
        raise RuntimeError('PID registry record changed during durable creation')
    check_directory(state_fd, os.stat(state, follow_symlinks=False), 'state root')
    check_directory(
        registry_fd,
        os.stat('registry', dir_fd=state_fd, follow_symlinks=False),
        'registry root',
    )
    check_directory(
        pids_fd,
        os.stat('pids', dir_fd=registry_fd, follow_symlinks=False),
        'PID registry',
    )
    os.fsync(pids_fd)
    os.fsync(registry_fd)
except BaseException:
    if created:
        try:
            os.unlink(f'{pid}.json', dir_fd=pids_fd)
        except OSError:
            pass
    raise
finally:
    for descriptor in (record_fd, pids_fd, registry_fd, state_fd):
        if descriptor >= 0:
            os.close(descriptor)
PY
}

signal_owned_pid() {
  local record=$1
  local signal_name=$2
  local signal_status
  python3 "$source_root/scripts/release-pidfd-signal.py" \
    "$record" "$state_root" "$state_root/registry" "$run_id" "$signal_name"
  signal_status=$?
  [[ "$signal_status" == 3 ]] && return 0
  return "$signal_status"
}

run_owned() {
  local description=$1
  shift
  owned_sequence=$((owned_sequence + 1))
  local control="$state_root/owned-control-$owned_sequence"
  (umask 077 && : >"$control")
  python3 "$source_root/scripts/release-owned-supervisor.py" \
    "$control" "$run_id" "$state_root" "$@" &
  local supervisor=$!
  local record="$state_root/registry/pids/$supervisor.json"

  # The supervisor cannot launch the workload until this exact identity is
  # durably registered and a start token is written. On any pre-registration
  # failure, its bounded control wait exits without a numeric signal.
  if ! register_owned_pid "$supervisor"; then
    status_message "owned process registration failed before launch: $description"
    printf 'abort\n' >"$control" 2>/dev/null || true
    wait "$supervisor" 2>/dev/null || true
    rm -f -- "$control"
    return 1
  fi
  if ! signal_owned_pid "$record" CONT; then
    status_message "refusing CONT after owned PID identity inspection failed: $supervisor ($description)"
    printf 'abort\n' >"$control" 2>/dev/null || true
    wait "$supervisor" 2>/dev/null || true
    rm -f -- "$control"
    return 1
  fi
  if ! printf 'start\n' >"$control"; then
    status_message "could not authorize registered workload launch: $description"
    wait "$supervisor" 2>/dev/null || true
    rm -f -- "$control"
    return 1
  fi
  rm -f -- "$control"

  local command_status=0
  wait "$supervisor" || command_status=$?
  mkdir -p -- "$state_root/registry/pids/completed"
  mv -- "$record" "$state_root/registry/pids/completed/$supervisor.json" || return 1
  sync -f "$state_root/registry/pids/completed"
  return "$command_status"
}

account_build_images() {
  [[ "$build_accounting_started" == true ]] || return 0
  [[ "$build_accounting_complete" != true ]] || return 0
  atomic_sorted_command "$state_root/post-build-images" docker image ls --all --no-trunc --quiet || return 1
  python3 "$source_root/scripts/release-image-accounting.py" account \
    --baseline "$state_root/before/docker/images" \
    --post "$state_root/post-build-images" \
    --transcript "$state_root/build-transcript" \
    --registry "$state_root/registry" \
    --run-id "$run_id" \
    --tag "$release_image_tag" \
    --dockerfile "$immutable_dockerfile" || return 1
  release_image_id=$(python3 "$source_root/scripts/release-image-accounting.py" final-id \
    --registry "$state_root/registry" --run-id "$run_id") || return 1
  build_accounting_complete=true
}

cleanup_registered_images() {
  if [[ "$build_accounting_started" != true ]]; then
    [[ -f "$state_root/before/docker/images" ]] || return 1
    atomic_sorted_command "$state_root/cleanup-current-images" docker image ls --all --no-trunc --quiet || return 1
    cmp -s -- "$state_root/before/docker/images" "$state_root/cleanup-current-images" || return 1
    # Bare return in an EXIT trap inherits the primary failure status, even
    # after a successful comparison. Report this cleanup operation explicitly.
    return 0
  fi
  # One trusted helper owns all safe authority descriptors from complete
  # preflight through child-to-parent exact-ID action. It re-snapshots and
  # re-inspects the complete mutable Docker world immediately before each rm.
  if ! python3 "$source_root/scripts/release-image-accounting.py" cleanup \
    --baseline "$state_root/before/docker/images" \
    --registry "$state_root/registry" \
    --transcript "$state_root/build-transcript" \
    --run-id "$run_id" \
    --tag "$release_image_tag" \
    --final-id "$release_image_id" \
    --dockerfile "$immutable_dockerfile"; then
    status_message "image ownership preflight failed or exact action conflicted; preserving all images not already exactly removed"
    return 1
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
  local phase=${2:-all}
  if [[ "$kind" == images ]]; then
    cleanup_registered_images "$phase"
    return
  fi
  local file="$state_root/registry/$kind"
  local identities="$state_root/cleanup-${kind}.ids"
  local labeled="$state_root/cleanup-${kind}.labeled"
  if [[ "$phase" != action ]]; then
    : >"$identities"
  [[ -f "$file" ]] || return 1
  case "$kind" in
    containers) atomic_sorted_command "$labeled" docker container ls --all --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    volumes) atomic_sorted_command "$labeled" docker volume ls --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
    networks) atomic_sorted_command "$labeled" docker network ls --no-trunc --quiet --filter "label=$gate_label_key=$run_id" || return 1 ;;
  esac
  # Exact run-label enumeration is the active-resource authority. The durable
  # registry remains audit evidence, but may legitimately contain resources
  # already removed by successful --rm/Compose operations.
  cat -- "$labeled" >"$identities" || return 1
  LC_ALL=C sort -u -o "$identities" -- "$identities" || return 1
  local identity label
  # Revalidate the complete inventory before the first destructive command.
  # An inspect failure is ambiguous ownership, never evidence that a resource
  # disappeared or is safe to remove.
  while IFS= read -r identity; do
    [[ -n "$identity" && "$identity" != pending:* ]] || continue
    if ! label=$(inspect_label "$kind" "$identity" 2>/dev/null); then
      status_message "refusing cleanup after $kind ownership inspection failed: $identity"
      return 1
    fi
    if [[ "$label" != "$run_id" ]]; then
      status_message "refusing cleanup after $kind identity/label mismatch: $identity"
      return 1
    fi
  done <"$identities"
    [[ "$phase" != preflight ]] || return 0
  fi
  [[ -f "$identities" ]] || return 1

  while IFS= read -r identity; do
    [[ -n "$identity" && "$identity" != pending:* ]] || continue
    case "$kind" in
      containers) docker container rm --force --volumes "$identity" >/dev/null || return 1 ;;
      volumes) docker volume rm --force "$identity" >/dev/null || return 1 ;;
      networks) docker network rm "$identity" >/dev/null || return 1 ;;
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
    if ! signal_owned_pid "$record" TERM; then
      status_message "refusing TERM after owned PID identity inspection failed: $pid"
      status=1
    fi
  done
  sleep 1
  for record in "$state_root"/registry/pids/*.json; do
    pid=${record##*/}
    pid=${pid%.json}
    if ! signal_owned_pid "$record" KILL; then
      status_message "refusing KILL after owned PID identity inspection failed: $pid"
      status=1
    fi
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
    # A signal can transfer control directly from the one build into this trap.
    # Once its registered capture process is stopped, account its durable
    # transcript and exact delta before any Docker cleanup decision.
    account_build_images || cleanup_status=1
    local docker_cleanup_ready=true kind
    for kind in containers volumes networks; do
      if ! cleanup_registered_docker_kind "$kind" preflight; then
        docker_cleanup_ready=false
        cleanup_status=1
      fi
    done
    if [[ "$docker_cleanup_ready" == true ]]; then
      for kind in containers volumes networks; do
        cleanup_registered_docker_kind "$kind" action || cleanup_status=1
      done
    else
      status_message "non-image Docker cleanup blocked before its first destructive command"
    fi
    # Image authority is independently preflighted only after owned containers
    # are gone. One helper keeps the trusted authority in memory through action.
    cleanup_registered_images || {
      status_message "exact image cleanup or pre-build inventory comparison failed"
      cleanup_status=1
    }

    cd "$repo_root" || cleanup_status=1
    if [[ -n "$source_root" && -e "$source_root/.git" ]]; then
      git -C "$repo_root" worktree remove --force -- "$source_root" >/dev/null 2>&1 || cleanup_status=1
    fi
    [[ -z "$artifact_dir" || ! -e "$artifact_dir" ]] || rm -rf -- "$artifact_dir" || cleanup_status=1

    scan_run_labels_empty containers || cleanup_status=1
    scan_run_labels_empty volumes || cleanup_status=1
    scan_run_labels_empty networks || cleanup_status=1
    scan_run_labels_empty images || cleanup_status=1

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

    if ((cleanup_status == 0)); then
      rm -rf -- "$state_root" || cleanup_status=1
    else
      status_message "retained release-gate evidence after cleanup failure: $state_root"
    fi
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
if [[ "${OPTD_RELEASE_GATE_ACTIVE:-0}" == "1" ]]; then
  status_message "nested release-gate execution is forbidden"
  exit 1
fi
if [[ -n "${OPTD_RELEASE_KEEP_IMAGE:-}" && "${OPTD_RELEASE_KEEP_IMAGE}" != "0" ]]; then
  status_message "OPTD_RELEASE_KEEP_IMAGE is incompatible with exact all-image baseline restoration"
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
if [[ -n "${OPTD_RELEASE_BASE:-}" && -n "${OPTD_RELEASE_BASE_REV:-}" && "$OPTD_RELEASE_BASE" != "$OPTD_RELEASE_BASE_REV" ]]; then
  status_message "conflicting OPTD_RELEASE_BASE and legacy OPTD_RELEASE_BASE_REV"
  exit 1
fi
release_base=${OPTD_RELEASE_BASE:-${OPTD_RELEASE_BASE_REV:-$frozen_release_base}}
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
umask 077
state_root=$(mktemp -d -t "optd-release-gate-${run_id}-XXXXXX")
trap cleanup_and_compare EXIT
trap 'signal_exit 130' INT
trap 'signal_exit 143' TERM
trap 'signal_exit 129' HUP

chmod 0700 -- "$state_root"
mkdir -p -- "$state_root/registry/pids/completed" "$state_root/before/docker" "$state_root/before/host" "$state_root/after/docker" "$state_root/after/host"
chmod 0700 -- \
  "$state_root/registry" "$state_root/registry/pids" "$state_root/registry/pids/completed" \
  "$state_root/before" "$state_root/before/docker" "$state_root/before/host" \
  "$state_root/after" "$state_root/after/docker" "$state_root/after/host"
python3 - "$state_root" <<'PY'
import os
import pathlib
import stat
import sys

state = pathlib.Path(sys.argv[1])
paths = [state, state / 'registry', state / 'registry' / 'pids']
flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
for path in paths:
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        entry = os.stat(path, follow_symlinks=False)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
            or (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino)
        ):
            raise SystemExit(f'unsafe release-gate directory identity: {path}')
    finally:
        os.close(descriptor)
PY
for kind in containers volumes networks images; do : >"$state_root/registry/$kind"; done
mkdir -p -- "$state_root/registry/image-evidence"
chmod 0700 -- "$state_root/registry/image-evidence"
sync -f "$state_root/registry/image-evidence"
printf '%s\t%s\n' "$state_root" state-root >"$state_root/registry/temps"
sync -f "$state_root/registry"
source_root="$state_root/source"
source_archive="$state_root/source.tar"
immutable_dockerfile="$state_root/immutable-Dockerfile"
artifact_dir="$state_root/artifacts"
printf '%s\t%s\n' "$source_root" source-worktree >>"$state_root/registry/temps"
printf '%s\t%s\n' "$source_archive" immutable-archive >>"$state_root/registry/temps"
printf '%s\t%s\n' "$immutable_dockerfile" immutable-dockerfile >>"$state_root/registry/temps"
printf '%s\t%s\n' "$artifact_dir" artifacts >>"$state_root/registry/temps"
sync -f "$state_root/registry/temps"

snapshot_docker "$state_root/before/docker"
python3 "$repo_root/scripts/release-image-accounting.py" references --state "$state_root"
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
dockerfile_sha256=$(git -C "$source_root" show "$release_revision:Dockerfile" | sha256sum)
dockerfile_sha256=${dockerfile_sha256%% *}
python3 "$source_root/scripts/release-image-accounting.py" pin-dockerfile \
  --source "$source_root/Dockerfile" --destination "$immutable_dockerfile" \
  --sha256 "$dockerfile_sha256"

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

export OPTD_RELEASE_GATE_ACTIVE=1
export OPTD_RELEASE_GATE_ID="$run_id"
export OPTD_RELEASE_GATE_REGISTRY="$state_root/registry"
export OPTD_RELEASE_SOURCE_REVISION="$release_revision"
export OPTD_RELEASE_SOURCE_ROOT="$source_root"

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
printf 'COMMAND: deno fmt --check src tests docs project-model deno.json\n'
run_owned format deno fmt --check src tests docs project-model deno.json
verify_source

printf '\n== exact one-time release image build ==\n'
release_version="release-gate-${release_revision:0:12}"
release_image_tag="optd:${release_version}-${run_id}"
# The approved existing Docker driver retains its normal BuildKit cache. Only
# daemon objects belong to the four-set cleanup contract, never shared cache.
docker buildx inspect default >"$state_root/builder-inspect.txt"
grep -Eq '^Driver:[[:space:]]+docker$' "$state_root/builder-inspect.txt"
python3 - "$state_root" "$(docker info --format '{{.DockerRootDir}}')" <<'PY'
import json
import os
import pathlib
import sys

# Observed optd layers total about 2 GiB per no-cache build. Budget 8 GiB for
# build/load overlap, compiled test artifacts and database data, plus 4 GiB
# untouched reserve. Reassess independently on every invocation and replay.
peak = 8 * 1024**3
reserve = 4 * 1024**3
measurements = []
for path in (sys.argv[1], sys.argv[2]):
    usage = os.statvfs(path)
    free = usage.f_bavail * usage.f_frsize
    measurements.append({'path': path, 'free_bytes': free})
report = {'peak_bytes': peak, 'reserve_bytes': reserve, 'filesystems': measurements}
path = pathlib.Path(sys.argv[1]) / 'capacity.json'
with path.open('x') as stream:
    json.dump(report, stream, sort_keys=True)
    stream.flush()
    os.fsync(stream.fileno())
print(json.dumps(report, sort_keys=True))
if any(item['free_bytes'] < peak + reserve for item in measurements):
    raise SystemExit('insufficient build/test storage headroom; no cleanup attempted')
PY
printf 'COMMAND: docker buildx build --builder default --load --pull=false --no-cache ... --tag %s - < immutable git archive\n' "$release_image_tag"
append_registry images "pending:$release_image_tag" "$release_image_tag"
verify_source_archive
build_transcript="$state_root/build-transcript"
build_accounting_started=true
capture_status=0
if run_owned image-build python3 "$source_root/scripts/release-image-accounting.py" capture \
  --transcript "$build_transcript" --stdin "$source_archive" -- \
  docker buildx build --builder default --load --pull=false --no-cache \
  --iidfile "$state_root/build.iid" --metadata-file "$state_root/build.metadata.json" \
  --label "$gate_label_key=$run_id" --build-arg "OPTD_REVISION=$release_revision" \
  --build-arg "OPTD_VERSION=$release_version" --tag "$release_image_tag" -; then
  capture_status=0
else
  capture_status=$?
fi
# Always validate and consume the descriptor-safe durable result. Capture's
# process status must exactly preserve any forwarded signal even if Docker
# traps that signal and exits zero.
build_status=$(python3 "$source_root/scripts/release-image-accounting.py" status \
  --transcript "$build_transcript")
if ((capture_status != build_status)); then
  status_message "capture process status disagrees with durable signal result: process=$capture_status durable=$build_status"
  exit 1
fi
# Snapshot immediately after the sole build, before source checks or any later
# phase can create an image. Accounting registers and fsyncs every proven delta
# even when the build itself failed or was signaled.
account_status=0
account_build_images || account_status=$?
if ((account_status != 0)); then
  status_message "builder image authority is ambiguous; retaining transcript evidence and refusing image deletion"
  exit "$account_status"
fi
if ((build_status != 0)); then
  exit "$build_status"
fi
verify_source_archive
verify_source
image_built=true
image_revision=$(docker image inspect "$release_image_id" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
image_version=$(docker image inspect "$release_image_id" --format '{{index .Config.Labels "org.opencontainers.image.version"}}')
image_gate_id=$(docker image inspect "$release_image_id" --format "{{index .Config.Labels \"$gate_label_key\"}}")
if [[ ! "$release_image_id" =~ ^sha256:[0-9a-f]{64}$ || "$image_revision" != "$release_revision" || "$image_version" != "$release_version" || "$image_gate_id" != "$run_id" ]]; then
  status_message "built image identity mismatch: id=$release_image_id revision=$image_revision version=$image_version gate=$image_gate_id"
  exit 1
fi
export OPTD_CONTAINER_IMAGE="$release_image_id"
export OPTD_CONTAINER_IMAGE_TAG="$release_image_tag"
export OPTD_CONTAINER_IMAGE_ID="$release_image_id"
export OPTD_CONTAINER_REVISION="$release_revision"
export OPTD_CONTAINER_VERSION="$release_version"
export OPTD_CONTAINER_SKIP_BUILD=1
printf 'exact immutable image ID: %s\ncontainer build mode: skip-build/reuse\n' "$release_image_id"

printf '\n== Compose and release artifact contracts ==\n'
OPTD_IMAGE="$release_image_id" \
OPTD_POSTGRES_PASSWORD=compose-contract \
OPTD_BOOTSTRAP_TOKEN=compose-contract \
OPTD_SECRET_MASTER_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
  run_owned compose-config docker compose -f compose.external-postgres.yml config --quiet
verify_source
run_owned release-artifacts bash scripts/release-artifacts.sh "$release_image_id" "$artifact_dir"
verify_source
jq -e --arg revision "$release_revision" --arg image_id "$release_image_id" --arg version "$release_version" \
  '.source_dirty == false and .source_revision == $revision and .image_id == $image_id and .labels["org.opencontainers.image.revision"] == $revision and .labels["org.opencontainers.image.version"] == $version and (.postgres | contains("18.4"))' \
  "$artifact_dir/image-metadata.json" >/dev/null
(cd "$artifact_dir" && sha256sum --check SHA256SUMS)

printf '\n== complete real-PG and exact-image container suite ==\n'
printf 'COMMAND: OPTD_CONTAINER_SKIP_BUILD=1 deno task test\n'
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

# Export only after all checks; EXIT still enforces exact inventory restoration.
# Publication must require this process to exit successfully, not just files.
if [[ -n "$release_export_dir" ]]; then
  run_owned release-export bash scripts/release-export.sh \
    "$release_image_id" "$artifact_dir" "$release_export_dir"
fi

printf '\nrelease gate complete; every gate-created image is removed on EXIT\n'
