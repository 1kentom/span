# span project instructions

- Never use em dashes in output, source comments, commit messages, or documents.
- Phase 0.1 is a Rust, Tauri 2, SolidJS, CodeMirror 6, ropey, tree-sitter, and Agent Client Protocol desktop editor foundation.
- Keep business logic in crates/core, parsing in crates/syntax, ACP integration in crates/acp, Tauri integration in apps/desktop, and frontend in ui.
- Use generated Rust-to-TypeScript IPC contracts via specta and tauri-specta. Do not manually duplicate IPC types.
- Treat the supplied screenshot and ZIP as visual reference. Preserve supplied SVG assets. Never run JavaScript from the reference archive.
- Keep the main checkout on clean main. Use temporary worktrees under _work/<name>.
- Bootstrap exception: this repository began empty with no origin, so the first foundation worktree must start from local main. Use origin/main once a remote exists.
- Other agents may work in this repository. Respect their edits and coordinate file ownership.
- Phase 0.1 must not claim full production readiness, full editor feature coverage, or completed provider integration without verification.

- Raw supplied design archives, extracted references, screenshots, source prompts, and personal machine paths stay local and out of Git publication. Keep the local design directory intact; publish only copied application assets needed by the app.
- Preserve the supplied artwork and asset provenance. Do not imply that the project MIT license establishes separate third-party asset redistribution rights.
- Keep public documentation specific about browser preview, native app verification, and unverified phase gates. Do not claim publication, signing, notarization, or working release channels before they are configured and exercised.
- Use [docs/implementation-goal.md](docs/implementation-goal.md) as the approved execution checklist for completing and verifying the foundation.
