# External file changes: selected behavior and evidence

Issue: [#70](https://github.com/1kentom/span/issues/70). Research and source audit: 2026-10-29, base `7c4d758`.

| Primary source | Observed contract | Span behavior and limit |
| --- | --- | --- |
| [VS Code save-conflict handler](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/editors/textFileSaveErrorHandler.ts) | A newer disk version produces Compare and Overwrite actions instead of an unconditional save. | Retain editor text, compare bounded inert previews, and require an explicit Reload or Overwrite action. The overwrite checks both the reviewed disk token and the current editor revision. |
| [Zed buffer source](https://github.com/zed-industries/zed/blob/main/crates/language/src/buffer.rs) | Disk changes distinguish dirty buffers from clean reloads, and reload application is conditional on the buffer revision. | A watcher-triggered clean reload is revision guarded. Pending renderer edits prohibit automatic reload, and edits racing the IPC response are retained and rebased. No Zed feature parity claim follows. |
| [JetBrains virtual file system](https://plugins.jetbrains.com/docs/intellij/virtual-file-system.html) | Native watcher notifications scope asynchronous refresh, and activation can trigger a refresh. | Reuse the existing debounced workspace watcher and recheck open buffers and loaded directories on foreground activation. No additional recursive scan or watcher is started. |
| [Fleet 1.38 release notes](https://blog.jetbrains.com/fleet/2024/07/fleet-1-38-is-here-with-support-for-virtual-environments-created-by-anaconda-auto-refresh-for-log-files-improved-proxy-setting-detection-and-much-more/) | Historical Fleet notes explicitly describe automatic log-file refresh. | This does not specify Fleet's general dirty-buffer conflict contract. It is historical context, not evidence of current product parity. |

## Reproduction before the change

The focused workbench regression starts with a clean open file, receives a fixture watcher update containing newer disk text, and advances the existing index poll. Before this change the editor retained the old text, so the assertion failed. The reproduction never invoked Save. Existing core save-signature tests already showed that a later Save rejected changed disk content; they did not establish automatic reload or a usable comparison workflow.

## Selected safety rules

- Native filesystem events advance a monotonic revision after the existing coalescing window. Access events do not advance it, avoiding a read-to-watch feedback loop. The UI polls this revision alongside the existing index status; foreground activation forces a check even after a missed event.
- Every requested file is scoped to the current workspace and carries its acknowledged buffer revision. The renderer denies automatic reload while local edits or writes are pending. A changed revision is treated as stale, not as permission to replace text.
- Clean UTF-8 text can reload automatically. Dirty text, deleted files and read failures remain in the editor. Conflicting buffers are protected from clean-tab eviction and Auto Save while the conflict remains.
- Compare freezes the reviewed disk token and editor document. Background events can update the current conflict record without approving a newer disk version. An explicit resolution rechecks the current revision and reviewed disk token. Failed or stale resolutions retain the draft and comparison.
- Existing Save hash checks remain active. An explicit Save conflict offers comparison; Auto Save records the conflict without opening an unsolicited modal. Overwrite is an explicit resolution of the reviewed version and skips formatting so it writes the reviewed editor content.
- The disk preview is bounded to 64 KiB. Truncation is disclosed and does not truncate the file or editor buffer. Text is rendered inertly. The editor is UTF-8 based; unreadable or invalid UTF-8 changes retain the existing text instead of replacing it.
- Directory refresh touches already loaded listings only. It does not run a new full workspace scan.

The disk token check happens before the existing atomic replacement. This does not establish a cross-process filesystem transaction against another writer changing the file during that final replacement window.

## Verification status

The clean-reload regression failed before implementation as expected. The candidate passes 108 focused UI tests across the workbench, Auto Save, conflict UI and modal suites, plus TypeScript checking against officially exported Specta contracts. After merging main at `c780ec7`, the official exporter reproduced the merged bindings exactly, and TypeScript plus the same 108 focused UI tests passed again. Three Chromium IPC fixture cases pass: clean reload/listing refresh without save, dirty Keep Editing followed by an explicit overwrite, and rejection of a stale reviewed token while the draft remains intact. The conflict screenshot was inspected and the destructive button's theme override corrected, followed by a passing browser rerun.

Independent source review identified and verified corrections for invalid UTF-8 recovery, failed renderer synchronization before overwrite, noncancelable final abandonment, and release of a tracked buffer after an escaping symlink replacement. The review found no remaining concrete blocker in those paths. Explicit abandonment does no disk I/O, invalidates old proposals and retains a revision tombstone for safe later reopening.

The exact-source release test run passes eight matching core tests, including all six new regressions for clean/dirty/pending edits, reviewed overwrite, deleted files, invalid UTF-8, abandonment and escaping symlinks. Four matching desktop tests pass, including a real temporary-workspace filesystem watcher event followed by a clean Core buffer reload. The initial symlink regression used a helper that resolved the escaping path before exercising the operation; the corrected test calls the revision-guarded check directly. A stale shared-cache binary was excluded from the evidence and the owning sources rebuilt before this run. Strict all-target Clippy remains a hosted CI gate.

Native app acceptance is still required. Browser IPC fixtures and the real filesystem/Core test do not establish native UI behavior. This note does not close #70 or establish #74 LSP watcher forwarding.
