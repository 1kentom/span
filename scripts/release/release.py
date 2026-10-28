#!/usr/bin/env python3
"""Dependency-free release metadata, changelog, and artifact tooling."""

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


STABLE = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def version_for(channel, base, date, sequence, tag="", approved=False):
    if not STABLE.fullmatch(base):
        raise ValueError("Base version must be a canonical major.minor.patch version")
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", date):
        raise ValueError("Date must use YYYY-MM-DD")
    day = dt.date.fromisoformat(date)
    if channel == "stable":
        if tag != f"v{base}" or not approved:
            raise ValueError("Stable requires the matching version tag and explicit phase approval")
        return base
    if channel not in ("nightly", "preview"):
        raise ValueError("Unsupported release channel")
    if not re.fullmatch(r"[1-9][0-9]*", str(sequence)):
        raise ValueError("Build sequence must be a positive integer")
    return f"{base}-{channel}.{day:%Y%m%d}.{sequence}"


def render_notes(changelog, commits, version, channel, sha):
    if not SHA.fullmatch(sha):
        raise ValueError("Source revision must be a full Git SHA")
    section = version if channel == "stable" and re.search(rf"^## \[{re.escape(version)}\]", changelog, re.M) else "Unreleased"
    match = re.search(rf"^## \[{re.escape(section)}\][^\n]*\n(.*?)(?=^## \[|\Z)", changelog, re.M | re.S)
    curated = match.group(1).strip() if match else "No curated notes for this release."
    groups = {"Breaking changes": [], "Features": [], "Fixes": [], "Maintenance": []}
    for commit_sha, subject in commits:
        parsed = re.match(r"([a-z]+)(?:\([^)]*\))?(!)?:\s+(.+)", subject)
        if not parsed:
            continue
        kind, breaking, title = parsed.groups()
        category = "Breaking changes" if breaking else {"feat": "Features", "fix": "Fixes"}.get(kind, "Maintenance")
        # Commit text is data, never shell input. Normalize Markdown line breaks.
        groups[category].append(f"- {title.replace(chr(10), ' ')} ({commit_sha[:8]})")
    generated = "\n\n".join(f"### {name}\n\n" + "\n".join(items) for name, items in groups.items() if items)
    warning = "Foundation release. Review the known limitations below before installing."
    return (f"# Span {version}\n\nChannel: `{channel}`. Source: `{sha}`.\n\n"
            f"{warning}\n\n{curated}\n\n## Changes since previous channel release\n\n"
            f"{generated or 'No conventional commits found in this range.'}\n\n"
            "Installers and SHA-256 checksums are attached. Automatic updates are not available in Phase 0.1.\n")


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def gh_json(endpoint):
    return json.loads(run("gh", "api", endpoint))


def successful_ci(runs, sha, repository):
    return any(r["head_sha"] == sha and r["conclusion"] == "success"
               and r["event"] in ("push", "workflow_dispatch")
               and r["head_repository"]["full_name"] == repository
               for r in runs)


