# span

A local-first desktop code editor built with Rust, Tauri 2, SolidJS, and CodeMirror 6. The current implementation is the phase 0.1 foundation and is under active verification.

## Current scope

- Open a native folder, browse files, use tabs and split groups, quick open, and streamed project search.
- Edit versioned rope-backed buffers with shared undo and redo, dirty state, explicit saving, and unsaved-close confirmation.
- Highlight and fold TypeScript, JavaScript, JSON, Markdown, Rust, and Python using tree-sitter alongside CodeMirror editing tools.
- Choose Dark, Light, or Purple themes and edit validated workspace settings as JSONC.
- Connect a local ACP agent, stream updates, inspect protocol logs, answer permission requests, cancel a turn, and review proposed file edits by hunk before applying them.
- Discover the ACP registry and install supported pinned npm agents. Binary and uvx distributions require a custom executable configuration in this version.

Agents run as local subprocesses with the operating system user's access. Agent authentication stays with the selected agent. The editor's permission and edit-review controls do not sandbox the agent process.

The browser preview contains clearly labelled sample files in memory. Native folder access, disk saving, and agent connections require the desktop app. Real terminal execution and native editor LSP integration remain incomplete; separate backend work does not establish those end-to-end workflows. Git, debugging, extensions, and remote execution are later-phase work.

## Build and run

Requirements: Node.js 22.12 or newer, pnpm 12.15, and Rust 1.90 or newer with rustfmt and clippy. A native desktop build also needs the platform's Tauri webview development dependencies. Linux CI lists its system packages in `.github/workflows/ci.yml`.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

The browser preview runs at `http://127.0.0.1:1420`. Start the native app separately:

```sh
pnpm desktop:dev
```

Build production frontend assets and the native bundle:

```sh
pnpm build
pnpm desktop:build
```

On macOS, an app-only build is available with `pnpm desktop:build --bundles app`; the result is `target/release/bundle/macos/span.app`. Copy that bundle to Applications to install a local build. Verified development installers are available from [GitHub Releases](https://github.com/1kentom/span/releases). Stable signing, notarization, installation review, and automatic updates have separate configuration and verification requirements.

## Verify

```sh
pnpm check
pnpm test
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm exec playwright install --only-shell chromium
pnpm test:e2e
```

The browser tests exercise quick open, tabs, edits, failed preview saves, selection and history across tab changes, shared split undo and redo, themes, and honest agent unavailability. They also capture the reference viewports. They do not prove native filesystem or live-provider behavior. Rust tests cover the core and scripted ACP subprocess flows; live providers have separate smoke examples.

CI is configured for macOS, Windows, and Linux. The linked baseline below has completed hosted checks and installer publication. Later source commits still require their own hosted runs. Local checks and packaging results are recorded separately from hosted CI and release verification.

Run `pnpm bench:web` while `pnpm dev` is running for the browser measurements. See [bench/README.md](bench/README.md) and [core measurements](crates/core/BENCHMARKS.md) for exact methods. Native cold and warm startup, physical keystroke-to-pixel latency, full 100 MB editable paint, scrolling, and idle-memory phase gates remain unverified on reference hardware. Phase 0.1 is not declared complete from compilation or browser tests alone.

## Repository layout

- `crates/core`: workspace paths, rope buffers, search, settings, and edit proposals.
- `crates/syntax`: tree-sitter language parsing and structure.
- `crates/acp`: subprocess transport, sessions, permissions, registry, and review.
- `crates/lsp`: public language-server client foundation, with editor integration tracked separately.
- `apps/desktop`: Tauri shell, native commands, and generated typed IPC.
- `ui`: SolidJS workbench, CodeMirror views, themes, and copied application assets.
- `e2e`: real browser-preview interaction tests.
- `bench`: reproducible measurements with explicit scope.
- `interfaces.md`: implemented command boundaries and type generation.

Raw supplied design archives, private source prompts, and review screenshots are local reference material excluded from Git. Application SVGs and branding used by the app are preserved in the application asset directories.

## Release status

Source is published at [1kentom/span](https://github.com/1kentom/span). The [verified baseline CI](https://github.com/1kentom/span/actions/runs/40666859507) passed on macOS, Windows, and Linux. The first [published development nightly](https://github.com/1kentom/span/releases/tag/v0.1.0-nightly.20261028.7) completed all four installer targets and includes verified SHA-256 checksums. This evidence applies to its recorded source commit, not automatically to later changes.

Nightly development releases are enabled. Preview is configured but has not been separately exercised. Stable publication remains gated by signing, notarization, installation review, and the remaining phase evidence described in [release channels](docs/releases.md). Native performance and a real provider edit review remain open. Automatic updates are not implemented.

## License

Project source code is MIT licensed. See [LICENSE](LICENSE). Provider and file-icon source records are preserved in the application asset directories, and website assets are documented in [apps/web/ASSETS.md](apps/web/ASSETS.md). The project MIT license does not establish separate redistribution rights for supplied artwork or third-party brands.
