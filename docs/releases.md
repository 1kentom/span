# Release channels

Span Phase 0.1 has release automation for `1kentom/span`. Publishing is disabled by default: the prepare job requires repository variable `RELEASE_CHANNELS_ENABLED` to equal `true`. Keep it unset during the initial repository push. Workflow files alone do not establish platform support or a completed phase gate. No release is published by local builds. Environment settings, signing credentials, and the first hosted workflow execution must be configured and reviewed before distributing installers.

| Channel | Source and trigger | Version example | Publication |
| --- | --- | --- | --- |
| Nightly | Successful same-repository `CI` push run on `main` | `0.1.0-nightly.20261028.42` | Prerelease, never marked latest |
| Preview | Monday 06:23 UTC schedule or manual dispatch selecting a `release/*` branch | `0.1.0-preview.20261028.43` | Prerelease, never marked latest |
| Stable | Manual dispatch selecting an existing `vX.Y.Z` tag | `0.1.0` | Requires phase acknowledgement and the protected `release-stable` environment |

Nightly is a development channel rebuilt after green main commits. It is not a promise of a daily build when main has no changes. Preview defaults to `release/0.1`; set repository variable `PREVIEW_RELEASE_BRANCH` to another maintained release branch. Every selected commit must be reachable from main and have successful `CI` for that exact SHA from a same-repository push or manual CI run. Preview branches therefore select reviewed main history. Fork and pull request CI runs never authorize publication. Existing published tags are immutable and a duplicate version stops the workflow.

## First repository setup

1. Protect `main` and `release/*` with required review and successful CI. Restrict version tag creation, deletion, and force pushes to maintainers using a repository ruleset. Require squash PR titles or commits to use conventional commit subjects such as `feat(editor): add split panes (#42)`.
2. Create environments `release-nightly`, `release-preview`, and `release-stable`. Restrict each environment to workflow runs on `main`. For stable, configure required maintainer reviewers, prevent self-review, and disable administrator bypass where available. Do this before the first stable dispatch. Referencing an environment in YAML does not configure its protection rules.
3. Keep the environment variable `PHASE_0_1_RELEASE_APPROVED` unset until the phase checklist below is reviewed. Set it to the exact string `true` only in `release-stable` after approval. Both stable packaging and publication check it. The default is to fail closed.
4. Configure signing secrets on the relevant environments. Keep secrets out of repository files and build logs. Prereleases can build with no signing secrets: macOS uses an ad-hoc signature and Windows installers are unsigned. These are development artifacts that can trigger operating-system warnings. Stable macOS and Windows packaging fail if signing credentials are absent or incomplete.
5. Allow the workflow token to write repository contents in the publication job. Other jobs use read-only contents permissions; preparation also reads Actions runs. No personal token is needed for publishing to this repository.
6. After reviewing repository configuration and the development-artifact publication policy, explicitly set repository variable `RELEASE_CHANNELS_ENABLED=true` to activate the channels. This is an operational enablement step, not performed by the setup scripts or initial push.

## Signing secrets

