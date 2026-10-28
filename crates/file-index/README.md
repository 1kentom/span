# Span file index

This crate provides a background, workspace-scoped file-name index. It stores
relative and canonical absolute paths plus size and modification time. It does
not read contents, perform text search, or index language-server symbols.

## Integration sequence

1. Call `open_workspace` with the selected workspace root. It canonicalizes
   the root and returns a generation-scoped handle.
2. Start the filesystem watcher on `handle.root()` before scanning. Watch only
   that canonical root, do not follow symlinks, and coalesce bursts by path.
3. Forward watcher `Upsert`, `Remove`, and `Rename` events through
   `apply_event`, then call `start_scan`. Events received before or during the
   scan are replayed over the scan snapshot, with the latest event per path
   winning.
4. Read `snapshot` for scan progress and `query` for up to 100 ranked file
   paths. Keep the Explorer's root listing available separately while this
   index fills in.
5. On watcher overflow or a known missed-event interval, schedule a new scan.
   This crate does not install a watcher or claim native watcher consistency;
   the application adapter owns overflow detection and recovery scans.

The query executes on a blocking worker and uses `nucleo-matcher` for path
fuzzy matching. State locks protect only the index snapshot, never editor
buffers, file reads, or matching work.

## Design references

- VS Code file finder: [ripgrepFileSearch.ts](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/search/node/ripgrepFileSearch.ts), which delegates path enumeration to ripgrep and respects ignore configuration by default.
- VS Code file-search provider contract: [fileSearchProvider2.d.ts](https://github.com/microsoft/vscode/blob/main/src/vscode-dts/vscode.proposed.fileSearchProvider2.d.ts), which specifies cancellable path search and relaxed matching.
- Zed file finder: [file_finder.rs](https://github.com/zed-industries/zed/blob/main/crates/file_finder/src/file_finder.rs), a dedicated file-finder surface; [settings_content.rs](https://github.com/zed-industries/zed/blob/main/crates/settings_content/src/settings_content.rs) documents that finder candidates come from indexed files and gives ignored-file treatment its own explicit policy.
- Nucleo matcher API: [nucleo-matcher](https://docs.rs/nucleo-matcher/latest/nucleo_matcher/), used here rather than implementing fuzzy matching locally.
