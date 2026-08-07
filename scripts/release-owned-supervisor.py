#!/usr/bin/env python3
"""Bounded registered supervisor for one release-gate host command."""

from __future__ import annotations

import errno
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


requested_signal: int | None = None


def request_stop(signal_number: int, _frame: object) -> None:
    global requested_signal
    if signal_number in (signal.SIGINT, signal.SIGHUP):
        requested_signal = signal.SIGTERM
    else:
        requested_signal = signal_number


def await_start(control_path: Path, timeout_seconds: float = 5.0) -> bool:
    descriptor = os.open(control_path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        deadline = time.monotonic() + timeout_seconds
        while time.monotonic() < deadline:
            os.lseek(descriptor, 0, os.SEEK_SET)
            command = os.read(descriptor, 32).split(b"\n", 1)[0]
            if command:
                return command == b"start"
            time.sleep(0.01)
        return False
    finally:
        os.close(descriptor)


def signal_child(pidfd: int, signal_number: int) -> bool:
    try:
        signal.pidfd_send_signal(pidfd, signal_number)
        return True
    except ProcessLookupError:
        return False
    except OSError as error:
        if error.errno == errno.ESRCH:
            return False
        raise


def supervise(command: list[str]) -> int:
    process = subprocess.Popen(command)
    try:
        pidfd = os.pidfd_open(process.pid, 0)
    except OSError:
        # Popen is the authoritative direct-child handle. If pidfd allocation
        # itself fails, do not use a separately inspected numeric PID.
        process.terminate()
        try:
            return process.wait(timeout=1.0)
        except subprocess.TimeoutExpired:
            process.kill()
            return process.wait(timeout=1.0)

    sent: int | None = None
    deadline = 0.0
    try:
        while True:
            status = process.poll()
            if status is not None:
                return status
            current = requested_signal
            if current is not None and sent is None:
                signal_child(pidfd, signal.SIGTERM)
                sent = current
                deadline = time.monotonic() + 0.75
            elif sent is not None and time.monotonic() >= deadline:
                signal_child(pidfd, signal.SIGKILL)
                status = process.wait()
                return 128 + sent if status < 0 else status
            time.sleep(0.02)
    finally:
        os.close(pidfd)


def main(argv: list[str]) -> int:
    if len(argv) < 5:
        print(
            "usage: release-owned-supervisor.py CONTROL RUN_ID STATE_ROOT COMMAND...",
            file=sys.stderr,
        )
        return 2
    control = Path(argv[1])
    run_id = argv[2]
    state_root = argv[3]
    if len(run_id) != 32 or not control.parent.samefile(state_root):
        print("invalid release supervisor ownership context", file=sys.stderr)
        return 2
    if not await_start(control):
        return 1
    return supervise(argv[4:])


if __name__ == "__main__":
    for handled in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(handled, request_stop)
    raise SystemExit(main(sys.argv))
