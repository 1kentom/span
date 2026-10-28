"""Exercise generated-metadata Git updates against scratch repositories."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("update-website-manifest.sh").resolve()


class ManifestUpdateTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="span-manifest-test-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        self.origin = self.root / "origin.git"
        self.work = self.root / "work"
        self.racer = self.root / "racer"
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = {
            **os.environ,
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GH_TOKEN": "test-placeholder",
            "GITHUB_REPOSITORY": "1kentom/span",
            "RELEASE_TAG": "v0.1.0-nightly.20261028.7",
            "RELEASE_CHANNEL": "nightly",
            "TEST_MODE": "update",
            "TEST_MARKER": str(self.root / "node-called"),
            "TEST_RACER": str(self.racer),
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
        }
        self.git("init", "--bare", "--initial-branch=main", str(self.origin))
        self.git("clone", str(self.origin), str(self.work))
        self.configure(self.work)
        manifest = self.work / "apps/web/releases.json"
        manifest.parent.mkdir(parents=True)
        manifest.write_text('{"known": true}\n')
        self.git("add", "apps/web/releases.json", cwd=self.work)
        self.git("commit", "-m", "seed", cwd=self.work)
        self.git("push", "origin", "main", cwd=self.work)
        self.git("clone", str(self.origin), str(self.racer))
        self.configure(self.racer)
        self.initial = self.remote_head()
        self.executable("gh", "#!/usr/bin/env bash\nexit 0\n")
        self.executable("node", f"#!{sys.executable}\n" + r'''
import os
from pathlib import Path
import subprocess
import sys
mode = os.environ["TEST_MODE"]
if mode == "fail":
    raise SystemExit(1)
if mode == "unchanged":
    raise SystemExit(0)
marker = Path(os.environ["TEST_MARKER"])
if mode == "race" and not marker.exists():
    racer = Path(os.environ["TEST_RACER"])
    (racer / "concurrent.txt").write_text("preserve this update\n")
    for args in (["add", "concurrent.txt"], ["commit", "-m", "concurrent"], ["push", "origin", "main"]):
        subprocess.run(["git", *args], cwd=racer, check=True, capture_output=True)
marker.write_text("called")
Path("apps/web/releases.json").write_text('{"verified": true}\n')
''')

    def executable(self, name, contents):
        path = self.bin / name
        path.write_text(contents)
        path.chmod(0o755)

    def configure(self, path):
        self.git("config", "user.name", "Test", cwd=path)
        self.git("config", "user.email", "test@example.invalid", cwd=path)
        self.git("config", "commit.gpgsign", "false", cwd=path)

    def git(self, *args, cwd=None):
        return subprocess.check_output(
            ["git", *args], cwd=cwd or self.root, env=self.env,
            stderr=subprocess.DEVNULL, text=True,
        ).strip()

    def remote_head(self):
        return self.git("--git-dir", str(self.origin), "rev-parse", "main")

    def run_update(self, mode="update"):
        return subprocess.run(
            ["bash", str(SCRIPT)], cwd=self.work,
            env={**self.env, "TEST_MODE": mode},
            capture_output=True, text=True,
        )

    def remote_file(self, path):
        return self.git("--git-dir", str(self.origin), "show", "main:" + path)

    def test_commits_only_the_verified_manifest(self):
        result = self.run_update()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(self.remote_file("apps/web/releases.json")), {"verified": True})
        self.assertEqual(
            self.git("--git-dir", str(self.origin), "diff-tree", "--no-commit-id", "--name-only", "-r", "main"),
            "apps/web/releases.json",
        )

    def test_unchanged_manifest_creates_no_commit(self):
        result = self.run_update("unchanged")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_head(), self.initial)

    def test_failed_refresh_preserves_known_manifest(self):
        result = self.run_update("fail")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_head(), self.initial)
        self.assertEqual((self.work / "apps/web/releases.json").read_text(), '{"known": true}\n')

    def test_push_race_preserves_the_concurrent_commit(self):
        result = self.run_update("race")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.remote_file("concurrent.txt"), "preserve this update")
        self.assertEqual(json.loads(self.remote_file("apps/web/releases.json")), {"verified": True})
        self.assertEqual(self.git("--git-dir", str(self.origin), "rev-list", "--count", "main"), "3")

    def test_rejected_push_is_bounded_and_never_forced(self):
        log = self.root / "rejected"
        hook = self.origin / "hooks/pre-receive"
        hook.write_text(f"#!/usr/bin/env bash\necho reject >> '{log}'\nexit 1\n")
        hook.chmod(0o755)
        result = self.run_update()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.remote_head(), self.initial)
        self.assertEqual(len(log.read_text().splitlines()), 3)


if __name__ == "__main__":
    unittest.main()