| Platform | Environment secrets | Behavior |
| --- | --- | --- |
| macOS | `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `KEYCHAIN_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Base64 PKCS#12 certificate is imported into a temporary keychain. Tauri signs and notarizes using the Developer ID identity and Apple app-specific password. All seven secrets must be configured together. |
| Windows | `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Base64 PKCS#12 certificate is imported into the ephemeral hosted runner's user certificate store. A generated Tauri merge config enables SHA-256 signing and timestamping. |

Credentials are provisioned by maintainers. The tooling does not create signing keys or certificates. macOS temporary certificate files and keychains are removed by the cleanup step. Windows certificate files are removed after import, and the certificate store is discarded with the hosted runner. Cloud or hardware-backed Windows signing needs a separately reviewed signing integration in place of the PKCS#12 helper.

## Packages and versioning

The matrix builds macOS Apple Silicon (`aarch64-apple-darwin`, `macos-15`), macOS Intel (`x86_64-apple-darwin`, `macos-15-intel`), Windows x64 (`x86_64-pc-windows-msvc`, `windows-2022`), and Linux x64 (`x86_64-unknown-linux-gnu`, `ubuntu-24.04`). Outputs are DMG, NSIS EXE, Debian package, and AppImage. Linux ARM, Windows ARM, mobile, package stores, and universal macOS bundles are not claimed by this pipeline.

The version base comes from `apps/desktop/tauri.conf.json` at the selected source SHA. Stable requires the tag to match that exact base version. Prerelease identifiers use the channel, UTC date, and workflow run number. A temporary Tauri merge config stamps installer/app versions without editing Cargo workspace or frontend manifests. Rust crate package versions remain the source workspace version. The release plan records the app version, channel, full source SHA, and updater status.

All four targets must succeed before publication. The publish job collects five installer files, notes, release metadata, and `SHA256SUMS`. It first creates a draft release, uploads all artifacts, and then publishes. An upload failure leaves a draft for maintainer inspection and cleanup, rather than a public partial release. Platform installation and signing must still be exercised on real devices after the first hosted run. No release workflow has been executed locally as proof of the complete matrix.

## Preparing and dispatching releases

Run the local policy checks from the repository root:

```sh
python3 -m unittest discover -s scripts/release -p 'test_*.py' -v
actionlint .github/workflows/ci.yml .github/workflows/release-channels.yml .github/workflows/release-build.yml
```

Preview releases can be dispatched from the Actions UI or with GitHub CLI:

```sh
gh workflow run release-channels.yml --repo 1kentom/span --ref main \
  -f channel=preview -f source_ref=release/0.1
```

For a stable release, update the base version and curate `CHANGELOG.md` in a reviewed PR. Create and push a matching `vX.Y.Z` tag at the intended green main commit. Then dispatch from `main`, selecting that tag and entering the exact phase acknowledgement:

```sh
gh workflow run release-channels.yml --repo 1kentom/span --ref main \
  -f channel=stable -f source_ref=v0.1.0 -f phase_gate=phase-0.1-verified
```

This command requests a gated workflow. It does not replace environment review. Approve the protected environment only after inspecting the selected SHA, notes, and prior CI evidence. Packaging and publication can require separate environment approvals.

## Phase 0.1 stable review

- Review editor feature scope, native file behavior, generated IPC contracts, and ACP behavior against the agreed phase requirements.
- Validate the model authentication experience and a real provider edit proposal with recorded outcomes. One successful provider prompt does not establish complete integration.
- Measure native startup, typing, and large-file behavior against documented budgets. Browser preview timings alone are insufficient.
- Exercise installation, launch, uninstall, signing verification, and macOS notarization on all four packaged targets.
- Review known limitations, license and third-party notices, release notes, and signing credential access.

These are review criteria, not assertions of completion. Keep unverified items in the release notes. Stable publication requires a maintainer decision after evidence is available.

## Changelog and update status

`CHANGELOG.md` holds hand-curated features and limitations. `scripts/release/release.py notes` combines its Unreleased section with conventional commit subjects since the previous reachable tag in the same channel. For stable, a matching dated version section takes precedence if present. Squash merge PR numbers are retained. Breaking `!` subjects, `feat`, and `fix` commits receive separate sections. Other conventional commits become maintenance entries. `.github/release.yml` defines label categories for GitHub's separate generated-notes UI; it does not rewrite the curated file. Move reviewed Unreleased entries into a dated version section in the stable preparation PR.

The current application has no updater plugin, pinned updater public key, channel endpoints, or signed updater manifest. This pipeline publishes installer artifacts and changelogs only. `release-plan.json` explicitly sets `updater` to `false`; it is not a Tauri updater manifest. Do not configure clients to consume it. A later updater implementation must add and verify the plugin, key management, signed platform artifacts, channel manifests, downgrade policy, and a real upgrade test before claiming automatic updates.

## References

Runner labels and release mechanics were checked against official documentation on 2026-10-28: [GitHub hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [workflow_run events and security](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run), [Tauri distribution](https://v2.tauri.app/distribute/), [macOS signing](https://v2.tauri.app/distribute/sign/macos/), [Windows signing](https://v2.tauri.app/distribute/sign/windows/), and [Tauri updater requirements](https://v2.tauri.app/plugin/updater/).
