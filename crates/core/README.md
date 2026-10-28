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

## Preferences, formatting and reopen state

Settings additionally support UI and editor font families, UI size, panel drag collapse, Markdown's default preview mode, format on save, command shortcut overrides and per-language formatter argv. Shortcut overrides inherit the shared defaults when absent, and an empty array disables a command. Validation rejects unknown commands, unsupported key syntax, reserved editing/quit shortcuts and conflicts with effective defaults on the current platform. The raw workspace JSONC is available through `get_settings_jsonc`.

Formatting is a three-step transaction: take `take_format_request` under the workspace mutex, release it while awaiting `run_formatter`, then reacquire it for `apply_format_result`. The final step checks the original revision, so typing during a formatter cannot be overwritten. Desktop save orchestration can run that pipeline when `formatOnSave` is enabled and save only after success. Errors preserve editor contents and leave saving to the caller.

Built-in JSON formatting preserves key order and arbitrary precision numbers, and rejects duplicate keys to prevent data loss. Other languages invoke real rustfmt, Ruff or workspace/global Prettier when installed. A configured executable argv receives the document on stdin, supports `{path}` in arguments, and never passes through an implicit shell. Relative configured executable paths resolve from the workspace. Process execution and all pipe I/O share one ten-second deadline, with bounded input/output. Documents above 16 MiB require a different formatter workflow rather than blocking the editor. Missing tools return actionable errors.

`resolve_program` and `native_program_path` include common Homebrew, Cargo and local binary locations as well as the inherited PATH. Native GUI launch does not require reading or executing a login shell. Tokio supports the asynchronous process lifecycle. serde_json's `preserve_order` and `arbitrary_precision` features prevent the JSON formatter from rewriting key order or losing numeric precision.

`SessionStore` writes a separate user-profile JSON file at `~/.config/span/session.json`. It records workspace root, file groups, active selection, panel layout and per-file Markdown source/preview/both modes. Restore canonicalizes files inside the workspace, skips missing or escaping files, and ignores a missing workspace. Session storage never writes editor buffers or claims to recover unsaved drafts. It is an explicit JSON foundation store, not the later SQLite history system.

`read_image` exposes at most 8 MiB of a rooted local PNG, JPEG, GIF or WebP after checking its byte signature. It does not fetch remote URLs or serve SVG/script content.
