# 0004: Update checks for agents and for Span

Status: accepted for Phase 0.1. Check-only.

## Context

What the code does today, read from source:

**Agent installs.** `install_registry_agent` (crates/acp/src/registry.rs) installs a pinned npm package under `<app cache>/agents/<id>/<version>/` with `npm install --ignore-scripts --no-audit --no-fund --no-package-lock`, then writes `span-agent.json` holding an `InstalledAgent { id, version, launch }`. `list_installed_agents` reads those manifests (several versions of one id can coexist). Only the registry's `npx` distribution is installable. The registry JSON (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, format 1.0.0) gives each agent `id`, `name`, one current `version`, an optional `repository`, and a `distribution` of `npx`, `uvx` or `binary` (a fetch by hand on 2026-10-28 listed 43 agents: 23 with `npx`, 20 with `binary`, 2 with `uvx`, a few with two). Binary and uvx entries have a version but Span cannot install them.

**Local programs.** `span_core::list_tools` / `ToolInfo` runs `<program> --version` with a 1.5 s bound, 4 KiB output cap and no stdin, and keeps the first non-empty line. It already knows `claude`, `codex`, `gemini` and `opencode` as "Agent CLI" tools. The line is free text (`2.0.32 (Claude Code)`, `codex-cli 0.46.0`), so the version must be extracted.

**Registry versus program.** The registry entries `opencode` (2.2.0) and `gemini` (0.66.0) are the CLIs themselves, so their version is comparable with the local `--version`. `claude-acp` (0.99.0) and `codex-acp` (2.3.0) are ACP adapter packages with their own numbering, not the Claude Code or Codex CLI versions. (The comment in adapter/opencode.rs saying OpenCode is not in the registry is out of date; it is listed now.)

**Span's own releases.** Releases are published to GitHub Releases of `1kentom/span` (docs/releases.md). `gh repo view` reports the repository as PUBLIC, and the website already reads `https://api.github.com/repos/1kentom/span/releases` without credentials (apps/web/main.js) and keeps a synced copy in apps/web/releases.json (apps/web/scripts/sync-releases.mjs). Channels and versions: nightly `0.1.0-nightly.YYYYMMDD.RUN`, preview `0.1.0-preview.YYYYMMDD.RUN`, stable `X.Y.Z`; nightly and preview are GitHub prereleases, stable is not. A build's own version is `version` in apps/desktop/tauri.conf.json (0.1.0); CI stamps release builds through a temporary Tauri merge config, and Rust crate versions stay 0.1.0 (docs/releases.md). So the running app must read the Tauri package version (`AppHandle::package_info().version`), not `CARGO_PKG_VERSION`. There is no updater plugin, key or manifest, and `release-plan.json` says `updater: false`; it must not be consumed.

## Decision

- Checks are check-only. Nothing is downloaded, installed or run to update. They run on demand (buttons) and once per launch only if `updates.checkOnLaunch` is true. That setting defaults to false and is user-settings-only: it is stripped from workspace files on read and on write, like `agents.delegation.enabled` (ADR 0003), and has a schema description. The Settings page saves to the workspace file, so it shows the key as text with that explanation rather than a toggle. No telemetry, no identifiers: a plain GET with the user agent `span-update-check`, which names no version or machine. Results are cached for the session in `ui/src/lib/updates.ts`; a button press forces a recheck. Failures show the real error and never block the app.
- Versions: `span_core::version` parses dotted numbers (two to four) with an optional semver-style pre-release, ignores `+build`, and orders pre-releases by semver rules, so `0.1.0-nightly.20261028.10` is newer than `.9` and any pre-release is older than its release. Anything else (`latest`, `1`, `2026-10-22`) parses to nothing and the status is `unknown`, never `upToDate`.
- Agents (`span_acp::update`, command `agent_update_status`): a Span-installed agent compares its newest installed version with the registry version. Local programs `opencode` and `gemini` compare the probed version with the registry entry of the same program. `claude` and `codex` show only the local version with status `unknown` and a note, because the registry lists adapters. A program missing from PATH is `notInstalled`. One row per id; a Span-managed install wins over a PATH program of the same id. The update path is text only: for managed agents it is the existing registry install re-run, quoting its npm command; for programs outside Span's control nothing is invented, only versions and the registry repository link.
- App (`span_acp::update::check_app_update`, command `app_update_check`): GET `https://api.github.com/repos/1kentom/span/releases?per_page=100`, drop drafts and links outside `https://github.com/1kentom/span/releases/`, keep releases of the build's own channel (derived from its version), take the highest, compare. Status is `upToDate`, `updateAvailable`, `notConfigured` or `error` plus a message. The HTTP client is the `reqwest` already a direct dependency of span-acp, so the code lives there beside the registry fetch. A 404 (a private or renamed repository) and a 403 or 429 (unauthenticated rate limit, 60 per hour per address) are errors with a plain message, never "no update". An empty channel is also an error. Debug builds report `notConfigured` ("Update checks are not configured for this build") without any request, since their version is the unstamped source version. Opening the release page uses the existing `open_external` after a click.

## Consequences

- No new dependencies. The two commands, `agentUpdateStatus` and `appUpdateCheck`, are added to the generated bindings, with standalone wrappers in ui/src/lib/client.ts.
- The unauthenticated GitHub API can rate limit; the user sees that message and can retry later. Only the newest 100 releases are read, so a stable channel buried under more than 100 newer prereleases reports an error rather than a guess.
- Nightly builds do not see stable releases and vice versa. Moving between channels is a manual choice.
- Managed agents get no one-click update: the installed agents are hidden from the registry list that holds the Install button, so the badge title and the Updates page show the install command as text. A real update button is a follow-up.
- The badge appears only for a confirmed newer version.

## UNVERIFIED

- No real update was applied. No release build was run, so the stamped version (`package_info().version`) and channel of a CI build are unverified; only the source of that stamping is read from docs/releases.md.
- The app check was not seen succeeding against live GitHub: the unauthenticated request from the development machine returned HTTP 403 (rate limit). The parser is tested with a synthetic list and with the saved real listing in apps/web/releases.json.
- Registry-installed update flow was not exercised against npm; opencode and gemini probes were tested with fixtures, not real installs.
- Debug-build behaviour hides the real network path in `cargo run`; only a release build exercises it.
