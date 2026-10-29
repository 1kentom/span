# Settings and Auto Save compatibility

Span implements its own settings system with selected VS Code setting names and familiar User and Workspace scopes. This is a defined compatibility subset, not the complete VS Code settings API or extension configuration system.

## Scopes and editing

Effective values resolve in this order: built-in defaults, User settings, then Workspace settings. User settings live in the Span profile's `settings.jsonc`. Workspace settings live in `.span/settings.jsonc`. Span does not automatically load `.vscode/settings.json` or another editor's user settings. Copy supported entries into a Span settings file deliberately.

The User view shows user values with defaults inherited. The Workspace view includes user values inherited by the project. Reset removes a setting from the selected scope, including its recognized alias, so the lower-priority value becomes effective. A reset does not write the built-in default over a user preference.

The file icon opens settings JSONC in a full editor tab for the selected scope. JSONC accepts comments and trailing commas. Graphical changes and per-setting resets retain unrelated comments, formatting and unknown raw keys. JSONC drafts require an explicit Save action. Invalid known values are rejected before the file is replaced, and a failed save keeps the draft available for correction. Unknown keys are preserved without applying them.

The settings search accepts setting names, supported dotted identifiers, `@id:` text, and `@modified`. Modified filtering refers to overrides in the selected scope.

## Supported VS Code names

| VS Code setting | Span legacy name | Behavior and limits |
| --- | --- | --- |
| `files.autoSave` | `autoSave` | `off`, `afterDelay`, `onFocusChange`, `onWindowChange`. The default is `afterDelay`. |
| `files.autoSaveDelay` | `autoSaveDelay` | Integer milliseconds, 0 to 3,600,000. Default 1,000. Applies to `afterDelay`. |
| `editor.wordWrap` | `wordWrap` | Dotted form accepts `on` or `off`. Legacy form accepts a boolean. `bounded` and `wordWrapColumn` are rejected as unimplemented. |
| `editor.fontSize` | `fontSize` | Integer pixels, 8 to 40. |
| `editor.fontFamily` | `editorFontFamily` | Font family string, 1 to 200 characters. The font must be installed or have a usable fallback. |
| `editor.tabSize` | `tabSize` | Integer indentation size, 1 to 8. |
| `editor.formatOnSave` | `formatOnSave` | Boolean. Uses Span's configured language formatter and existing Save pipeline. |
| `window.zoomLevel` | `zoomLevel` | Fractional levels from -5 to 5. An explicitly configured value applies to the current window. `null` leaves the global window zoom preference in effect. |

Aliases are normalized separately in each scope before inheritance is applied. A Workspace legacy setting therefore overrides a User dotted setting. If both forms occur in one scope, the dotted setting takes precedence. Changing or resetting a setting through the per-setting API removes the competing form.

Other Span settings, including theme, interface typography, Markdown preview defaults, panel behavior, portable keybindings and formatter executable arguments, retain their Span names. The generated IPC contracts are derived from the Rust settings model.

## Auto Save behavior

After delay debounces each open, dirty file independently. On focus change requests a save when the edited document loses focus. On window change requests saves when the application window loses focus. Switching Auto Save off cancels pending scheduled saves.

Auto Save delegates to the existing serialized Save path so pending editor transactions are flushed before disk writes. It does not accept staged agent edit proposals. Once a proposal has been explicitly accepted, its dirty buffer can be saved like another accepted document edit.

Settings JSONC always requires explicit Save and skips format on save. Closed documents, obsolete workspace generations and replaced revisions are checked before queued writes start. Failed writes retain dirty state. An unchanged failed revision is not repeatedly retried; a later edit observes a bounded backoff, and the controller exposes a quiet failure state for the interface.

User settings buffers use a separate trusted native route to the known Span profile file. Virtual settings buffer IDs are rejected by general filesystem and agent routes. A user-only context supports editing before a workspace is opened and cannot resolve arbitrary filesystem paths. Settings saves also check the original disk signature so an external change produces a conflict instead of overwriting another edit.

## Deliberately unsupported

The following are preserved as raw keys when present, but have no runtime effect: extension-contributed preferences, language override blocks such as `[rust]`, remote and policy scopes, multi-root folder settings, profiles and Settings Sync, VS Code color customization objects, formatter-provider selection, and the wider VS Code editor and workbench setting catalog. Keybindings use Span commands and portable shortcut strings. They do not implement VS Code's `when` expression engine.

This foundation does not claim that most of the thousands of VS Code settings work. The table above is the supported dotted-key contract.

## Verification and sources

Rust tests cover alias normalization, inheritance, resetting to an inherited value, validation before writing, Unicode comments, nested unknown values, preserving raw settings during graphical updates, invalid editor drafts, disk conflicts, stale settings revisions and rejection through general agent and filesystem routes. Fake timer tests cover independent debounce, serialized saves, edits during writes, workspace replacement, closed buffers, disabled modes, quiet failures, backoff and settings-file exclusions. Settings page tests cover the four save modes, delay controls, scope requests, editor file actions, dirty-draft guards, scoped reset, modified filtering and fractional window zoom. Browser tests do not establish native filesystem persistence or native window focus delivery; those require verification in the rebuilt desktop application.

Behavior was checked against the official [VS Code settings documentation](https://code.visualstudio.com/docs/configure/settings), [file setting declarations](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/files/browser/files.contribution.ts), [desktop zoom setting declaration](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/electron-browser/desktop.contribution.ts), and [configuration scope defaults](https://github.com/microsoft/vscode/blob/main/src/vs/platform/configuration/common/configurationRegistry.ts). VS Code's zoom setting inherits `WINDOW` scope from the registry's default, so it can be configured for a workspace window. Span's validated ranges and supported key set are intentionally narrower.
