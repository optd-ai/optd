"""Offline export checks; never invokes the host Docker daemon."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/release-export.sh"


class ReleaseExportTests(unittest.TestCase):
    def test_export_and_refuse_overwrite(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            artifacts = root / "artifacts"
            artifacts.mkdir()
            for name in ("optctl", "LICENSE", "NOTICE", "image-metadata.json"):
                (artifacts / name).write_text(name)
            docker = root / "docker"
            docker.write_text('#!/bin/bash\nset -eu\n[[ "$1 $2 $3" == "image save --output" ]]\nprintf image > "$4"\n')
            docker.chmod(0o700)
            env = {**os.environ, "PATH": f'{root}:{os.environ["PATH"]}'}
            out = root / "export"
            argv = ["bash", str(SCRIPT), "sha256:" + "a" * 64, str(artifacts), str(out)]
            subprocess.run(argv, env=env, check=True)
            subprocess.run(["sha256sum", "--check", "SHA256SUMS"], cwd=out, check=True, capture_output=True)
            self.assertNotEqual(subprocess.run(argv, env=env).returncode, 0)
            self.assertEqual((out / "optctl").read_text(), "optctl")
            argv[2] = "mutable:tag"
            self.assertNotEqual(subprocess.run(argv, env=env).returncode, 0)

    def test_save_failure_propagates(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            for name in ("optctl", "LICENSE", "NOTICE", "image-metadata.json"):
                (root / name).touch()
            docker = root / "docker"
            docker.write_text("#!/bin/bash\nexit 42\n")
            docker.chmod(0o700)
            env = {**os.environ, "PATH": f'{root}:{os.environ["PATH"]}'}
            result = subprocess.run(["bash", str(SCRIPT), "sha256:" + "a" * 64, str(root), str(root / "out")], env=env)
            self.assertEqual(result.returncode, 42)
            self.assertFalse((root / "out/SHA256SUMS").exists())


if __name__ == "__main__":
    unittest.main()
