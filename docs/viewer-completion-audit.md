# Viewer completion audit, 2026-10-29

Source audited: `origin/main` at `7c4d758`. The older matrix in `current-verification.md` predates merged PR #104 (`8bb9638`). This note records current source and the bounded follow-up, not installed acceptance.

## Current scope

| Issue | Current source | Remaining boundary |
| --- | --- | --- |
| #55 | Inline tool images open the shared viewer. `savedPath` is still rendered as text only in `WorkGroup`. | An allowed-root native artifact loader and saved-path thumbnail/viewer flow. Agent paths must never grant arbitrary filesystem reads. |
| #56 | Tracker closed. Tool locations, diffs, changed files and attachment tabs have open callbacks. | Preserve exact installed path/line/focus and refusal evidence. |
| #57 | Shared FileViewer, attachment workbench tabs and Uploads mounts are merged. | Native edge-state/focus/limits acceptance. Complete document-byte routing is fixed by this cut. |
| #58 | Audio/video controls, no autoplay, object URL cleanup and mock playback tests exist. | Actual codecs/playback on each supported native webview. |
| #59 | Local bounded ZIP listing and entry reads exist. Extraction UI is tested against an in-memory implementation. | No production ArchiveApi is wired. Safe native extraction, symlink metadata, conflicts, progress and cancellation remain implementation work. |
| #60 | PDF, Office, CSV, font and sandboxed HTML components are merged. | CSV currently parses the bounded 2 MiB prefix and reveals more rows locally; real storage offset/limit paging is absent. Native document rendering and sandbox acceptance remain. |
| #91 | Screenshot paste, bounded workspace folder outline, cached earlier-chat transcript, recorded uploads and stored-link fallback are wired. | Earlier chats are limited to this window's cache. Live installed Claude/Codex image and unsupported-PDF link checks remain. |
| #108 | Many individual design packages have landed. | Full private-reference and current native comparison across themes is not established by component presence. |
| #29/#124 | Explicit Markdown Run creates command PTYs; Send stages drafts; output/exit follow real PTY events and statuses describe handoff. | Root must record exact installed Markdown Unicode output, copy, failure, interrupt and cleanup acceptance separately from browser fixtures. |

## Primary sources and chosen boundary

| Source | Verified behavior | Span decision and limit |
| --- | --- | --- |
| [VS Code user interface](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_preview-mode) | Single-click previews reuse a tab; editing or double-clicking keeps one. | Preserve existing Uploads preview/pinned tab behavior. This source does not establish PDF/Office byte limits. |
| [JetBrains Fleet product documentation](https://www.jetbrains.com/fleet/) | Fleet documents dedicated Markdown editing and live preview. | No Fleet PDF, Office or archive byte-limit parity is asserted. Span's bounded decoder contracts determine this fix. |
| [Zed settings reference](https://zed.dev/docs/reference/all-settings#preview-tabs) | Preview tabs reuse a slot and can be kept permanently; image sizes can use binary units. | Preserve tab behavior and explicit MiB limits. No document decoder parity is inferred. |
| [PDF.js loading API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html#~DocumentInitParameters) | The data parameter contains binary PDF data; custom range transport is a separate input. | Span supplies bytes and disables ranges, streaming and automatic fetch. A hex prefix cannot stand in for the complete document. |
| [fflate documentation](https://github.com/101arrowz/fflate) and the local bounded ZIP reader | ZIP operations consume container bytes. Span's reader finds the end-of-central-directory record near the file end before listing entries. | Read complete supported containers within explicit bounds; keep decompression, XML and image budgets intact. Do not add extraction or execute archive content. |

## Complete-document read fix

UploadsWorkspace previously called the generic `readLimit` before FileViewer selected its document decoder. Generic PDF/Office/archive fallback classification returned the 64 KiB hex budget, while the downstream decoders expected the full file. A generated 82,040-byte ZIP reproduced this: the store was asked for 65,536 bytes, omitting its directory.

The byte loader now uses the same `officeKindOf` dispatcher as FileViewer. Shared pure constants retain the existing Word/workbook 64 MiB, presentation 256 MiB and PDF 128 MiB parser caps; archive input has an explicit 64 MiB cap. The native uploads store's tighter 32 MiB file limit and its 4 MiB IPC chunks are unchanged. The size test happens before reading, oversized files show the too-large state, and incomplete container data is reported instead of being passed to a decoder. Explicit hex view remains capped at 64 KiB. ArchiveView also enforces the byte-array cap when mounted directly. A future API-only native archive implementation must enforce its own source-size limits.

Verification includes the failing-first full-container ZIP regression, per-format/MIME/cap/hex tests, oversized no-read and incomplete-data states, the existing Office/ZIP safety suites and the desktop upload chunk adapter. These checks do not establish native playback, PDF rendering fidelity, archive extraction or completed provider integration.
