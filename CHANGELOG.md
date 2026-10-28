# Changelog

Changes to Span are recorded here. Release notes combine this curated section with conventional commit subjects, including squash merge PR numbers. Dates use UTC and versions use Semantic Versioning.

## [Unreleased]

### Added

- Rust workspace with separate editor core, tree-sitter syntax, ACP, and Tauri desktop crates.
- SolidJS desktop interface with CodeMirror 6, project navigation, tabs, editor panes, and a contextual agent panel.
- Rope-backed document operations, syntax parsing, generated Rust-to-TypeScript IPC contracts, and native file commands.
- Agent Client Protocol transport foundation and provider configuration interfaces.
- Branded application assets, macOS window integration, and browser interaction evidence.
- CI and a release pipeline for nightly, preview, and gated stable installer builds.
- Supported editor settings and custom shortcuts, Markdown and image previews, safe formatting paths, session history, and native CLI routing.
- Material file and folder icons and SVG provider branding with vendored license and provenance records.
- Public LSP client foundation, with native editor integration tracked separately.
- A production website with verified manual installer links and a local release manifest for public API rate limits.

### Changed

- Expand validated settings, keybinding controls, autosave choices, whole-workbench zoom, and the Alt+Z word-wrap action.
- Add HTML/CSS Emmet expansion, broader Markdown fence highlighting, Copy controls, and a shared source/preview toggle.
- Refine Go to completion and line jumps, context menus, modal focus, rounded overlay resize handles, and a Find-first search panel with Replace behind an explicit toggle.
- Add guarded native file operations, a detached desktop launcher, and more specific ACP catalog, installation, removal, and compatibility feedback.

### Fixed

- Provide an explicit save fallback when formatting fails without discarding the user's edits.
- Reconcile canceled discard requests and protect workspace transitions from stale or concurrent editor commands.
- Derive dirty state from actual content changes, including edits reverted to their saved content.
- Preserve Windows desktop test manifests and exact vendored SVG provenance across checkout platforms.

### Known limitations

- Phase 0.1 is an editor foundation. Full editor feature coverage and production readiness have not been established.
- Native performance budgets and large-project behavior have not been verified across the release platform matrix.
- One live provider prompt round trip has completed. Model authentication UI and a real provider edit proposal have not been verified. Broader provider integration remains incomplete.
- The first nightly installer matrix and publication succeeded for macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64. Installation checks and operating-system signing or notarization review across every target remain incomplete.
- Preview configuration exists but has not been separately exercised. Stable publication remains gated.
- Internal HTML5 dragging on Windows WebView2 conflicts with the enabled native external-drop handler and remains unverified or unsupported pending a platform-specific strategy.
- New desktop work remains unreleased until its reviewed source, hosted checks, and installed behavior are recorded. In particular, automatic clean-tab LRU eviction and the application connection from Markdown Run to the real PTY backend are not complete. Folder opening still awaits a full scan, and saving still rescans.
- The updater plugin, public-key trust configuration, signed updater manifests, and end-to-end channel switching are not implemented. Releases provide installers and checksums for manual installation.

<!-- Move reviewed entries into a dated version section when preparing a stable release. -->
