"""Adversarial authority tests; never call a real Docker daemon."""
import copy
import hashlib
import importlib.util
import json
import pathlib
import sys
import tempfile
from types import SimpleNamespace

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("accounting", sys.argv[1])
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
spec.loader.exec_module(m)
IMAGE = "sha256:" + "a" * 64
BASE = "sha256:" + "b" * 64
MANIFEST = "sha256:" + "c" * 64
FOREIGN = "sha256:" + "d" * 64
TAG = "optd:unique-run"
RUN = "run"
REV = "e" * 40
created = "2026-10-01T00:00:00Z"
now = m.parse_created(created)


def fixture(root):
    state = m.TrustedState(root)
    for directory in ("registry", "registry/image-evidence", "transcript"):
        state.mkdir(directory)
    state.create_bytes("archive", b"exact archive", 0o400)
    state.create_bytes("Dockerfile", b"FROM scratch\n", 0o400)
    state.create_bytes("baseline", (BASE + "\n").encode())
    state.create_bytes("post", (IMAGE + "\n" + BASE + "\n").encode())
    state.create_bytes("registry/images", f"pending:{TAG}\t{TAG}\n".encode())
    state.create_bytes("transcript/stdout", b"")
    state.create_bytes("transcript/stderr", b"")
    argv = ["docker", "buildx", "build", "--builder", "default", "--load", "--no-cache", "--iidfile", str(root / "iid"), "--metadata-file", str(root / "metadata"), "--tag", TAG, "--build-arg", f"OPTD_REVISION={REV}", "-"]
    invocation = {"argv": argv, "started_ns": now - 1, "stdin": str(root / "archive"), "archive_sha256": hashlib.sha256(b"exact archive").hexdigest()}
    result = {"status": 0, "returncode": 0, "signal": 0, "finished_ns": now + 1, "stdout_sha256": hashlib.sha256(b"").hexdigest(), "stderr_sha256": hashlib.sha256(b"").hexdigest()}
    state.create_json("transcript/invocation.json", invocation)
    state.create_json("transcript/result.json", result)
    state.create_json("transcript/baseline-references.json", {BASE: {"tags": ["existing:keep"], "digests": []}})
    state.create_bytes("iid", MANIFEST.encode())
    state.create_bytes("metadata", json.dumps({"containerimage.digest": MANIFEST, "containerimage.config.digest": IMAGE}).encode(), 0o644)
    images = {
        BASE: {"Id": BASE, "RepoTags": ["existing:keep"], "RepoDigests": []},
        IMAGE: {"Id": IMAGE, "RepoTags": [TAG], "RepoDigests": [], "Parent": "", "Created": "1980-01-01T00:00:00Z", "Config": {"Labels": {m.LABEL: RUN, "org.opencontainers.image.revision": REV}}},
    }
    references = []
    removed = []
    m.exact_images = lambda: sorted(images)
    m.inspect_image = lambda identity: copy.deepcopy(images[identity])
    m.image_history = lambda identity: [{"ID": identity, "CreatedBy": "WORKDIR /opt/optd"}]

    def output(argv):
        if argv[:3] == ["image", "inspect", TAG]:
            return (IMAGE.encode() if "--format" in argv else json.dumps([images[IMAGE]]).encode())
        if argv[:2] == ["container", "ls"]:
            return "\n".join(references).encode()
        raise AssertionError(argv)

    def remove(argv, **_kwargs):
        assert argv == ["docker", "image", "rm", "--no-prune", "--", IMAGE]
        removed.append(IMAGE)
        del images[IMAGE]
        return SimpleNamespace(returncode=0)

    m.docker_output = output
    m.subprocess.run = remove
    args = SimpleNamespace(baseline=str(root / "baseline"), post=str(root / "post"), transcript=str(root / "transcript"), registry=str(root / "registry"), dockerfile=str(root / "Dockerfile"), run_id=RUN, tag=TAG, final_id=IMAGE, dry_run=False)
    state.close()
    return args, images, references, removed


