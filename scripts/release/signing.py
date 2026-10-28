#!/usr/bin/env python3
"""Import signing material only on ephemeral hosted macOS release runners."""

import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


def security(*args):
    subprocess.run(["security", *args], check=True, stdout=subprocess.DEVNULL)


def main():
    temporary = Path(os.environ["RUNNER_TEMP"])
    keychain = temporary / "span-release.keychain-db"
    certificate = temporary / "span-signing.p12"
    if sys.argv[1] == "cleanup":
        certificate.unlink(missing_ok=True)
        if keychain.exists():
            security("delete-keychain", str(keychain))
        return
    keys = ("APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD", "KEYCHAIN_PASSWORD",
            "APPLE_SIGNING_IDENTITY", "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")
    values = {key: os.environ.get(key, "") for key in keys}
    complete = all(values.values())
    if os.environ["RELEASE_CHANNEL"] == "stable" and not complete:
        raise ValueError("Stable macOS releases require all Apple signing and notarization secrets")
    if any(values.values()) and not complete:
        raise ValueError("Configure all Apple signing secrets together, or remove them for an ad-hoc prerelease")
    config_path = temporary / "span-release.json"
    config = json.loads(config_path.read_text())
    config.setdefault("bundle", {}).setdefault("macOS", {})["signingIdentity"] = values["APPLE_SIGNING_IDENTITY"] if complete else "-"
    config_path.write_text(json.dumps(config))
    # Export only populated values. An empty signing-identity environment value
    # can override the ad-hoc identity in the temporary Tauri config.
    exported = {key: values[key] for key in ("APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID")} if complete else {}
    exported["APPLE_SIGNING_IDENTITY"] = values["APPLE_SIGNING_IDENTITY"] if complete else "-"
    with open(os.environ["GITHUB_ENV"], "a") as environment:
        for key, value in exported.items():
            delimiter = f"SPAN_{uuid.uuid4().hex}"
            environment.write(f"{key}<<{delimiter}\n{value}\n{delimiter}\n")
    if not complete:
        return
    certificate.write_bytes(base64.b64decode(values["APPLE_CERTIFICATE"], validate=True))
    certificate.chmod(0o600)
    try:
        security("create-keychain", "-p", values["KEYCHAIN_PASSWORD"], str(keychain))
        security("set-keychain-settings", "-lut", "21600", str(keychain))
        security("unlock-keychain", "-p", values["KEYCHAIN_PASSWORD"], str(keychain))
        security("import", str(certificate), "-k", str(keychain), "-P", values["APPLE_CERTIFICATE_PASSWORD"], "-T", "/usr/bin/codesign", "-T", "/usr/bin/security")
        security("set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", values["KEYCHAIN_PASSWORD"], str(keychain))
        security("list-keychains", "-d", "user", "-s", str(keychain))
    finally:
        certificate.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
