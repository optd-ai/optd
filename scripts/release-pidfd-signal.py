#!/usr/bin/env python3
"""Signal one durably registered Linux process through an identity-pinned pidfd."""

from __future__ import annotations

import base64
import errno
import json
import os
from pathlib import Path
import signal
import stat
import sys
from typing import Callable


IDENTITY_FIELDS = (
    "pid",
    "ppid",
    "start_ticks",
    "uid",
    "exe",
    "cwd",
    "cmdline_b64",
)
DIRECTORY_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
RECORD_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK


class IdentityError(RuntimeError):
    pass


class ProcessGone(IdentityError):
    pass


def process_stat(proc_root: Path, pid: int) -> tuple[int, str]:
    raw = (proc_root / str(pid) / "stat").read_text()
    fields = raw[raw.rfind(") ") + 2 :].split()
    if len(fields) < 20:
        raise IdentityError(f"invalid stat record for PID {pid}")
    return int(fields[1]), fields[19]


def process_identity(proc_root: Path, pid: int) -> dict[str, object]:
    proc = proc_root / str(pid)
    ppid, start_ticks = process_stat(proc_root, pid)
    try:
        uid = next(
            line.split()[1]
            for line in (proc / "status").read_text().splitlines()
            if line.startswith("Uid:")
        )
    except (IndexError, StopIteration) as error:
        raise IdentityError(f"invalid status record for PID {pid}") from error
    ancestry: list[list[object]] = []
    parent = ppid
    while parent > 0:
        ancestor_ppid, ancestor_start = process_stat(proc_root, parent)
        ancestry.append([parent, ancestor_start])
        if ancestor_ppid == parent:
            break
        parent = ancestor_ppid
    return {
        "pid": pid,
        "ppid": ppid,
        "start_ticks": start_ticks,
        "uid": uid,
        "exe": os.readlink(proc / "exe"),
        "cwd": os.readlink(proc / "cwd"),
        "cmdline_b64": base64.b64encode((proc / "cmdline").read_bytes()).decode(),
        "ancestry": ancestry,
    }


def canonical_absolute(path: Path | str, description: str) -> Path:
    supplied = Path(path)
    canonical = Path(os.path.abspath(os.fspath(supplied)))
    if not supplied.is_absolute() or supplied != canonical:
        raise IdentityError(f"{description} is not an exact canonical absolute path")
    return canonical


