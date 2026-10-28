# Supported shortcut map

Checked 2026-10-28 against the official [VS Code default keyboard shortcuts](https://code.visualstudio.com/docs/reference/default-keybindings) and [keyboard rule documentation](https://code.visualstudio.com/docs/configure/keybindings). Span supports its own command registry and focus rules; matching familiar shortcuts does not implement VS Code's complete keybinding engine.

The requested **Cmd+E shows and focuses the Files sidebar** and **Cmd+P opens Go to**. Cmd+E is a deliberate Span customization. VS Code's documented factory Explorer shortcut is Cmd+Shift+E on macOS (Ctrl+Shift+E on Windows/Linux), retained as an alias. VS Code's factory Open File shortcut is Cmd+O; Span keeps Mod+O for its existing Open Folder action and leaves the separate native file picker unbound. `Mod` below means Command on macOS and Control elsewhere.

| Span action | Default | Comparison or explicit choice |
| --- | --- | --- |
| Toggle Files / Show Files | Mod+E / Mod+Shift+E | Mod+E (`toggleFiles`) closes Files when it is open and otherwise switches to Files, shows the sidebar and focuses the tree. Mod+Shift+E (`focusFiles`) always shows and focuses Files; repeating it does not hide the sidebar. |
| Open File | Unbound | Available from the native File menu, command palette and welcome screen. It does not own Cmd+E. |
| Go to File | Mod+P; also Ctrl+P on macOS | Mod+P matches VS Code Quick Open; macOS Control alias was requested separately. Mod+E and standalone Mod+K are no longer default Go to aliases. |
| Open Folder | Mod+O | Existing Span choice, distinct from VS Code's Open File default. |
| Show All Commands | Mod+Shift+P | Familiar VS Code command entry. |
| Find in File / Search in Files | Mod+F / Mod+Shift+F | Familiar current-file and workspace distinction. |
| Open Settings / Save / Close Editor Tab | Mod+, / Mod+S / Mod+W | Familiar macOS defaults; platform close defaults can differ. Close Tab does not quit Span. |
| Split Editor / Toggle Project Panel | Mod+\\ / Mod+B | Familiar split and sidebar defaults. |
| Toggle AI Assistant | Mod+Alt+B | Span's assistant panel action; not a provider or extension command. |
| Toggle Terminal Panel | Mod+J | Span panel toggle, not VS Code's dedicated terminal shortcut. |
| Toggle Word Wrap / Markdown Preview / Format Document | Alt+Z / Mod+Shift+V / Alt+Shift+F | Familiar actions; formatting requires Span's configured formatter. |
| Zoom In / Zoom Out / Reset Zoom | Mod+= (also Mod+Shift+=) / Mod+- / Mod+0 | Whole-workbench zoom. Span accepts its documented reset variant rather than requiring the numpad reset key. |
| Go to Line | Ctrl+G / Mod+Alt+G | Ctrl+G matches the documented VS Code default; Mod+Alt+G is Span's additional alias. |
| Go to Definition / Type Definition / Implementation | F12 / Mod+Shift+F12 / Mod+F12 | `goToDefinition`, `goToTypeDefinition`, `goToImplementation`. Familiar VS Code keys. |
| Peek Definition / Type Definition / Implementation | Alt+F12 / unbound / unbound | `peekDefinition` is Alt+F12 as in VS Code. `peekTypeDefinition` and `peekImplementation` have no default and can be bound in Keyboard settings. |
| Find All References / Peek References | Shift+F12 / Shift+Alt+F12 | `findReferences`, `peekReferences`. |
| Go to Symbol in File / Workspace | Mod+Shift+O / Mod+T | `goToSymbolInFile` is editor focus; `goToSymbolInWorkspace` is available throughout the workbench. |
| Show Quick Definition | Mod+Shift+I | `quickInfo`. |
| Show Call Hierarchy / Show Type Hierarchy | Shift+Alt+H / Mod+Alt+H | `showCallHierarchy`, `showTypeHierarchy`. |
| Rename Symbol | F2 | `renameSymbol`, editor focus. |
| Go Back / Go Forward | Mod+Alt+ArrowLeft / Mod+Alt+ArrowRight | `goBack`, `goForward`. |
| Format with Language Server | Mod+Alt+Shift+F | `formatWithLanguageServer`, editor focus. Rebindable like every command above. |

Code navigation commands all dispatch to one registry (`ui/src/lib/navigation-actions.ts`). Until a language feature registers a handler, running the command shows "Not available for this file". Function keys (F1 to F24) may be bound alone or with Shift; every other key still needs Mod, Ctrl, Meta or Alt. The new navigation defaults were checked against every existing default, the native menu accelerators and the CodeMirror keymaps in use (default, search, fold, completion, history and Span's own). F12 is also bound inside the editor by the language server extension, which handles it first when the editor has focus. In a browser preview, Ctrl+T and Ctrl+Shift+I are browser shortcuts and may not reach the page.

Explicit user/workspace overrides remain authoritative. If an existing explicit binding claims one of the new Toggle Files, Show Files or code navigation defaults, only that overlapping inherited key becomes unassigned; the saved binding is retained. Explicit conflicting assignments are still rejected. No shortcut migration rewrites user files.

Show Files selects Files even when Search, Git or History was selected, makes the sidebar visible and focuses an existing tree item (or the empty tree). It preserves the active editor draft. Toggle Files (`toggleFiles`) hides Files only when it is already the visible sidebar view. The `focusFiles` and `toggleFiles` commands are shared by the keybinding table, palette and native View menu. Go to remains separate under Navigation and the native Go menu.

Open File requests one file through the native dialog. Cancel does nothing. A file inside the current workspace opens there without replacing it; the workspace root is checked again after the picker returns. An outside file uses the existing typed startup-request queue and unsaved-project guard. Failures are visible, and concurrent picker requests are ignored while a selection is pending. Welcome Open a file, the command palette, keybinding table and native File menu use the distinct, initially unbound `openFile` command.

Regression evidence: [command dispatch and overrides](../ui/src/lib/commands.test.ts), [native picker options and errors](../ui/src/lib/file-picker.test.ts), [keybinding table](../ui/src/components/KeyboardSettings.test.tsx), [Rust command/schema/collision validation](../crates/core/src/settings.rs), and [browser picker/event fixtures](../e2e/open-file-shortcuts.spec.ts). Browser fixtures prove application routing and draft preservation; they do not operate a physical OS dialog. Native verification must use the rebuilt application for [#65](https://github.com/1kentom/span/issues/65).