def plan(args):
    event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
    repo = os.environ["GITHUB_REPOSITORY"]
    if repo != "1kentom/span":
        raise ValueError("Release publishing is restricted to 1kentom/span")
    event_name = os.environ["GITHUB_EVENT_NAME"]
    if event_name == "workflow_run":
        source = event["workflow_run"]
        if not (source["conclusion"] == "success" and source["event"] == "push"
                and source["head_branch"] == "main" and source["head_repository"]["full_name"] == repo):
            raise ValueError("Only successful same-repository main push CI may trigger nightly")
        channel, ref, sha = "nightly", "main", source["head_sha"]
    else:
        if os.environ["GITHUB_REF"] != "refs/heads/main":
            raise ValueError("Dispatch the trusted release workflow from main")
        inputs = event.get("inputs", {})
        channel = "preview" if event_name == "schedule" else inputs.get("channel", "preview")
        ref = (os.environ.get("PREVIEW_RELEASE_BRANCH") or "release/0.1") if event_name == "schedule" else inputs.get("source_ref", "")
        if channel == "stable":
            if not re.fullmatch(r"v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", ref):
                raise ValueError("Stable source_ref must be an existing vX.Y.Z tag")
            if inputs.get("phase_gate") != "phase-0.1-verified":
                raise ValueError("Stable requires the explicit phase-0.1-verified acknowledgement")
            git_ref = f"refs/tags/{ref}"
        elif channel == "preview" and re.fullmatch(r"release/[A-Za-z0-9][A-Za-z0-9._/-]*", ref) and ".." not in ref:
            git_ref = f"refs/heads/{ref}"
        else:
            raise ValueError("Preview must select a release/* branch")
        run("git", "fetch", "origin", git_ref)
        sha = run("git", "rev-parse", "FETCH_HEAD^{commit}")
    if not SHA.fullmatch(sha):
        raise ValueError("Invalid source SHA")
    run("git", "fetch", "origin", "main", "--tags")
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], check=True)
    runs = gh_json(f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={sha}&per_page=100")["workflow_runs"]
    if not successful_ci(runs, sha, repo):
        raise ValueError("Source SHA does not have successful trusted CI")
    config = json.loads(run("git", "show", f"{sha}:apps/desktop/tauri.conf.json"))
    date = dt.datetime.now(dt.timezone.utc).date().isoformat()
    version = version_for(channel, config["version"], date, os.environ["GITHUB_RUN_NUMBER"], ref, channel == "stable")
    tag = f"v{version}"
    # Published versions are immutable. A retry must use a new workflow run.
    if subprocess.run(["gh", "release", "view", tag, "--repo", repo], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
        raise ValueError("Release tag already published")
    metadata = {"channel": channel, "sha": sha, "version": version, "tag": tag,
                "prerelease": channel != "stable", "updater": False}
    Path("release-plan.json").write_text(json.dumps(metadata, indent=2) + "\n")
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key in ("channel", "sha", "version", "tag"):
            output.write(f"{key}={metadata[key]}\n")


def stamp(args):
    # This merge config is generated outside tracked source. Cargo workspace and
    # frontend package versions stay unchanged during parallel native builds.
    version = args.version
    base = version.split("-", 1)[0]
    channel = args.channel
    if channel == "stable":
        version_for(channel, base, "2026-01-01", 1, f"v{version}", True)
    elif not re.fullmatch(re.escape(base) + rf"-{re.escape(channel)}\.[0-9]{{8}}\.[1-9][0-9]*", version):
        raise ValueError("Invalid prerelease version")
    elif channel not in ("nightly", "preview") or not STABLE.fullmatch(base):
        raise ValueError("Invalid release channel or base version")
    else:
        date, sequence = version.rsplit(".", 2)[-2:]
        version_for(channel, base, f"{date[:4]}-{date[4:6]}-{date[6:]}", sequence)
    config = {"version": version}
    if args.signing_identity:
        config["bundle"] = {"macOS": {"signingIdentity": args.signing_identity}}
    Path(args.output).write_text(json.dumps(config, indent=2) + "\n")


def notes(args):
    tags = run("git", "tag", "--merged", args.sha, "--sort=-version:refname").splitlines()
    if args.channel == "stable":
        previous = next((tag for tag in tags if re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) and tag != args.tag), None)
    else:
        previous = next((tag for tag in tags if f"-{args.channel}." in tag and tag != args.tag), None)
    revision = f"{previous}..{args.sha}" if previous else args.sha
    log = run("git", "log", "--format=%H%x09%s", revision)
    commits = [line.split("\t", 1) for line in log.splitlines() if "\t" in line]
    changelog = run("git", "show", f"{args.sha}:CHANGELOG.md")
    Path(args.output).write_text(render_notes(changelog, commits, args.version, args.channel, args.sha))


def collect(args):
    extensions = {".dmg", ".exe", ".deb", ".AppImage"}
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=True)
    import shutil
    files = sorted(p for p in Path(args.source).rglob("*") if p.is_file() and p.suffix in extensions)
    if not files:
        raise ValueError("No native installer bundles were produced")
    for file in files:
        shutil.copy2(file, destination / f"{args.target}-{file.name}")


def checksums(args):
    root = Path(args.source)
    files = sorted(p for p in root.rglob("*") if p.is_file() and p.name != "SHA256SUMS")
    if not files:
        raise ValueError("Cannot checksum an empty artifact set")
    lines = []
    for file in files:
        with file.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
        lines.append(f"{digest}  {file.relative_to(root).as_posix()}")
    (root / "SHA256SUMS").write_text("\n".join(lines) + "\n")


def verify_assets(args):
    root = Path(args.source)
    required = {
        "aarch64-apple-darwin": (".dmg",),
        "x86_64-apple-darwin": (".dmg",),
        "x86_64-pc-windows-msvc": (".exe",),
        "x86_64-unknown-linux-gnu": (".deb", ".AppImage"),
    }
    for target, extensions in required.items():
        for extension in extensions:
            if not any(root.glob(f"{target}-*{extension}")):
                raise ValueError(f"Missing required {target} {extension} installer")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan")
    command = sub.add_parser("stamp")
    for flag in ("version", "channel", "output"):
        command.add_argument(f"--{flag}", required=True)
    command.add_argument("--signing-identity", default="")
    command = sub.add_parser("notes")
    for flag in ("version", "channel", "sha", "tag", "output"):
        command.add_argument(f"--{flag}", required=True)
    command = sub.add_parser("collect")
    for flag in ("source", "target", "output"):
        command.add_argument(f"--{flag}", required=True)
    command = sub.add_parser("checksums")
    command.add_argument("--source", required=True)
    command = sub.add_parser("verify-assets")
    command.add_argument("--source", required=True)
    args = parser.parse_args()
    globals()[args.command.replace("-", "_")](args)


if __name__ == "__main__":
    main()
