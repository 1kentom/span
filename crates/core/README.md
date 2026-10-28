# span-core

Phase 0.1 authoritative workspace, rope buffers, file search and settings.

`CoreWorkspace` is synchronous and intended for an application-owned mutex on a worker thread. The desktop must run disk and search operations outside its UI thread. The service returns contextual errors and leaves dirty buffers available after failed saves.

## Text transactions

`open_buffer`, `buffer_snapshot`, `buffer_snapshot_bounded` and `agent_read` return full snapshots. `edit_buffer_delta` applies an ordered batch of UTF-16 edits against an expected revision and returns metadata only. Offsets describe the pre-transaction document. The entire batch is validated before mutation, including surrogate-pair boundaries. `edit_buffer` is a convenience snapshot API for resynchronization and tests, not the normal keystroke transport.

The UI owns undo/redo history and submits inverse transactions through the same revision checks. Same-file split views share one core buffer. Revisions increase on edits and explicit discard/reload. A successful save records the saved revision. Stale transactions fail without mutation.

Agent reads include unsaved text. `stage_proposal` diffs a full-file ACP write into contiguous changed-line hunks separated by unchanged lines, and `stage_edit_proposal` stages explicit non-overlapping edit hunks. Staging does not mutate the buffer or disk. Acceptance requires the original base revision and creates a dirty buffer transaction. Rejection leaves both buffer and disk unchanged. Saving remains an explicit operation. `resolve_proposal_hunks` accepts a selected subset in one transaction and rejects the remaining hunks. Original UTF-16 offsets and exact old/new text remain attached to every hunk, including CRLF and missing final newlines.

## Files and settings

Paths are canonicalized within the workspace root. Parent traversal and symlinks that escape the root are rejected. Directory walks apply ignore files, do not follow directory symlinks, and exclude `.git`. Saves check the current disk content signature and use a same-directory temporary file, preserve existing permissions, flush, and rename. External modifications produce a conflict instead of overwriting the file. This is not an OS-level exclusive lock against a concurrent writer between the content check and rename.

Project search uses grep-regex and grep-searcher with ignore-aware traversal. `search_stream` emits results while walking, accepts a cancellation token and stops when the consumer returns false. Open buffers replace disk content, including new unsaved files. Search columns use one-based UTF-16 offsets. `search` collects the stream as a convenience for bounded callers. Capture `search_snapshot` while holding the workspace mutex, then release it before scanning on a worker. Its cheap immutable rope clones preserve unsaved text at search start without blocking later editor transactions.

Settings merge defaults, user JSONC at `~/.config/span/settings.jsonc`, and workspace `.span/settings.jsonc`. A custom user path can be supplied for profiles. `update_settings_jsonc` validates before atomically persisting the original comments. The supported settings are described in `settings.schema.json`. `update_settings` persists the complete typed value as JSON.

Dependencies: similar 3.2.0 (Apache-2.0, verified MSRV 1.85) provides Myers line diffing for independently reviewable ACP changes. ropey provides the text model, ignore and the grep crates provide file traversal and search, serde and specta provide one source for IPC contracts, and thiserror provides contextual failures. tempfile is used only in tests and the benchmark fixture.

## Verification

- `cargo test -p span-core`
- `cargo clippy -p span-core --all-targets -- -D warnings`
- `cargo run --release -p span-core --example rope_bench`

The benchmark creates a 100 MiB ASCII file, excludes fixture generation, times the core disk read plus rope construction plus initial IPC snapshot, then times a middle insertion through the metadata acknowledgement API. Its file is in the OS cache. It does not measure Tauri serialization, frontend parsing, editable paint, startup, scrolling, memory, or the complete desktop performance gates.
