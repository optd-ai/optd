#!/usr/bin/env python3
"""Durable legacy-builder transcript capture and exact image cleanup authority."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import selectors
import signal
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any

FULL_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX_ID = re.compile(r"^[0-9a-f]{12,64}$")
STEP_LINE = re.compile(rb"^Step ([1-9][0-9]*)/([1-9][0-9]*) : (.+)\r?$")
RESULT_LINE = re.compile(rb"^ ---> ([0-9a-f]{12,64}|sha256:[0-9a-f]{64})\r?$")
SUCCESS_LINE = re.compile(rb"^Successfully built ([0-9a-f]{12,64}|sha256:[0-9a-f]{64})\r?$")
CONTROL_PREFIX = (b"Step ", b" ---> ", b"Successfully built ")
LABEL = "dev.operant.release-gate"
DIR_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK


@dataclass
class HeldFile:
    relative: str
    fd: int
    device: int
    inode: int
    mode: int


class TrustedState:
    """Descriptor-relative access to one canonical, private release state tree."""

    def __init__(self, supplied: pathlib.Path):
        canonical = pathlib.Path(os.path.abspath(supplied))
        if not supplied.is_absolute() or supplied != canonical:
            raise RuntimeError("state root is not an exact canonical absolute path")
        self.path = canonical
        self.root_fd = self._open_absolute(canonical)
        self.directories: dict[str, int] = {"": self.root_fd}
        self.files: list[HeldFile] = []
        self._check_dir("", self.root_fd, os.stat(canonical, follow_symlinks=False))

    @staticmethod
    def _open_absolute(path: pathlib.Path) -> int:
        fd = os.open("/", DIR_FLAGS)
        try:
            for component in path.parts[1:]:
                following = os.open(component, DIR_FLAGS, dir_fd=fd)
                os.close(fd)
                fd = following
            return fd
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _parts(relative: str) -> list[str]:
        path = pathlib.PurePosixPath(relative)
        if path.is_absolute() or not path.parts or any(part in ("", ".", "..") for part in path.parts):
            raise RuntimeError(f"unsafe state-relative path: {relative!r}")
        return list(path.parts)

    def _check_dir(self, relative: str, fd: int, entry: os.stat_result) -> None:
        opened = os.fstat(fd)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700
            or (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino)
        ):
            raise RuntimeError(f"unsafe private directory identity: {relative or 'state root'}")

    def directory(self, relative: str) -> int:
        if relative in self.directories:
            return self.directories[relative]
        parts = self._parts(relative)
        parent_rel = "/".join(parts[:-1])
        parent_fd = self.root_fd if not parent_rel else self.directory(parent_rel)
        fd = os.open(parts[-1], DIR_FLAGS, dir_fd=parent_fd)
        entry = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        self._check_dir(relative, fd, entry)
        self.directories[relative] = fd
        return fd

    def mkdir(self, relative: str) -> int:
        parts = self._parts(relative)
        parent_rel = "/".join(parts[:-1])
        parent_fd = self.root_fd if not parent_rel else self.directory(parent_rel)
        old_umask = os.umask(0o077)
        try:
            os.mkdir(parts[-1], 0o700, dir_fd=parent_fd)
        finally:
            os.umask(old_umask)
        os.fsync(parent_fd)
        return self.directory(relative)

    def hold(self, relative: str, expected_mode: int = 0o600, writable: bool = False) -> HeldFile:
        parts = self._parts(relative)
        parent_rel = "/".join(parts[:-1])
        parent_fd = self.root_fd if not parent_rel else self.directory(parent_rel)
        flags = FILE_FLAGS if not writable else os.O_RDWR | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK
        fd = os.open(parts[-1], flags, dir_fd=parent_fd)
        opened = os.fstat(fd)
        entry = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(opened.st_mode)
            or opened.st_nlink != 1
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != expected_mode
            or (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino)
        ):
            os.close(fd)
            raise RuntimeError(f"unsafe private regular file identity: {relative}")
        held = HeldFile(relative, fd, opened.st_dev, opened.st_ino, expected_mode)
        self.files.append(held)
        return held

    @staticmethod
    def bytes(held: HeldFile, maximum: int = 32 * 1024 * 1024) -> bytes:
        os.lseek(held.fd, 0, os.SEEK_SET)
        chunks: list[bytes] = []
        size = 0
        while True:
            chunk = os.read(held.fd, min(65536, maximum + 1 - size))
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            size += len(chunk)
            if size > maximum:
                raise RuntimeError(f"trusted file is unexpectedly large: {held.relative}")

    def text(self, relative: str, expected_mode: int = 0o600) -> str:
        return self.bytes(self.hold(relative, expected_mode)).decode()

    def json(self, relative: str) -> Any:
        return json.loads(self.text(relative))

    def create_bytes(self, relative: str, data: bytes, mode: int = 0o600) -> HeldFile:
        parts = self._parts(relative)
        parent_rel = "/".join(parts[:-1])
        parent_fd = self.root_fd if not parent_rel else self.directory(parent_rel)
        old_umask = os.umask(0o077)
        try:
            fd = os.open(
                parts[-1],
                os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW,
                mode,
                dir_fd=parent_fd,
            )
        finally:
            os.umask(old_umask)
        try:
            os.fchmod(fd, mode)
            view = memoryview(data)
            while view:
                written = os.write(fd, view)
                if written <= 0:
                    raise RuntimeError(f"could not write trusted file: {relative}")
                view = view[written:]
            os.fsync(fd)
            opened = os.fstat(fd)
            entry = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or opened.st_uid != os.geteuid()
                or stat.S_IMODE(opened.st_mode) != mode
                or (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino)
            ):
                raise RuntimeError(f"created trusted file changed identity: {relative}")
            os.fsync(parent_fd)
            held = HeldFile(relative, fd, opened.st_dev, opened.st_ino, mode)
            self.files.append(held)
            return held
        except BaseException:
            os.close(fd)
            try:
                os.unlink(parts[-1], dir_fd=parent_fd)
            except OSError:
                pass
            raise

    def create_json(self, relative: str, value: Any) -> HeldFile:
        data = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
        return self.create_bytes(relative, data)

    def append(self, relative: str, data: bytes) -> None:
        held = self.hold(relative, writable=True)
        os.lseek(held.fd, 0, os.SEEK_END)
        view = memoryview(data)
        while view:
            written = os.write(held.fd, view)
            if written <= 0:
                raise RuntimeError(f"could not append trusted file: {relative}")
            view = view[written:]
        os.fsync(held.fd)
        self.revalidate()

    def revalidate(self) -> None:
        root_entry = os.stat(self.path, follow_symlinks=False)
        self._check_dir("", self.root_fd, root_entry)
        for relative, fd in self.directories.items():
            if not relative:
                continue
            parts = self._parts(relative)
            parent_rel = "/".join(parts[:-1])
            parent_fd = self.root_fd if not parent_rel else self.directories[parent_rel]
            self._check_dir(relative, fd, os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False))
        for held in self.files:
            parts = self._parts(held.relative)
            parent_rel = "/".join(parts[:-1])
            parent_fd = self.root_fd if not parent_rel else self.directories[parent_rel]
            opened = os.fstat(held.fd)
            entry = os.stat(parts[-1], dir_fd=parent_fd, follow_symlinks=False)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_nlink != 1
                or opened.st_uid != os.geteuid()
                or stat.S_IMODE(opened.st_mode) != held.mode
                or (opened.st_dev, opened.st_ino) != (held.device, held.inode)
                or (opened.st_dev, opened.st_ino) != (entry.st_dev, entry.st_ino)
            ):
                raise RuntimeError(f"trusted file path identity changed: {held.relative}")
        for fd in set(self.directories.values()):
            os.fsync(fd)

    def close(self) -> None:
        for held in self.files:
            try:
                os.close(held.fd)
            except OSError:
                pass
        for fd in set(self.directories.values()):
            try:
                os.close(fd)
            except OSError:
                pass
        self.files.clear()
        self.directories.clear()


def state_relative(state: pathlib.Path, supplied: str) -> str:
    candidate = pathlib.Path(supplied)
    canonical = pathlib.Path(os.path.abspath(candidate))
    if not candidate.is_absolute() or candidate != canonical:
        raise RuntimeError(f"path is not exact canonical absolute: {supplied}")
    try:
        return canonical.relative_to(state).as_posix()
    except ValueError as error:
        raise RuntimeError(f"path is outside trusted state root: {supplied}") from error


def command_pin_dockerfile(args: argparse.Namespace) -> int:
    destination = pathlib.Path(args.destination)
    state = TrustedState(destination.parent)
    source_rel = state_relative(state.path, args.source)
    destination_rel = state_relative(state.path, args.destination)
    try:
        source = state.hold(source_rel, 0o600)
    except RuntimeError:
        source = state.hold(source_rel, 0o644)
    data = state.bytes(source)
    if hashlib.sha256(data).hexdigest() != args.sha256:
        raise RuntimeError("Dockerfile source differs from immutable commit digest")
    state.create_bytes(destination_rel, data, 0o400)
    state.revalidate()
    state.close()
    return 0


def command_capture(args: argparse.Namespace) -> int:
    transcript = pathlib.Path(args.transcript)
    state_path = transcript.parent
    state = TrustedState(state_path)
    transcript_rel = transcript.name
    if transcript.parent != state.path or "/" in transcript_rel or transcript_rel in ("", ".", ".."):
        raise RuntimeError("transcript is not a direct trusted state child")
    state.mkdir(transcript_rel)
    stdout = state.create_bytes(f"{transcript_rel}/stdout", b"")
    stderr = state.create_bytes(f"{transcript_rel}/stderr", b"")
    started_ns = time.time_ns()
    state.create_json(
        f"{transcript_rel}/invocation.json",
        {"argv": args.command, "started_ns": started_ns, "stdin": args.stdin},
    )

    child: subprocess.Popen[bytes] | None = None
    forwarded_signal = 0

    def forward(number: int, _frame: Any) -> None:
        nonlocal forwarded_signal
        if not forwarded_signal:
            forwarded_signal = number
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, number)
            except ProcessLookupError:
                pass

    old_handlers = {
        number: signal.signal(number, forward)
        for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }
    returncode = 125
    try:
        stdin_rel = state_relative(state.path, args.stdin)
        stdin_held = state.hold(stdin_rel, 0o400)
        with os.fdopen(os.dup(stdin_held.fd), "rb") as input_stream:
            child = subprocess.Popen(
                args.command,
                stdin=input_stream,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            assert child.stdout is not None and child.stderr is not None
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ, (stdout.fd, sys.stdout.buffer))
            selector.register(child.stderr, selectors.EVENT_READ, (stderr.fd, sys.stderr.buffer))
            while selector.get_map():
                for key, _ in selector.select():
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    capture_fd, display = key.data
                    view = memoryview(chunk)
                    while view:
                        written = os.write(capture_fd, view)
                        if written <= 0:
                            raise RuntimeError("could not durably capture build output")
                        view = view[written:]
                    display.write(chunk)
                    display.flush()
            returncode = child.wait()
    except BaseException as error:
        try:
            state.create_json(f"{transcript_rel}/capture-error.json", {"error": repr(error)})
        finally:
            raise
    finally:
        for number, handler in old_handlers.items():
            signal.signal(number, handler)
        os.fsync(stdout.fd)
        os.fsync(stderr.fd)
        finished_ns = time.time_ns()
        terminating_signal = forwarded_signal or (-returncode if returncode < 0 else 0)
        status = 128 + terminating_signal if terminating_signal else returncode
        state.create_json(
            f"{transcript_rel}/result.json",
            {
                "finished_ns": finished_ns,
                "returncode": returncode,
                "signal": terminating_signal,
                "status": status,
                "stderr_sha256": hashlib.sha256(state.bytes(stderr)).hexdigest(),
                "stdout_sha256": hashlib.sha256(state.bytes(stdout)).hexdigest(),
            },
        )
        state.revalidate()
        state.close()
    return status


def docker_output(argv: list[str]) -> bytes:
    result = subprocess.run(["docker", *argv], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        raise RuntimeError(
            f"docker {' '.join(argv)} failed ({result.returncode}): "
            + result.stderr.decode(errors="replace").strip()
        )
    return result.stdout


def exact_images() -> list[str]:
    values = docker_output(["image", "ls", "--all", "--no-trunc", "--quiet"]).decode().splitlines()
    if any(not FULL_ID.fullmatch(value) for value in values):
        raise RuntimeError(f"invalid full image inventory: {values!r}")
    return sorted(set(values))


def inspect_image(identity: str) -> dict[str, Any]:
    value = json.loads(docker_output(["image", "inspect", identity]))
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RuntimeError(f"ambiguous image inspection for {identity}")
    item = value[0]
    if item.get("Id") != identity:
        raise RuntimeError(f"image identity drift: expected {identity}, got {item.get('Id')}")
    return item


def image_history(identity: str) -> list[dict[str, Any]]:
    lines = docker_output(
        ["image", "history", "--no-trunc", "--format", "{{json .}}", identity]
    ).decode().splitlines()
    try:
        values = [json.loads(line) for line in lines]
    except json.JSONDecodeError as error:
        raise RuntimeError(f"invalid structured image history: {identity}") from error
    if any(not isinstance(value, dict) for value in values):
        raise RuntimeError(f"invalid structured image history records: {identity}")
    return values


def parse_created(value: Any) -> int:
    if not isinstance(value, str):
        raise RuntimeError(f"missing image creation time: {value!r}")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    return int(dt.datetime.fromisoformat(normalized).timestamp() * 1_000_000_000)


def normalize_space(value: str) -> str:
    return " ".join(value.strip().split())


def dockerfile_steps(data: bytes) -> list[str]:
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RuntimeError("immutable Dockerfile is not UTF-8") from error
    logical: list[str] = []
    pending = ""
    for physical in text.splitlines():
        stripped = physical.strip()
        if not pending and (not stripped or stripped.startswith("#")):
            continue
        continued = physical.rstrip().endswith("\\")
        piece = physical.rstrip()
        if continued:
            piece = piece[:-1]
        pending += (" " if pending else "") + piece.strip()
        if not continued:
            if pending:
                logical.append(normalize_space(pending))
            pending = ""
    if pending:
        raise RuntimeError("immutable Dockerfile has an unterminated continuation")
    if not logical:
        raise RuntimeError("immutable Dockerfile has no build Steps")
    return logical


@dataclass
class StepFrame:
    number: int
    instruction: str
    token: str


def parse_protocol(stdout: bytes, stderr: bytes, expected: list[str], status: int) -> tuple[list[StepFrame], str]:
    errors: list[str] = []
    for line in stderr.splitlines():
        if line.startswith(CONTROL_PREFIX):
            errors.append(f"legacy engine control line appeared on stderr: {line!r}")
    frames: list[StepFrame] = []
    current_number = 0
    current_instruction = ""
    current_results: list[str] = []
    success_tokens: list[str] = []

    def finish_frame() -> None:
        nonlocal current_number, current_instruction, current_results
        if not current_number:
            return
        before_first_stage = not any(
            frame.instruction.upper().startswith("FROM ") for frame in frames
        )
        allowed_empty = (
            before_first_stage and current_instruction.upper().startswith("ARG ")
        ) or current_instruction.upper().startswith("FROM SCRATCH")
        if len(current_results) == 1:
            frames.append(StepFrame(current_number, current_instruction, current_results[0]))
        elif not current_results and allowed_empty:
            # The legacy daemon emits no result ID for global ARG and emits an
            # explicitly empty result for FROM scratch. These completed frames
            # authorize no image identity.
            frames.append(StepFrame(current_number, current_instruction, ""))
        else:
            errors.append(
                f"Step {current_number}/{len(expected)} has {len(current_results)} engine result IDs"
            )
        current_number = 0
        current_instruction = ""
        current_results = []

    for line in stdout.splitlines():
        step = STEP_LINE.fullmatch(line)
        result = RESULT_LINE.fullmatch(line)
        success = SUCCESS_LINE.fullmatch(line)
        if step:
            finish_frame()
            number, total = int(step.group(1)), int(step.group(2))
            instruction = normalize_space(step.group(3).decode())
            if total != len(expected) or number != len(frames) + 1 or number > len(expected):
                errors.append(f"non-monotonic or wrong-total legacy Step frame: {line!r}")
            elif instruction != expected[number - 1]:
                errors.append(
                    f"legacy Step {number} differs from immutable Dockerfile: {instruction!r} != {expected[number - 1]!r}"
                )
            current_number, current_instruction = number, instruction
            continue
        if result:
            token = result.group(1).decode()
            if not current_number:
                errors.append(f"engine result ID outside a Step frame: {token}")
            else:
                current_results.append(token)
            continue
        if success:
            finish_frame()
            success_tokens.append(success.group(1).decode())
            continue
        if re.fullmatch(rb" ---> (?:Running in|Removed intermediate container) [0-9a-f]{12}\r?", line):
            continue
        if line == b" ---> " and current_instruction.upper().startswith("FROM SCRATCH"):
            continue
        if line.startswith(CONTROL_PREFIX):
            errors.append(f"malformed or spoofed legacy engine control line: {line!r}")
    finish_frame()
    completed = len(frames)
    if errors:
        raise RuntimeError("; ".join(errors))
    if [frame.number for frame in frames] != list(range(1, completed + 1)):
        raise RuntimeError("legacy Step sequence is incomplete or ambiguous")
    if status == 0:
        if completed != len(expected):
            raise RuntimeError(f"successful legacy build completed only {completed}/{len(expected)} Steps")
        if len(success_tokens) != 1:
            raise RuntimeError("successful legacy build does not have exactly one final success ID")
        return frames, success_tokens[0]
    if success_tokens:
        raise RuntimeError("failed or signaled build emitted a Successfully built line")
    return frames, ""


def resolve_token(token: str, inventory: list[str]) -> str:
    if token.startswith("sha256:"):
        matches = [identity for identity in inventory if identity == token]
    else:
        if not HEX_ID.fullmatch(token):
            raise RuntimeError(f"invalid builder engine image ID: {token!r}")
        matches = [identity for identity in inventory if identity[7:].startswith(token)]
    if len(matches) != 1:
        raise RuntimeError(f"builder engine image ID is ambiguous or absent: {token} matches={matches!r}")
    return matches[0]


def image_labels(item: dict[str, Any]) -> dict[str, str]:
    config = item.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    return labels if isinstance(labels, dict) else {}


def instruction_matches_created_by(instruction: str, created_by: Any) -> bool:
    if not isinstance(created_by, str) or not created_by:
        return False
    expected = normalize_space(instruction)
    keyword, _, body = expected.partition(" ")
    actual = normalize_space(created_by)
    if "#(nop)" in actual:
        actual = normalize_space(actual.split("#(nop)", 1)[1])
    elif keyword == "RUN" and " -c " in actual:
        return normalize_space(actual.split(" -c ", 1)[1]) == normalize_space(body)
    actual_keyword, _, actual_body = actual.partition(" ")
    if actual_keyword.upper() != keyword.upper():
        return False
    upper = keyword.upper()
    if upper == "COPY":
        destination = normalize_space(body).rsplit(" ", 1)[-1]
        return normalize_space(actual_body).endswith(destination) or f" in {destination}" in actual_body
    if upper in ("ENTRYPOINT", "CMD", "VOLUME") and body.startswith("["):
        try:
            values = json.loads(body)
        except json.JSONDecodeError:
            return False
        if not isinstance(values, list) or any(not isinstance(value, str) for value in values):
            return False
        if upper == "VOLUME":
            expected_actual = "[" + " ".join(values) + "]"
        else:
            expected_actual = "[" + " ".join(json.dumps(value) for value in values) + "]"
        return actual_body == expected_actual
    if upper == "HEALTHCHECK":
        match = re.fullmatch(
            r"--interval=([^ ]+) --timeout=([^ ]+) --start-period=([^ ]+) --retries=([0-9]+) CMD (\[.*\])",
            body,
        )
        if not match:
            return False
        try:
            command = json.loads(match.group(5))
        except json.JSONDecodeError:
            return False
        if not isinstance(command, list) or any(not isinstance(value, str) for value in command):
            return False
        command.insert(0, "CMD")
        expected_actual = (
            "&{["
            + " ".join(json.dumps(value) for value in command)
            + f'] "{match.group(1)}" "{match.group(2)}" "{match.group(3)}" "0s" '
            + repr(chr(int(match.group(4))))
            + "}"
        )
        return actual_body == expected_actual
    if upper in ("ARG", "LABEL", "ENV") and "$" in body:
        # Build arguments are expanded by the daemon in CreatedBy. Exact raw
        # instruction ownership is already fixed by the Step frame; the exact
        # expanded CreatedBy value is retained and rechecked before every rm.
        return True
    return normalize_space(actual_body) == normalize_space(body)


def load_snapshot(text: str, description: str) -> list[str]:
    values = text.splitlines()
    if values != sorted(set(values)) or any(not FULL_ID.fullmatch(value) for value in values):
        raise RuntimeError(f"{description} is not an exact sorted full-ID set")
    return values


def relative_args(args: argparse.Namespace, state: TrustedState) -> dict[str, str]:
    return {
        name: state_relative(state.path, getattr(args, name.replace("-", "_")))
        for name in ("baseline", "post", "transcript", "registry", "dockerfile")
        if hasattr(args, name.replace("-", "_")) and getattr(args, name.replace("-", "_"), None)
    }


def command_status(args: argparse.Namespace) -> int:
    transcript = pathlib.Path(args.transcript)
    state = TrustedState(transcript.parent)
    rel = state_relative(state.path, str(transcript))
    state.directory(rel)
    result = state.json(f"{rel}/result.json")
    status = int(result["status"])
    signal_number = int(result["signal"])
    returncode = int(result["returncode"])
    expected = 128 + signal_number if signal_number else (128 - returncode if returncode < 0 else returncode)
    if status != expected or not 0 <= status <= 255:
        raise RuntimeError("durable capture result has inconsistent status/signal fields")
    state.revalidate()
    print(status)
    state.close()
    return 0


def command_final_id(args: argparse.Namespace) -> int:
    registry_path = pathlib.Path(args.registry)
    state = TrustedState(registry_path.parent)
    registry_rel = state_relative(state.path, args.registry)
    state.directory(registry_rel)
    authority = state.json(f"{registry_rel}/image-authority.json")
    report = state.json(f"{registry_rel}/image-accounting.json")
    if authority.get("run_id") != args.run_id or authority.get("final_id") != report.get("final_id"):
        raise RuntimeError("final image identity disagrees with trusted authority")
    final_id = authority.get("final_id")
    if final_id and not FULL_ID.fullmatch(final_id):
        raise RuntimeError("trusted final image identity is malformed")
    state.revalidate()
    print(final_id or "")
    state.close()
    return 0


def command_account(args: argparse.Namespace) -> int:
    registry_path = pathlib.Path(args.registry)
    state = TrustedState(registry_path.parent)
    paths = relative_args(args, state)
    registry_rel = paths["registry"]
    transcript_rel = paths["transcript"]
    state.directory(registry_rel)
    state.directory(f"{registry_rel}/image-evidence")
    state.directory(transcript_rel)
    baseline = load_snapshot(state.text(paths["baseline"]), "baseline image snapshot")
    post = load_snapshot(state.text(paths["post"]), "post-build image snapshot")
    dockerfile_data = state.bytes(state.hold(paths["dockerfile"], 0o400))
    invocation = state.json(f"{transcript_rel}/invocation.json")
    result = state.json(f"{transcript_rel}/result.json")
    stdout = state.bytes(state.hold(f"{transcript_rel}/stdout"))
    stderr = state.bytes(state.hold(f"{transcript_rel}/stderr"))
    if hashlib.sha256(stdout).hexdigest() != result.get("stdout_sha256") or hashlib.sha256(stderr).hexdigest() != result.get("stderr_sha256"):
        raise RuntimeError("durable transcript hash mismatch")
    status = int(result["status"])
    expected_steps = dockerfile_steps(dockerfile_data) + [f"LABEL {LABEL}={args.run_id}"]
    frames, success_token = parse_protocol(stdout, stderr, expected_steps, status)
    if not set(baseline) <= set(post):
        raise RuntimeError(f"baseline images disappeared during build: {sorted(set(baseline)-set(post))!r}")
    delta = set(post) - set(baseline)
    resolved_frames = [
        (frame, resolve_token(frame.token, post)) for frame in frames if frame.token
    ]
    if len({frame.number for frame, _ in resolved_frames}) != len(resolved_frames):
        raise RuntimeError("duplicate completed legacy Step frame")
    success_id = resolve_token(success_token, post) if success_token else ""
    if success_id and (not resolved_frames or success_id != resolved_frames[-1][1]):
        raise RuntimeError("final success ID does not equal the final Step result ID")
    result_ids = {identity for _, identity in resolved_frames}
    if not delta <= result_ids:
        raise RuntimeError(f"post-build delta has IDs not owned by completed Steps: {sorted(delta-result_ids)!r}")

    started_ns = int(invocation["started_ns"])
    finished_ns = int(result["finished_ns"])
    inspected = {identity: inspect_image(identity) for identity in sorted(delta)}
    histories = {identity: image_history(identity) for identity in sorted(delta)}
    frame_for_id: dict[str, StepFrame] = {}
    prior_by_frame: dict[int, str] = {}
    stage_prior = ""
    for frame in frames:
        instruction = expected_steps[frame.number - 1]
        if not frame.token:
            if instruction.upper().startswith("FROM SCRATCH"):
                stage_prior = ""
            continue
        identity = resolve_token(frame.token, post)
        if instruction.upper().startswith("FROM "):
            stage_prior = identity
            continue
        prior_by_frame[frame.number] = stage_prior
        if identity in delta:
            if identity in frame_for_id:
                raise RuntimeError(f"delta image is the result of multiple completed Steps: {identity}")
            frame_for_id[identity] = frame
        stage_prior = identity
    if set(frame_for_id) != delta:
        raise RuntimeError("each delta image must correspond to exactly one completed Dockerfile Step")

    evidence_values: dict[str, dict[str, Any]] = {}
    for identity in sorted(delta):
        item = inspected[identity]
        frame = frame_for_id[identity]
        instruction = expected_steps[frame.number - 1]
        created_ns = parse_created(item.get("Created"))
        if not started_ns <= created_ns <= finished_ns:
            raise RuntimeError(f"image creation is outside build window: {identity}")
        parent = item.get("Parent") or ""
        expected_parent = prior_by_frame.get(frame.number, "")
        if parent != expected_parent and not (
            not expected_parent and parent in set(baseline)
        ):
            raise RuntimeError(
                f"image parent differs from immutable stage graph: {identity} expected={expected_parent!r} actual={parent!r}"
            )
        history = histories[identity]
        if not history or history[0].get("ID") != identity:
            raise RuntimeError(f"image history does not begin with exact image ID: {identity}")
        created_by = history[0].get("CreatedBy")
        if not instruction_matches_created_by(instruction, created_by):
            raise RuntimeError(
                f"image CreatedBy differs from immutable Dockerfile Step {frame.number}: {identity} {created_by!r}"
            )
        evidence_values[identity] = {
            "created": item.get("Created"),
            "created_by": created_by,
            "dockerfile_sha256": hashlib.sha256(dockerfile_data).hexdigest(),
            "id": identity,
            "instruction": instruction,
            "labels": image_labels(item),
            "parent": parent,
            "role": "intermediate",
            "run_id": args.run_id,
            "stderr_sha256": result["stderr_sha256"],
            "stdout_sha256": result["stdout_sha256"],
            "step": frame.number,
            "tag": "",
        }

    final_id = ""
    if status == 0:
        final_id = docker_output(["image", "inspect", args.tag, "--format", "{{.Id}}"]).decode().strip()
        if final_id != success_id or final_id not in delta:
            raise RuntimeError("successful tag, success line, and final Step do not name one proven delta ID")
        if image_labels(inspected[final_id]).get(LABEL) != args.run_id:
            raise RuntimeError(f"final image run label mismatch: {final_id}")
        evidence_values[final_id]["role"] = "final"
        evidence_values[final_id]["tag"] = args.tag
    elif success_id:
        raise RuntimeError("non-successful build cannot have final image authority")

    report = {
        "baseline": baseline,
        "delta": sorted(delta),
        "dockerfile_sha256": hashlib.sha256(dockerfile_data).hexdigest(),
        "errors": [],
        "final_id": final_id,
        "proven": sorted(delta),
        "status": status,
        "steps_completed": len(frames),
        "steps_total": len(expected_steps),
    }
    for identity, evidence in evidence_values.items():
        state.create_json(f"{registry_rel}/image-evidence/{identity[7:]}.json", evidence)
        role = evidence["role"]
        state.append(f"{registry_rel}/images", f"{identity}\t{role}\n".encode())
    state.create_json(f"{registry_rel}/image-accounting.json", report)
    state.create_json(
        f"{registry_rel}/image-authority.json",
        {"final_id": final_id, "ids": sorted(delta), "run_id": args.run_id, "status": status},
    )
    state.revalidate()
    state.close()
    return 0


def normalized_list(value: Any) -> list[str]:
    return [] if value is None else value


def load_cleanup_authority(args: argparse.Namespace, state: TrustedState) -> tuple[list[str], set[str], dict[str, dict[str, Any]], dict[str, Any]]:
    registry_rel = state_relative(state.path, args.registry)
    transcript_rel = state_relative(state.path, args.transcript)
    baseline_rel = state_relative(state.path, args.baseline)
    dockerfile_rel = state_relative(state.path, args.dockerfile)
    state.directory(registry_rel)
    state.directory(f"{registry_rel}/image-evidence")
    state.directory(transcript_rel)
    baseline = load_snapshot(state.text(baseline_rel), "baseline image snapshot")
    authority = state.json(f"{registry_rel}/image-authority.json")
    report = state.json(f"{registry_rel}/image-accounting.json")
    result = state.json(f"{transcript_rel}/result.json")
    stdout = state.bytes(state.hold(f"{transcript_rel}/stdout"))
    stderr = state.bytes(state.hold(f"{transcript_rel}/stderr"))
    dockerfile_data = state.bytes(state.hold(dockerfile_rel, 0o400))
    if authority.get("run_id") != args.run_id or authority.get("status") != result.get("status"):
        raise RuntimeError("image authority run/status mismatch")
    registered = authority.get("ids")
    if not isinstance(registered, list) or registered != sorted(set(registered)) or any(not FULL_ID.fullmatch(value) for value in registered):
        raise RuntimeError("image authority has an invalid exact ID set")
    if report.get("proven") != registered or report.get("errors") != [] or report.get("baseline") != baseline:
        raise RuntimeError("image authority disagrees with durable accounting/baseline")
    if report.get("dockerfile_sha256") != hashlib.sha256(dockerfile_data).hexdigest():
        raise RuntimeError("immutable Dockerfile differs from accounting authority")
    if hashlib.sha256(stdout).hexdigest() != result.get("stdout_sha256") or hashlib.sha256(stderr).hexdigest() != result.get("stderr_sha256"):
        raise RuntimeError("transcript differs from accounting authority")
    if authority.get("final_id") != args.final_id:
        raise RuntimeError("shell final image ID differs from authority")
    records = [line.split("\t") for line in state.text(f"{registry_rel}/images").splitlines()]
    expected_records = [[f"pending:{args.tag}", args.tag]] + [
        [identity, "final" if identity == args.final_id else "intermediate"] for identity in registered
    ]
    if sorted(records) != sorted(expected_records):
        raise RuntimeError("durable image registry disagrees with image authority")
    evidence: dict[str, dict[str, Any]] = {}
    for identity in registered:
        item = state.json(f"{registry_rel}/image-evidence/{identity[7:]}.json")
        if item.get("id") != identity or item.get("run_id") != args.run_id:
            raise RuntimeError(f"image evidence identity mismatch: {identity}")
        evidence[identity] = item
    if set(baseline) & set(registered):
        raise RuntimeError("baseline image can never be an action candidate")
    return registered, set(baseline), evidence, result


def validate_cleanup_world(
    args: argparse.Namespace,
    state: TrustedState,
    registered: list[str],
    baseline: set[str],
    evidence: dict[str, dict[str, Any]],
    removed: set[str],
) -> dict[str, dict[str, Any]]:
    state.revalidate()
    current = exact_images()
    expected = baseline | (set(registered) - removed)
    if set(current) != expected:
        raise RuntimeError(
            f"concurrent image mutation before exact removal: added={sorted(set(current)-expected)!r} missing={sorted(expected-set(current))!r}"
        )
    inspected = {identity: inspect_image(identity) for identity in current}
    for identity in set(registered) - removed:
        proof = evidence[identity]
        actual = inspected[identity]
        history = image_history(identity)
        if (
            actual.get("Parent", "") != proof.get("parent", "")
            or actual.get("Created") != proof.get("created")
            or not history
            or history[0].get("ID") != identity
            or history[0].get("CreatedBy") != proof.get("created_by")
        ):
            raise RuntimeError(f"image parent/history/creation evidence changed: {identity}")
        tags = normalized_list(actual.get("RepoTags"))
        digests = normalized_list(actual.get("RepoDigests"))
        if digests:
            raise RuntimeError(f"registered image gained RepoDigests: {identity} {digests!r}")
        if proof.get("role") == "final":
            if identity != args.final_id or image_labels(actual).get(LABEL) != args.run_id or tags != [args.tag]:
                raise RuntimeError(f"final image identity/label/tags changed: {identity} {tags!r}")
            tag_id = docker_output(["image", "inspect", args.tag, "--format", "{{.Id}}"]).decode().strip()
            if tag_id != identity:
                raise RuntimeError(f"final image tag drifted: {args.tag} -> {tag_id}")
        elif proof.get("role") == "intermediate":
            if tags:
                raise RuntimeError(f"intermediate image gained tags: {identity} {tags!r}")
        else:
            raise RuntimeError(f"unknown registered image role: {identity}")
        references = docker_output(
            ["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", f"ancestor={identity}"]
        ).decode().splitlines()
        if references:
            raise RuntimeError(f"registered image has container references: {identity} {references!r}")
    for child_id, child in inspected.items():
        parent = child.get("Parent") or ""
        if parent in set(registered) - removed and child_id not in set(registered) - removed:
            raise RuntimeError(f"registered image has unexpected child: {parent} -> {child_id}")
    return inspected


def command_cleanup(args: argparse.Namespace) -> int:
    registry_path = pathlib.Path(args.registry)
    state = TrustedState(registry_path.parent)
    registered, baseline, evidence, _result = load_cleanup_authority(args, state)
    depths: dict[str, int] = {}

    def depth(identity: str, visiting: set[str]) -> int:
        if identity in depths:
            return depths[identity]
        if identity in visiting:
            raise RuntimeError("registered image parent cycle")
        parent = evidence[identity].get("parent", "")
        value = 1 + depth(parent, visiting | {identity}) if parent in evidence else 0
        depths[identity] = value
        return value

    ordered = sorted(registered, key=lambda identity: (-depth(identity, set()), identity))
    removed: set[str] = set()
    # Complete preflight is performed in this process with every authority file
    # descriptor held. Immediately before every exact removal, the complete
    # inventory and every mutable Docker ownership relation are checked again.
    validate_cleanup_world(args, state, registered, baseline, evidence, removed)
    if args.dry_run:
        state.close()
        return 0
    for identity in ordered:
        validate_cleanup_world(args, state, registered, baseline, evidence, removed)
        if identity in baseline:
            raise RuntimeError(f"baseline image reached action set: {identity}")
        result = subprocess.run(
            ["docker", "image", "rm", "--no-prune", "--", identity],
            stdout=subprocess.DEVNULL,
        )
        if result.returncode != 0:
            raise RuntimeError(f"exact image removal failed ({result.returncode}): {identity}")
        removed.add(identity)
    state.revalidate()
    final = exact_images()
    if set(final) != baseline:
        raise RuntimeError("exact image baseline equality failed after partial/full cleanup")
    state.close()
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subparsers = root.add_subparsers(dest="action", required=True)
    pin = subparsers.add_parser("pin-dockerfile")
    pin.add_argument("--source", required=True)
    pin.add_argument("--destination", required=True)
    pin.add_argument("--sha256", required=True)
    pin.set_defaults(handler=command_pin_dockerfile)
    capture = subparsers.add_parser("capture")
    capture.add_argument("--transcript", required=True)
    capture.add_argument("--stdin", required=True)
    capture.add_argument("command", nargs=argparse.REMAINDER)
    capture.set_defaults(handler=command_capture)
    status_parser = subparsers.add_parser("status")
    status_parser.add_argument("--transcript", required=True)
    status_parser.set_defaults(handler=command_status)
    account = subparsers.add_parser("account")
    for name in ("baseline", "post", "transcript", "registry", "run-id", "tag", "dockerfile"):
        account.add_argument(f"--{name}", required=True)
    account.set_defaults(handler=command_account)
    final_id = subparsers.add_parser("final-id")
    final_id.add_argument("--registry", required=True)
    final_id.add_argument("--run-id", required=True)
    final_id.set_defaults(handler=command_final_id)
    cleanup = subparsers.add_parser("cleanup")
    for name in ("baseline", "registry", "transcript", "run-id", "tag", "final-id", "dockerfile"):
        cleanup.add_argument(f"--{name}", required=True)
    cleanup.add_argument("--dry-run", action="store_true")
    cleanup.set_defaults(handler=command_cleanup)
    return root


def main() -> int:
    args = parser().parse_args()
    if getattr(args, "command", None) and args.command[0] == "--":
        args.command = args.command[1:]
    if getattr(args, "command", None) == []:
        raise SystemExit("capture command is empty")
    try:
        return args.handler(args)
    except (OSError, RuntimeError, ValueError, KeyError, UnicodeDecodeError, json.JSONDecodeError) as error:
        print(f"release image accounting: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
