# Internal file dragging

Checked 2026-10-28 for issue #21. This change supports moving or copying a tab between existing editor groups and opening an Explorer file in a group. It does not rearrange tab order or move files on disk.

## Platform contract

The official [Tauri configuration reference](https://v2.tauri.app/reference/config/#dragdropenabled) says that its enabled native drag-drop handler replaces WebView2's handler on Windows and must be disabled to use frontend HTML5 dragging. Span keeps that handler enabled for external OS file drops and its typed startup-request/dirty-workspace guard. Internal movement therefore uses Pointer Events, with no DataTransfer or HTML drag listeners.

The [W3C Pointer Events specification](https://www.w3.org/TR/pointerevents4/#setting-pointer-capture) defines pointer capture and its release on pointer cancellation or completion. Capture redirects pointer event delivery, so target selection uses client coordinates and DOM hit testing rather than the captured event target. `touch-action: none` on file/tab sources declares the gesture before it starts. Window listeners provide a fallback when capture is unavailable.

## Span behavior

A primary pointer must move eight CSS pixels before dragging starts. Ordinary clicks, close buttons, and existing keyboard navigation remain available. The target group receives a focus-accent outline; a compact file label states Open, Move, Copy, or No drop target. Alt at release copies a tab view. A normal move removes only its original view, retaining the shared document and undo history. Settings keeps its existing single-owner movement rule.

The gesture captures its workspace generation and source group/path. Both source and destination are checked again before committing. Escape, pointer cancellation, lost capture, window blur, source removal, workspace transition, group removal, and component disposal cancel the gesture. A completed or canceled drag suppresses its ensuing pointer click; the next pointerdown restores ordinary clicks. Keyboard activation is not suppressed.

## Verification boundary

A failing-first Chromium regression blocked every HTML `dragstart`, then reproduced the old failed tab movement. The pointer implementation passes that same scenario, including Explorer-to-group opening. Helper tests cover threshold and primary-pointer rules, capture, copy modifiers, click suppression, stale sources/targets, cancellation, and listener cleanup. Browser checks cover dirty shared text, cancellation and ordinary click/close interaction.

These browser tests exercise the production frontend without HTML dragging. They do not constitute native WebView2 or Windows runtime evidence. Native external file drops remain unchanged and need their existing platform acceptance checks. No full cross-platform dragging or VS Code parity claim is made.
