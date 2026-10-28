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

### Known limitations

- Phase 0.1 is an editor foundation. Full editor feature coverage and production readiness have not been established.
- Native performance budgets and large-project behavior have not been verified across the release platform matrix.
- One live provider prompt round trip has completed. Model authentication UI and a real provider edit proposal have not been verified. Broader provider integration remains incomplete.
- Native installer execution and signing on all four release targets still require hosted CI and installation checks.
- The updater plugin, public-key trust configuration, signed updater manifests, and end-to-end channel switching are not implemented. Releases provide installers and checksums for manual installation.

<!-- Move reviewed entries into a dated version section when preparing a stable release. -->