def reject(action):
    try:
        action()
    except (RuntimeError, OSError, KeyError):
        return
    raise AssertionError("unsafe authority accepted")


def change_json(path, change):
    value = json.loads(path.read_text())
    change(value)
    path.write_text(json.dumps(value))


for mode in ("success", "iid-mismatch", "config-mismatch", "tag-mismatch", "label-mismatch", "preexisting-id", "preexisting-tag", "foreign-delta", "failed", "partial-load", "missing-metadata", "foreign-tags", "foreign-reference", "concurrent-image", "baseline-tags", "cleanup-iid-tamper", "unsafe-metadata", "metadata-symlink", "missing-iid", "cleanup-metadata-tamper"):
    with tempfile.TemporaryDirectory(prefix="optd-buildkit-contract-") as temporary:
        root = pathlib.Path(temporary)
        args, images, references, removed = fixture(root)
        if mode == "iid-mismatch":
            (root / "iid").write_text(FOREIGN)
        if mode == "config-mismatch":
            change_json(root / "metadata", lambda value: value.update({"containerimage.config.digest": FOREIGN}))
        if mode == "tag-mismatch":
            images[IMAGE]["Id"] = FOREIGN
        if mode == "label-mismatch":
            images[IMAGE]["Config"]["Labels"][m.LABEL] = "foreign"
        if mode == "preexisting-id":
            (root / "baseline").write_text(IMAGE + "\n" + BASE + "\n")
        if mode == "preexisting-tag":
            images[BASE]["RepoTags"].append(TAG)
        if mode == "foreign-delta":
            (root / "post").write_text(IMAGE + "\n" + BASE + "\n" + FOREIGN + "\n")
        if mode == "failed":
            change_json(root / "transcript/result.json", lambda value: value.update(status=37, returncode=37))
        if mode == "partial-load":
            (root / "post").write_text(BASE + "\n")
        if mode == "missing-metadata":
            (root / "metadata").unlink()
        if mode == "missing-iid":
            (root / "iid").unlink()
        if mode == "unsafe-metadata":
            (root / "metadata").chmod(0o666)
        if mode == "metadata-symlink":
            (root / "metadata").rename(root / "real-metadata")
            (root / "metadata").symlink_to(root / "real-metadata")
        if mode in ("iid-mismatch", "config-mismatch", "tag-mismatch", "label-mismatch", "preexisting-id", "preexisting-tag", "foreign-delta", "failed", "partial-load", "missing-metadata", "unsafe-metadata", "metadata-symlink", "missing-iid"):
            reject(lambda: m.command_account(args))
            assert not (root / "registry/image-authority.json").exists()
        else:
            assert m.command_account(args) == 0
            if mode == "foreign-tags":
                images[IMAGE]["RepoTags"].append("foreign:keep")
            if mode == "foreign-reference":
                references.append("foreign-container")
            if mode == "concurrent-image":
                images[FOREIGN] = {"Id": FOREIGN}
            if mode == "baseline-tags":
                images[BASE]["RepoTags"].append("foreign:new")
            if mode == "cleanup-iid-tamper":
                (root / "iid").write_text(FOREIGN)
            if mode == "cleanup-metadata-tamper":
                change_json(root / "metadata", lambda value: value.update({"containerimage.config.digest": FOREIGN}))
            if mode == "success":
                assert m.command_cleanup(args) == 0
                assert removed == [IMAGE]
                assert images == {BASE: {"Id": BASE, "RepoTags": ["existing:keep"], "RepoDigests": []}}
            else:
                reject(lambda: m.command_cleanup(args))
        if mode != "success":
            assert removed == []
        print(mode + ": ok")

# A manifest digest alone never establishes which config was loaded.
reject(lambda: m.buildkit_identity(MANIFEST, {"containerimage.digest": MANIFEST}, {"Id": IMAGE}))
assert m.buildkit_identity(IMAGE, {}, {"Id": IMAGE}) == IMAGE
