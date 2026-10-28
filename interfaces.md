# Phase 0.1 implemented interfaces

Rust owns workspace paths, disk access, buffer revisions, settings, syntax, and agent subprocesses. SolidJS stores coordinate the visible editor state and send versioned transactions. The generated bindings and registered Rust commands are authoritative.

## Type generation

The compatible contract stack is `specta = 2.0.0-rc.26`, `tauri-specta = 2.0.0-rc.26`, and `specta-typescript = 0.0.13`. Payloads derive serde serialization and `specta::Type`. Regenerate `ui/src/bindings.ts` after changing registered commands or payload types:

```sh
cargo run --release -p span-desktop --features dev-tools --bin export-bindings
```

`ui/src/lib/client.ts` is the frontend adapter. Native calls use generated commands; the browser branch exposes the explicit in-memory preview and rejects native saving and agent connections.

## Workspace, buffers, search, and settings

| Registered Rust command | Behavior |
| --- | --- |
| `open_workspace` | Validate and select the native workspace root. |
| `list_directory`, `list_files` | Return entries confined to the opened workspace. |
| `open_buffer` | Return initial text, language, revision, and saved revision. |
| `edit_buffer_delta` | Apply ordered UTF-16 changes against an expected revision and return revision metadata without resending the full document. |
| `save_buffer`, `discard_buffer` | Save a checked revision or restore the authoritative saved state. |
| `search`, `search_stream`, `cancel_search` | Run bounded search or stream channel results with a cancellation identity. |
| `get_settings`, `update_settings`, `update_settings_jsonc` | Read and validate effective settings, including JSONC input. |
| `syntax` | Return bounded highlighting, folds, guides, language, and revision. |

Text edit ranges use UTF-16 offsets in the pre-transaction document. Rust converts offsets for rope operations, rejects stale revisions and invalid ranges, and enforces workspace confinement. Failed saving preserves the draft. Frontend split groups share document state and history; acknowledgements must not overwrite a newer draft.

## ACP commands and channels

| Registered Rust command | Behavior |
| --- | --- |
| `agent_registry`, `agent_installed`, `agent_install` | Discover registry entries and install supported pinned npm distributions. |
| `agent_connect` | Start one configured local ACP subprocess in the workspace and deliver events through a Tauri channel. |
| `agent_prompt`, `agent_cancel`, `agent_disconnect` | Manage the active prompt and connection lifecycle. |
| `agent_permission` | Resolve a specific pending permission with an offered option or cancellation. |
| `agent_review` | Accept or reject a complete proposal against the expected buffer revision. |
| `agent_review_hunks` | Apply selected hunk IDs atomically against the expected revision. |

`AgentEvent` carries session identity for relevant updates: text, thoughts, plans, tools, permissions, proposals, resolutions, and turn completion. Status, error, and raw log events are also delivered. The current desktop bridge has one active agent connection; several concurrent sessions are later-phase work.

Proposals contain a base revision and stable hunk IDs with Current and Suggested text. Selection and preview do not mutate the buffer. Applying selected hunks checks the base revision, leaves the resulting buffer dirty for explicit saving, and rejects stale review attempts. Revision races must preserve newer user drafts.

Agent subprocesses retain the operating system user's capabilities. Review controls apply to the editor-managed callback flow and do not establish an operating system sandbox.

## Ownership

Core defines workspace, buffer, search, settings, and proposal types. Syntax supplies tree-sitter outputs. ACP supplies process transport and session behavior. Desktop registers commands, creates application state, and generates bindings. UI consumes this contract through the client adapter and renders meaningful unavailable and failure states.
