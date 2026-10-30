# Registered language server file watches

Issue: [#74](https://github.com/1kentom/span/issues/74). Primary source review: 2026-10-29.

The [LSP 3.17 watched file specification](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/workspace/didChangeWatchedFiles.md) recommends client-owned filesystem watching and dynamic registration. Its rules include string and RelativePattern globs, optional Create/Change/Delete masks, and file or folder notifications. The mask for Delete is 4, while the corresponding event type is 3. Registration and unregistration acknowledgements must not race later notification filtering.

The separate [workspace folder notification specification](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/workspace/didChangeWorkspaceFolders.md) describes mutations to a running server's folder set. Span currently opens one workspace and replaces its previous language server instances on folder changes. This change does not implement a multi-folder workspace model or claim dynamic folder mutation support.

## Selected integration

- Reuse the existing native, recursive workspace watcher and its 65 ms coalescing window. Do not add a watcher per server or a polling workspace traversal.
- Emit the actual scoped filesystem paths. Renames become Delete plus Create. Directory events describe that directory only, without invented descendant changes. Outside paths and escaping symlinks are excluded, including deleted paths whose nearest existing ancestor must be checked.
- Keep normal hidden configuration files eligible. Background dependency/protected and ignore filtering is independent of Explorer visibility toggles. Deleted paths require lexical ignore matching, not a walker that depends on the entry still existing.
- Retain events only for starting or ready server instances that existed when the batch arrived. A bounded, non-starting readiness lookup precedes delivery; a startup timeout reports the lost notifications. Capture the workspace generation and server epoch, discard retired work, and leave server startup to existing explicit document lifecycle and installation flows.
- Clients filter each batch using their own active registrations, with masks and globs. Registration updates and notification writes share an async mutex. A new instance starts with no registrations from the old instance.
- Bound native batches and pending service work. An overflow, ambiguous event or delivery timeout produces a refresh/restart diagnostic instead of fabricated blanket notifications. The existing file index reconciliation continues independently.

Only the opened workspace's native watcher supplies events, and each client further confines notifications to its initialized server root. That root may be a nested project. RelativePattern registrations outside that server root do not create additional observations, including sibling projects inside the opened workspace.

## Verification status

The candidate includes main through `fd69103`, including the external buffer safety change. This bridge adds no IPC command or generated contract. The existing watcher revision still drives open-buffer checks independently of LSP visibility and ignore filtering.

The protocol foundation has framed stdio fixtures for registration, invalid registration atomicity, masks, glob forms, unregister, multiple roots and restart isolation. Independent source review found no concrete blocker in that foundation. The desktop bridge adds nine bounded path/ignore/rename cases, a real filesystem watcher to registered fake-server fixture, a no-implicit-start regression and bounded/generation-scoped pending-work coverage. Source review caught and corrected both startup-event loss and ambiguous split-rename kind inference. The startup fixture explicitly verifies delivery after Starting becomes Ready; rename regressions distinguish tracked pairs from unrelated tracker-less operations. The final narrow review found no remaining concrete blocker. Candidate `a5d5ad9` passed 15 focused release/dev-tools tests: nine path/ignore/rename cases, one bounded queue/lifecycle case, one manager root/restart case, three framed protocol cases, and the real watcher to registered fake-server case. The owning crate entry points were refreshed after another worktree used the shared cache, and the new test names and fixture behavior were observed. The initial compile caught a mistaken extra Tauri-state access on an already cloned Arc; it was corrected before the passing rerun. The dependency lock adds only the existing ignore and globset edges, with no version changes. A later source check found that deduplicating a whole batch by URI and event kind could erase recreate/redelete transitions. Both mapper and client now track each path's latest kind, including transitions filtered by visibility or registration masks. Two additional mapper/wire regressions and an extended mask regression cover that case. Hosted CI also exposed a race between the queue assertion and Tauri's independent consumer thread. The regression now holds the production state mutex while enqueueing and inspecting bounds; its lifecycle assertions remain. PathBuf keys also avoid the original URI interior-mutability Clippy warning. The narrow independent reviews are clear, and the corrected 17-case candidate passed the full Linux test shards and macOS check in CI `40840108725`, including strict Clippy and real language server tests. Windows found an absolute-glob fixture built from native backslashes; the fixture now supplies portable forward-slash glob syntax. The corrected Windows rerun remains a gate.

Reproduction commands, run from the repository root:

```sh
cargo test --release --locked -p span-lsp -p span-desktop --features span-desktop/dev-tools --lib --test protocol_regression --test manager watched
cargo test --release --locked -p span-lsp -p span-desktop --features span-desktop/dev-tools --lib the_existing_native_watcher_reaches_a_registered_ready_server
```

The backend test build uses the same placeholder frontend bundle seam as hosted CI; no native UI or installed app is exercised. Strict hosted Clippy, full CI and native acceptance remain gates. No production server or multi-root parity claim follows from fixtures.

## 2026-10-29: scoped watches and quiet recovery

vtsls kept showing "Restart this language server" after installs and builds. The native event channel holds 1024 events, and an install or build in `node_modules`, `.pnpm-store`, `target` or a nested `_work/*` checkout filled it before any filtering ran. Exclusions applied only after the batch was already marked incomplete. macOS renames (`Modify(Name(Any))`) and Windows writes (`Modify(Any)`) also fell into the unknown-kind arm, so an atomic save alone could trigger the warning.

- Dependency and build folders (`node_modules`, `target`, `dist`, `build`, `out`, `.next`, `.turbo`, `.cache`, `.pnpm-store`, `.span`) and nested checkouts (a directory with a `.git` file) are filtered before anything can mark a batch incomplete. Version control folders always stay excluded. The user-only `languageServers.watchIncludeDirectories` setting re-includes named folders.
- Undirected renames and unspecific modifications are resolved by checking whether the path exists. A native overflow only affects language servers when a dropped event touched a path a server could be watching.
- Events are coalesced over 100 ms (create then delete cancels out), capped at 8192 paths with an overflow flag, and sent in notifications of at most 500 changes.
- Lost notifications first trigger a bounded resync scan limited to the globs the server registered. Repeated loss restarts the server automatically with 1, 2 and 4 second backoff, at most 3 times in 10 minutes. The popover status line shows "Refreshing TypeScript server" and then that it was refreshed; there is no toast. Only after the restarts are used up does one warning toast appear, with a one-click Restart and "Don't warn again for this server" (the user-only `languageServers.silencedWatchWarnings` setting). A manual restart resets the counters.

Verified with fixtures only: `watch_sync` unit tests in span-lsp, the desktop service and `watched_paths` regressions, core settings tests for the two keys, and a UI fixture test for the store, popover line and toast. No real vtsls run, native window or installed app exercised this change; native acceptance on macOS and Windows remains a gate.