def open_directory_without_symlinks(path: Path) -> int:
    descriptor = os.open("/", DIRECTORY_FLAGS)
    try:
        for component in path.parts[1:]:
            next_descriptor = os.open(component, DIRECTORY_FLAGS, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def assert_private_directory(metadata: os.stat_result, description: str) -> None:
    if not stat.S_ISDIR(metadata.st_mode):
        raise IdentityError(f"{description} is not a directory")
    if metadata.st_uid != os.geteuid():
        raise IdentityError(f"{description} has the wrong owner")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise IdentityError(f"{description} mode is not exactly 0700")


def assert_private_record(metadata: os.stat_result) -> None:
    if not stat.S_ISREG(metadata.st_mode):
        raise IdentityError("PID registry record is not a regular file")
    if metadata.st_nlink != 1:
        raise IdentityError("PID registry record link count is not exactly one")
    if metadata.st_uid != os.geteuid():
        raise IdentityError("PID registry record has the wrong owner")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise IdentityError("PID registry record mode is not exactly 0600")


def assert_same_identity(
    opened: os.stat_result, path_entry: os.stat_result, description: str
) -> None:
    if (opened.st_dev, opened.st_ino) != (path_entry.st_dev, path_entry.st_ino):
        raise IdentityError(f"{description} path identity changed")


def read_record(descriptor: int) -> dict[str, object]:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = os.read(descriptor, 64 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > 1024 * 1024:
            raise IdentityError("PID registry record is too large")
        chunks.append(chunk)
    try:
        record = json.loads(b"".join(chunks))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IdentityError("PID registry record is not valid JSON") from error
    if not isinstance(record, dict):
        raise IdentityError("PID registry record is not an object")
    return record


def signal_registered_process(
    record_path: Path,
    state_root: Path | str,
    registry_root: Path | str,
    run_id: str,
    signal_number: int,
    *,
    proc_root: Path = Path("/proc"),
    pidfd_open: Callable[[int, int], int] = os.pidfd_open,
    pidfd_send_signal: Callable[[int, int], None] = signal.pidfd_send_signal,
    before_revalidate: Callable[[], None] | None = None,
) -> None:
    state = canonical_absolute(state_root, "trusted state root")
    registry = canonical_absolute(registry_root, "trusted registry root")
    record_path = canonical_absolute(record_path, "PID registry record")
    if registry != state / "registry":
        raise IdentityError("trusted registry root is not the state registry")
    pids_path = registry / "pids"
    if record_path.parent != pids_path:
        raise IdentityError("PID registry record is outside the exact registry")
    if record_path.suffix != ".json" or not record_path.stem.isdecimal():
        raise IdentityError("PID registry record name is invalid")
    path_pid = int(record_path.stem)
    if path_pid <= 1 or str(path_pid) != record_path.stem:
        raise IdentityError("PID registry record name is not canonical")

    descriptors: list[int] = []
    try:
        state_fd = open_directory_without_symlinks(state)
        descriptors.append(state_fd)
        registry_fd = os.open("registry", DIRECTORY_FLAGS, dir_fd=state_fd)
        descriptors.append(registry_fd)
        pids_fd = os.open("pids", DIRECTORY_FLAGS, dir_fd=registry_fd)
        descriptors.append(pids_fd)
        record_fd = os.open(record_path.name, RECORD_FLAGS, dir_fd=pids_fd)
        descriptors.append(record_fd)

        state_identity = os.fstat(state_fd)
        registry_identity = os.fstat(registry_fd)
        pids_identity = os.fstat(pids_fd)
        record_identity = os.fstat(record_fd)
        assert_private_directory(state_identity, "trusted state root")
        assert_private_directory(registry_identity, "trusted registry root")
        assert_private_directory(pids_identity, "trusted PID registry")
        assert_private_record(record_identity)

        def assert_stable_registry() -> None:
            current_state = os.fstat(state_fd)
            current_registry = os.fstat(registry_fd)
            current_pids = os.fstat(pids_fd)
            current_record = os.fstat(record_fd)
            assert_private_directory(current_state, "trusted state root")
            assert_private_directory(current_registry, "trusted registry root")
            assert_private_directory(current_pids, "trusted PID registry")
            assert_private_record(current_record)
            assert_same_identity(
                state_identity,
                os.stat(state, follow_symlinks=False),
                "trusted state root",
            )
            assert_same_identity(
                registry_identity,
                os.stat("registry", dir_fd=state_fd, follow_symlinks=False),
                "trusted registry root",
            )
            assert_same_identity(
                pids_identity,
                os.stat("pids", dir_fd=registry_fd, follow_symlinks=False),
                "trusted PID registry",
            )
            assert_same_identity(
                record_identity,
                os.stat(record_path.name, dir_fd=pids_fd, follow_symlinks=False),
                "PID registry record",
            )
            assert_same_identity(state_identity, current_state, "trusted state root")
            assert_same_identity(
                registry_identity, current_registry, "trusted registry root"
            )
            assert_same_identity(pids_identity, current_pids, "trusted PID registry")
            assert_same_identity(record_identity, current_record, "PID registry record")

        assert_stable_registry()
        record = read_record(record_fd)
        assert_stable_registry()
        if record.get("run_id") != run_id or record.get("data_dir") != str(state):
            raise IdentityError("PID registry ownership context mismatch")
        pid = record.get("pid")
        if not isinstance(pid, int) or pid != path_pid:
            raise IdentityError("registered PID does not match the record path")

        # Registry and manifest identity is pinned and checked before opening
        # the pidfd. A later same-UID rename is detected again before signal.
        assert_stable_registry()
        try:
            pidfd = pidfd_open(pid, 0)
        except ProcessLookupError as error:
            raise ProcessGone(f"registered PID {pid} is already gone") from error
        except OSError as error:
            if error.errno == errno.ESRCH:
                raise ProcessGone(f"registered PID {pid} is already gone") from error
            raise IdentityError(f"could not open pidfd for PID {pid}: {error}") from error

        try:
            if before_revalidate is not None:
                before_revalidate()
            assert_stable_registry()
            boot_id = (proc_root / "sys/kernel/random/boot_id").read_text().strip()
            if boot_id != record.get("boot_id"):
                raise IdentityError("boot identity mismatch")
            current = process_identity(proc_root, pid)
            for field in IDENTITY_FIELDS:
                if current.get(field) != record.get(field):
                    raise IdentityError(f"PID identity mismatch in {field}")
            if current["ancestry"] != record.get("ancestry"):
                raise IdentityError("PID ancestry mismatch")
            cmdline = base64.b64decode(str(current["cmdline_b64"]), validate=True)
            if run_id.encode() not in cmdline:
                raise IdentityError("run ID missing from registered command line")
            assert_stable_registry()
            pidfd_send_signal(pidfd, signal_number)
        except (FileNotFoundError, PermissionError, ProcessLookupError, OSError) as error:
            raise IdentityError(
                f"PID identity inspection/signaling failed: {error}"
            ) from error
        finally:
            os.close(pidfd)
    except IdentityError:
        raise
    except OSError as error:
        raise IdentityError(f"PID registry inspection failed: {error}") from error
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def main(argv: list[str]) -> int:
    if len(argv) != 6:
        print(
            "usage: release-pidfd-signal.py RECORD STATE_ROOT REGISTRY_ROOT "
            "RUN_ID CONT|TERM|KILL",
            file=sys.stderr,
        )
        return 2
    signal_name = argv[5]
    allowed = {
        "CONT": signal.SIGCONT,
        "TERM": signal.SIGTERM,
        "KILL": signal.SIGKILL,
    }
    if signal_name not in allowed:
        print(f"unsupported signal: {signal_name}", file=sys.stderr)
        return 2
    try:
        signal_registered_process(
            Path(argv[1]), argv[2], argv[3], argv[4], allowed[signal_name]
        )
    except ProcessGone as error:
        print(error, file=sys.stderr)
        return 3
    except (IdentityError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
