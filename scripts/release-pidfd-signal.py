#!/usr/bin/env python3
"""Signal one durably registered Linux process through an identity-pinned pidfd."""

from __future__ import annotations

import base64
import errno
import json
import os
from pathlib import Path
import signal
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
    uid = next(
        line.split()[1]
        for line in (proc / "status").read_text().splitlines()
        if line.startswith("Uid:")
    )
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


def load_record(path: Path) -> dict[str, object]:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        record = json.load(stream)
    if not isinstance(record, dict):
        raise IdentityError("PID registry record is not an object")
    return record


def signal_registered_process(
    record_path: Path,
    state_root: str,
    run_id: str,
    signal_number: int,
    *,
    proc_root: Path = Path("/proc"),
    pidfd_open: Callable[[int, int], int] = os.pidfd_open,
    pidfd_send_signal: Callable[[int, int], None] = signal.pidfd_send_signal,
    before_revalidate: Callable[[], None] | None = None,
) -> None:
    record = load_record(record_path)
    if record.get("run_id") != run_id or record.get("data_dir") != state_root:
        raise IdentityError("PID registry ownership context mismatch")
    pid = record.get("pid")
    if not isinstance(pid, int) or pid <= 1:
        raise IdentityError("invalid registered PID")

    # Opening first pins this exact kernel task. A later /proc/PID reuse can
    # only make revalidation fail; it cannot redirect pidfd_send_signal.
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
        pidfd_send_signal(pidfd, signal_number)
    except (FileNotFoundError, PermissionError, ProcessLookupError, OSError) as error:
        raise IdentityError(f"PID identity inspection/signaling failed: {error}") from error
    finally:
        os.close(pidfd)


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print(
            "usage: release-pidfd-signal.py RECORD STATE_ROOT RUN_ID CONT|TERM|KILL",
            file=sys.stderr,
        )
        return 2
    signal_name = argv[4]
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
            Path(argv[1]), argv[2], argv[3], allowed[signal_name]
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
