#!/usr/bin/env python3
"""Durable legacy-builder transcript capture and exact image ownership checks."""

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
import subprocess
import sys
import tempfile
import time
from typing import Any

FULL_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX_ID = re.compile(r"^[0-9a-f]{12,64}$")
LEGACY_LINES = (
    re.compile(rb"^ ---> ([0-9a-f]{12,64}|sha256:[0-9a-f]{64})\r?$"),
    re.compile(rb"^Successfully built ([0-9a-f]{12,64}|sha256:[0-9a-f]{64})\r?$"),
)
LABEL = "dev.operant.release-gate"


def fsync_directory(path: pathlib.Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path: pathlib.Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def durable_bytes(path: pathlib.Path) -> Any:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    return os.fdopen(descriptor, "wb", buffering=0)


def command_capture(args: argparse.Namespace) -> int:
    transcript = pathlib.Path(args.transcript)
    transcript.mkdir(mode=0o700, parents=True, exist_ok=False)
    fsync_directory(transcript.parent)
    stdout_path = transcript / "stdout"
    stderr_path = transcript / "stderr"
    stdout_file = durable_bytes(stdout_path)
    stderr_file = durable_bytes(stderr_path)
    started_ns = time.time_ns()
    atomic_json(
        transcript / "invocation.json",
        {"argv": args.command, "started_ns": started_ns, "stdin": args.stdin},
    )

    child: subprocess.Popen[bytes] | None = None
    forwarded_signal = 0

    def forward(number: int, _frame: Any) -> None:
        nonlocal forwarded_signal
        forwarded_signal = number
        if child is not None and child.poll() is None:
            try:
                os.killpg(child.pid, number)
            except ProcessLookupError:
                pass

    old_handlers = {number: signal.signal(number, forward) for number in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
    returncode = 125
    try:
        with open(args.stdin, "rb") as input_stream:
            child = subprocess.Popen(
                args.command,
                stdin=input_stream,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                start_new_session=True,
            )
            assert child.stdout is not None and child.stderr is not None
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ, (stdout_file, sys.stdout.buffer))
            selector.register(child.stderr, selectors.EVENT_READ, (stderr_file, sys.stderr.buffer))
            while selector.get_map():
                for key, _ in selector.select():
                    chunk = os.read(key.fileobj.fileno(), 65536)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    capture_stream, display_stream = key.data
                    capture_stream.write(chunk)
                    display_stream.write(chunk)
                    display_stream.flush()
            returncode = child.wait()
    except BaseException as error:
        atomic_json(transcript / "capture-error.json", {"error": repr(error)})
        raise
    finally:
        for number, handler in old_handlers.items():
            signal.signal(number, handler)
        for stream in (stdout_file, stderr_file):
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()
        finished_ns = time.time_ns()
        terminating_signal = -returncode if returncode < 0 else forwarded_signal
        status = 128 + terminating_signal if terminating_signal else returncode
        atomic_json(
            transcript / "result.json",
            {
                "finished_ns": finished_ns,
                "returncode": returncode,
                "signal": terminating_signal,
                "status": status,
                "stderr_sha256": hashlib.sha256(stderr_path.read_bytes()).hexdigest(),
                "stdout_sha256": hashlib.sha256(stdout_path.read_bytes()).hexdigest(),
            },
        )
    return 128 + (-returncode) if returncode < 0 else returncode


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
    raw = docker_output(["image", "inspect", identity])
    value = json.loads(raw)
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        raise RuntimeError(f"ambiguous image inspection for {identity}")
    item = value[0]
    if item.get("Id") != identity:
        raise RuntimeError(f"image identity drift: expected {identity}, got {item.get('Id')}")
    return item


def parse_created(value: Any) -> int:
    if not isinstance(value, str):
        raise RuntimeError(f"missing image creation time: {value!r}")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    return int(dt.datetime.fromisoformat(normalized).timestamp() * 1_000_000_000)


def emitted_tokens(transcript: pathlib.Path) -> list[str]:
    tokens: list[str] = []
    for name in ("stdout", "stderr"):
        for line in (transcript / name).read_bytes().splitlines():
            for pattern in LEGACY_LINES:
                match = pattern.fullmatch(line)
                if match:
                    tokens.append(match.group(1).decode())
                    break
    return tokens


def resolve_token(token: str, inventory: list[str]) -> str:
    if token.startswith("sha256:"):
        matches = [identity for identity in inventory if identity == token]
    else:
        if not HEX_ID.fullmatch(token):
            raise RuntimeError(f"invalid builder-emitted image ID: {token!r}")
        matches = [identity for identity in inventory if identity[7:].startswith(token)]
    if len(matches) != 1:
        raise RuntimeError(f"builder-emitted image ID is ambiguous or absent: {token} matches={matches!r}")
    return matches[0]


def image_labels(item: dict[str, Any]) -> dict[str, str]:
    config = item.get("Config")
    labels = config.get("Labels") if isinstance(config, dict) else None
    return labels if isinstance(labels, dict) else {}


def append_registry(registry: pathlib.Path, identity: str, role: str) -> None:
    with open(registry / "images", "a", encoding="utf-8") as stream:
        stream.write(f"{identity}\t{role}\n")
        stream.flush()
        os.fsync(stream.fileno())
    fsync_directory(registry)


def command_account(args: argparse.Namespace) -> int:
    baseline = pathlib.Path(args.baseline).read_text().splitlines()
    post = pathlib.Path(args.post).read_text().splitlines()
    if baseline != sorted(set(baseline)) or post != sorted(set(post)):
        raise RuntimeError("image snapshots are not exact sorted sets")
    if any(not FULL_ID.fullmatch(value) for value in baseline + post):
        raise RuntimeError("image snapshots contain non-full IDs")
    baseline_set, post_set = set(baseline), set(post)
    if not baseline_set <= post_set:
        raise RuntimeError(f"baseline images disappeared during build: {sorted(baseline_set - post_set)!r}")
    delta = post_set - baseline_set
    transcript = pathlib.Path(args.transcript)
    invocation = json.loads((transcript / "invocation.json").read_text())
    result = json.loads((transcript / "result.json").read_text())
    tokens = emitted_tokens(transcript)
    resolved: set[str] = set()
    errors: list[str] = []
    for token in tokens:
        try:
            resolved.add(resolve_token(token, post))
        except RuntimeError as error:
            errors.append(str(error))

    inspected: dict[str, dict[str, Any]] = {}
    for identity in sorted(delta):
        try:
            inspected[identity] = inspect_image(identity)
        except (RuntimeError, json.JSONDecodeError) as error:
            errors.append(str(error))
    started_ns = int(invocation["started_ns"])
    finished_ns = int(result["finished_ns"])
    proven: set[str] = set()
    for identity, item in inspected.items():
        if identity not in resolved:
            errors.append(f"post-build image was not emitted by the legacy builder: {identity}")
            continue
        try:
            created_ns = parse_created(item.get("Created"))
        except RuntimeError as error:
            errors.append(f"{identity}: {error}")
            continue
        if not started_ns <= created_ns <= finished_ns:
            errors.append(
                f"image creation is outside the build window: {identity} created={created_ns} window={started_ns}..{finished_ns}"
            )
            continue
        parent = item.get("Parent") or ""
        if parent and (not FULL_ID.fullmatch(parent) or parent not in post_set):
            errors.append(f"image parent is absent or not exact: {identity} parent={parent!r}")
            continue
        proven.add(identity)

    ancestors = set(proven)
    frontier = list(proven)
    while frontier:
        identity = frontier.pop()
        parent = (inspected.get(identity) or {}).get("Parent") or ""
        if parent and parent not in ancestors:
            ancestors.add(parent)
            if parent in inspected:
                frontier.append(parent)
    for identity in sorted(resolved - delta):
        if identity not in baseline_set or identity not in ancestors:
            errors.append(f"builder-emitted non-delta image is not a baseline ancestor: {identity}")

    final_id = ""
    try:
        final_id = docker_output(["image", "inspect", args.tag, "--format", "{{.Id}}"]).decode().strip()
    except RuntimeError:
        if int(result["status"]) == 0:
            errors.append("successful build did not publish its exact final tag")
    if final_id:
        if not FULL_ID.fullmatch(final_id) or final_id not in proven:
            errors.append(f"final image is not a proven build delta: {final_id}")
        else:
            final = inspected[final_id]
            if image_labels(final).get(LABEL) != args.run_id:
                errors.append(f"final image run label mismatch: {final_id}")
    if int(result["status"]) == 0 and not final_id:
        errors.append("successful build has no final image")

    evidence_dir = pathlib.Path(args.registry) / "image-evidence"
    evidence_dir.mkdir(mode=0o700, exist_ok=True)
    fsync_directory(evidence_dir.parent)
    for identity in sorted(proven):
        item = inspected[identity]
        role = "final" if identity == final_id else "intermediate"
        evidence = {
            "created": item.get("Created"),
            "id": identity,
            "labels": image_labels(item),
            "parent": item.get("Parent") or "",
            "role": role,
            "run_id": args.run_id,
            "stderr_sha256": result["stderr_sha256"],
            "stdout_sha256": result["stdout_sha256"],
            "tag": args.tag if role == "final" else "",
        }
        atomic_json(evidence_dir / f"{identity[7:]}.json", evidence)
        append_registry(pathlib.Path(args.registry), identity, role)

    history: list[str] | None = None
    if final_id and final_id in proven:
        try:
            history = docker_output(["image", "history", "--no-trunc", "--quiet", final_id]).decode().splitlines()
            invalid_history = [value for value in history if value != "<missing>" and value not in post_set]
            if invalid_history:
                errors.append(f"final image history contains unknown IDs: {invalid_history!r}")
        except RuntimeError:
            history = None

    report = {
        "baseline": baseline,
        "delta": sorted(delta),
        "errors": errors,
        "final_id": final_id,
        "history": history,
        "proven": sorted(proven),
        "resolved_emitted": sorted(resolved),
        "status": int(result["status"]),
        "tokens": tokens,
    }
    registry = pathlib.Path(args.registry)
    atomic_json(registry / "image-accounting.json", report)
    if errors or proven != delta:
        return 1
    atomic_json(registry / "image-authority.json", {"final_id": final_id, "ids": sorted(proven), "run_id": args.run_id})
    return 0


def normalized_list(value: Any) -> list[str]:
    return [] if value is None else value


def command_preflight(args: argparse.Namespace) -> int:
    registry = pathlib.Path(args.registry)
    authority = json.loads((registry / "image-authority.json").read_text())
    report = json.loads((registry / "image-accounting.json").read_text())
    if authority.get("run_id") != args.run_id:
        raise RuntimeError("image authority run ID mismatch")
    registered = authority.get("ids")
    if not isinstance(registered, list) or len(registered) != len(set(registered)):
        raise RuntimeError("image authority has an invalid ID set")
    if report.get("proven") != registered or report.get("errors") != []:
        raise RuntimeError("image authority disagrees with durable accounting")
    records = [line.split("\t") for line in (registry / "images").read_text().splitlines()]
    expected_records = [[f"pending:{args.tag}", args.tag]] + [
        [identity, "final" if identity == args.final_id else "intermediate"]
        for identity in sorted(registered)
    ]
    if sorted(records) != sorted(expected_records):
        raise RuntimeError("durable image registry disagrees with image authority")
    transcript = pathlib.Path(args.transcript)
    stdout_sha256 = hashlib.sha256((transcript / "stdout").read_bytes()).hexdigest()
    stderr_sha256 = hashlib.sha256((transcript / "stderr").read_bytes()).hexdigest()
    baseline = pathlib.Path(args.baseline).read_text().splitlines()
    current = exact_images()
    expected = set(baseline) | set(registered)
    if set(current) != expected:
        raise RuntimeError(
            f"unregistered or missing image before cleanup: added={sorted(set(current)-expected)!r} missing={sorted(expected-set(current))!r}"
        )
    evidence: dict[str, dict[str, Any]] = {}
    inspected = {identity: inspect_image(identity) for identity in current}
    for identity in registered:
        if identity in baseline:
            raise RuntimeError(f"registered image was present at baseline: {identity}")
        path = registry / "image-evidence" / f"{identity[7:]}.json"
        item = json.loads(path.read_text())
        actual = inspected[identity]
        if item.get("id") != identity or item.get("run_id") != args.run_id:
            raise RuntimeError(f"image registry evidence mismatch: {identity}")
        if item.get("stdout_sha256") != stdout_sha256 or item.get("stderr_sha256") != stderr_sha256:
            raise RuntimeError(f"image transcript evidence changed: {identity}")
        if actual.get("Parent", "") != item.get("parent", "") or actual.get("Created") != item.get("created"):
            raise RuntimeError(f"image parent/creation evidence changed: {identity}")
        role = item.get("role")
        tags = normalized_list(actual.get("RepoTags"))
        digests = normalized_list(actual.get("RepoDigests"))
        if digests:
            raise RuntimeError(f"registered image gained RepoDigests: {identity} {digests!r}")
        if role == "final":
            if identity != args.final_id or image_labels(actual).get(LABEL) != args.run_id:
                raise RuntimeError(f"final image identity/label mismatch: {identity}")
            if tags != [args.tag]:
                raise RuntimeError(f"final image tags changed: {identity} {tags!r}")
            tag_id = docker_output(["image", "inspect", args.tag, "--format", "{{.Id}}"]).decode().strip()
            if tag_id != identity:
                raise RuntimeError(f"final image tag drifted: {args.tag} -> {tag_id}")
        elif role == "intermediate":
            if tags:
                raise RuntimeError(f"intermediate image gained tags: {identity} {tags!r}")
        else:
            raise RuntimeError(f"unknown registered image role: {identity} {role!r}")
        references = docker_output(
            ["container", "ls", "--all", "--no-trunc", "--quiet", "--filter", f"ancestor={identity}"]
        ).decode().splitlines()
        if references:
            raise RuntimeError(f"registered image has container references: {identity} {references!r}")
        evidence[identity] = item

    if report.get("history") is not None and args.final_id:
        current_history = docker_output(
            ["image", "history", "--no-trunc", "--quiet", args.final_id]
        ).decode().splitlines()
        if current_history != report["history"]:
            raise RuntimeError("final image history changed")

    for child_id, child in inspected.items():
        parent = child.get("Parent") or ""
        if parent in registered and child_id not in registered:
            raise RuntimeError(f"registered image has an unexpected child: {parent} -> {child_id}")

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
    plan = pathlib.Path(args.plan)
    temporary = plan.with_name(f".{plan.name}.{os.getpid()}")
    with open(temporary, "w", encoding="utf-8") as stream:
        for identity in ordered:
            stream.write(identity + "\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, plan)
    fsync_directory(plan.parent)
    return 0


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    subparsers = root.add_subparsers(dest="action", required=True)
    capture = subparsers.add_parser("capture")
    capture.add_argument("--transcript", required=True)
    capture.add_argument("--stdin", required=True)
    capture.add_argument("command", nargs=argparse.REMAINDER)
    capture.set_defaults(handler=command_capture)
    account = subparsers.add_parser("account")
    for name in ("baseline", "post", "transcript", "registry", "run-id", "tag"):
        account.add_argument(f"--{name}", required=True)
    account.set_defaults(handler=command_account)
    preflight = subparsers.add_parser("preflight")
    for name in ("baseline", "registry", "transcript", "run-id", "tag", "final-id", "plan"):
        preflight.add_argument(f"--{name}", required=True)
    preflight.set_defaults(handler=command_preflight)
    return root


def main() -> int:
    args = parser().parse_args()
    if getattr(args, "command", None) and args.command[0] == "--":
        args.command = args.command[1:]
    if getattr(args, "command", None) == []:
        raise SystemExit("capture command is empty")
    try:
        return args.handler(args)
    except (OSError, RuntimeError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"release image accounting: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
