# Internal file dragging

Checked 2026-10-28 for issue #21. This change supports moving or copying a tab between existing editor groups and opening an Explorer file in a group. It does not rearrange tab order or move files on disk.

## Platform contract

The official [Tauri configuration reference](https://v2.tauri.app/reference/config/#dragdropenabled) says that its enabled native drag-drop handler replaces WebView2's handler on Windows and must be disabled to use frontend HTML5 dragging. Span keeps that handler enabled for external OS file drops and its typed startup-request/dirty-workspace guard. Internal movement therefore uses Pointer Events, with no DataTransfer or HTML drag listeners.

The [W3C Pointer Events specification](https://www.w3.org/TR/pointerevents4/#setting-pointer-capture) defines pointer capture and its release on pointer cancellation or completion. Capture redirects pointer event delivery, so target selection uses client coordinates and DOM hit testing rather than the captured event target. `touch-action: none` on file/tab sources declares the gesture before it starts. Window listeners provide a fallback when capture is unavailable.

## Span behavior

A primary pointer must move eight CSS pixels before dragging starts. Ordinary clicks, close buttons, and existing keyboard navigation remain available. The target group receives a focus-accent outline; a compact file label states Open, Move, Copy, or No drop target. Alt at release copies a tab view. A normal move removes only its original view, retaining the shared document and undo history. Settings keeps its existing single-owner movement rule.

The gesture captures its workspace generation and source group/path. Both source and destination are checked again before committing. Escape, pointer cancellation, lost capture, window blur, source removal, workspace transition, group removal, and component disposal cancel the gesture. A completed or canceled drag suppresses its ensuing pointer click; the next pointerdown restores ordinary clicks. Keyboard activation is not suppressed.

## Explorer keyboard and focus

Explorer rows are buttons in a `role="tree"` container. WebKit does not focus a button on a mouse click, so the row click handler focuses the row and a click on the empty tree area focuses the tree container (`tabindex="-1"`); the tree's key handler then receives Cmd/Ctrl+C, X, V, D, Z, A, F2, Enter, Cmd/Ctrl+Down, the arrow keys, Delete and Escape. Alt at release of an internal row drag copies instead of moving, as in JetBrains IDEs and VS Code.

## Files from the OS into the Explorer

A native drop over the Explorer is routed to the tree instead of the editor: the Explorer listens to the same Tauri drag-drop events (physical pixels converted to CSS pixels) and hit tests the row under the pointer, so a folder row, the folder of a file row or the project root receives the drop. Rust copies only paths recorded from the latest drop or the latest OS clipboard read (`apps/desktop/src/file_import.rs`, `clipboard_files.rs`), through `CoreWorkspace::import_paths`, which keeps the target inside the workspace, refuses symlinked targets and `.git`, refuses copying a folder into itself, skips nested symbolic links, caps entries and bytes before writing, and never overwrites without an explicit Replace (which moves the old item to the Trash).

## Verification boundary

A failing-first Chromium regression blocked every HTML `dragstart`, then reproduced the old failed tab movement. The pointer implementation passes that same scenario, including Explorer-to-group opening. Helper tests cover threshold and primary-pointer rules, capture, copy modifiers, click suppression, stale sources/targets, cancellation, and listener cleanup. Browser checks cover dirty shared text, cancellation and ordinary click/close interaction.

These browser tests exercise the production frontend without HTML dragging. They do not constitute native WebView2 or Windows runtime evidence. Native external file drops now only record their paths in Rust; the frontend routes them by drop position (the AI panel attaches them, the editor opens files inside the open project, a lone folder goes through the Open Folder guard) and Rust reads only paths from the latest drop. They still need the platform checks in docs/agent-mode-checklist.md. No full cross-platform dragging or VS Code parity claim is made.
