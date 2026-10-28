import argparse
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import release
import signing


class ReleasePolicyTests(unittest.TestCase):
    def test_channel_versions_are_distinct_and_ordered(self):
        nightly = release.version_for("nightly", "0.1.0", "2026-10-28", 42)
        preview = release.version_for("preview", "0.1.0", "2026-10-28", 42)
        self.assertEqual(nightly, "0.1.0-nightly.20261028.42")
        self.assertEqual(preview, "0.1.0-preview.20261028.42")
        self.assertEqual(release.version_for("stable", "0.1.0", "2026-10-28", 42, "v0.1.0", True), "0.1.0")

    def test_stable_gate_rejects_missing_or_mismatched_approval(self):
        for tag, approved in [("v0.1.0", False), ("v0.2.0", True), ("0.1.0", True), ("v0.1.0-rc.1", True)]:
            with self.subTest(tag=tag, approved=approved), self.assertRaises(ValueError):
                release.version_for("stable", "0.1.0", "2026-10-28", 42, tag, approved)

    def test_rejects_noncanonical_versions(self):
        for version in ["01.1.0", "1.01.0", "1.0.01", "1.0", "v1.0.0", "1.0.0-rc.1", "1.0.0+meta", "1.0.0\n"]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                release.version_for("nightly", version, "2026-10-28", 42)

    def test_date_and_sequence_validation(self):
        for date in ["2026-02-29", "2026-13-01", "not-a-date", "20261028"]:
            with self.subTest(date=date), self.assertRaises(ValueError):
                release.version_for("preview", "0.1.0", date, 1)
        for sequence in [0, -1, "01", "one"]:
            with self.subTest(sequence=sequence), self.assertRaises(ValueError):
                release.version_for("preview", "0.1.0", "2026-10-28", sequence)

    def test_unknown_channel_fails(self):
        with self.assertRaises(ValueError):
            release.version_for("beta", "0.1.0", "2026-10-28", 1)

    def test_exact_sha_and_trusted_ci_events_required(self):
        sha = "a" * 40
        run = {"head_sha": sha, "conclusion": "success", "event": "push", "head_repository": {"full_name": "1kentom/span"}}
        self.assertTrue(release.successful_ci([run], sha, "1kentom/span"))
        for patch in [{"head_sha": "b" * 40}, {"conclusion": "failure"}, {"event": "pull_request"}, {"head_repository": {"full_name": "fork/span"}}]:
            with self.subTest(patch=patch):
                self.assertFalse(release.successful_ci([{**run, **patch}], sha, "1kentom/span"))

    def test_curated_limitations_and_conventional_commits_remain_in_notes(self):
        changelog = "# Changelog\n\n## [Unreleased]\n\n### Known limitations\n\n- Native performance is unverified.\n\n## [0.0.1]\n\nOld notes."
        commits = [("1" * 40, "feat(editor): add split views (#12)"), ("2" * 40, "fix!: change protocol"), ("3" * 40, "unstructured commit")]
        result = release.render_notes(changelog, commits, "0.1.0-preview.20261028.1", "preview", "a" * 40)
        self.assertIn("Native performance is unverified.", result)
        self.assertIn("add split views (#12)", result)
        self.assertIn("### Breaking changes", result)
        self.assertNotIn("Old notes.", result)
        self.assertNotIn("unstructured commit", result)
        self.assertIn("Automatic updates are not available", result)

    def test_stamp_does_not_change_source_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "merge.json"
            release.stamp(argparse.Namespace(version="0.1.0-nightly.20261028.1", channel="nightly", output=output, signing_identity=""))
            self.assertEqual(json.loads(output.read_text()), {"version": "0.1.0-nightly.20261028.1"})

    def test_stable_notes_use_curated_version_section_after_promotion(self):
        changelog = "## [Unreleased]\n\nFuture changes.\n\n## [0.1.0] - 2026-10-28\n\nReviewed foundation features.\n\n## [0.0.1]\n\nOld notes."
        result = release.render_notes(changelog, [], "0.1.0", "stable", "a" * 40)
        self.assertIn("Reviewed foundation features.", result)
        self.assertNotIn("Future changes.", result)
        self.assertNotIn("Old notes.", result)

    def test_stamp_rejects_invalid_calendar_date(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            release.stamp(argparse.Namespace(version="0.1.0-nightly.20260229.1", channel="nightly", output=Path(directory) / "merge.json", signing_identity=""))

    def test_stable_signing_fails_closed_and_prerelease_uses_ad_hoc(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "span-release.json"
            config.write_text('{"version": "0.1.0"}')
            environment = {"RUNNER_TEMP": directory, "RELEASE_CHANNEL": "stable", "GITHUB_ENV": str(Path(directory) / "environment")}
            with patch.dict(os.environ, environment, clear=True), patch("sys.argv", ["signing.py", "macos"]):
                with self.assertRaises(ValueError):
                    signing.main()
                os.environ["RELEASE_CHANNEL"] = "nightly"
                signing.main()
            self.assertEqual(json.loads(config.read_text())["bundle"]["macOS"]["signingIdentity"], "-")
            self.assertIn("APPLE_SIGNING_IDENTITY", (Path(directory) / "environment").read_text())

    def test_missing_architecture_blocks_publication(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(ValueError):
                release.verify_assets(argparse.Namespace(source=directory))
            for name in ["aarch64-apple-darwin-span.dmg", "x86_64-apple-darwin-span.dmg", "x86_64-pc-windows-msvc-span.exe", "x86_64-unknown-linux-gnu-span.deb", "x86_64-unknown-linux-gnu-span.AppImage"]:
                (root / name).write_bytes(b"installer")
            release.verify_assets(argparse.Namespace(source=directory))
            release.checksums(argparse.Namespace(source=directory))
            first = (root / "SHA256SUMS").read_text()
            self.assertEqual(len(first.splitlines()), 5)
            release.checksums(argparse.Namespace(source=directory))
            self.assertEqual(first, (root / "SHA256SUMS").read_text())


if __name__ == "__main__":
    unittest.main()
