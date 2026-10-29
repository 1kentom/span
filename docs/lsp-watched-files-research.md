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

Only the opened workspace's native watcher supplies events. RelativePattern registrations naming paths outside that workspace do not create additional observations.

## Verification status

The candidate includes main through `fd69103`, including the external buffer safety change. This bridge adds no IPC command or generated contract. The existing watcher revision still drives open-buffer checks independently of LSP visibility and ignore filtering.

The protocol foundation has framed stdio fixtures for registration, invalid registration atomicity, masks, glob forms, unregister, multiple roots and restart isolation. Independent source review found no concrete blocker in that foundation. The desktop bridge adds nine bounded path/ignore/rename cases, a real filesystem watcher to registered fake-server fixture, a no-implicit-start regression and bounded/generation-scoped pending-work coverage. Source review caught and corrected both startup-event loss and ambiguous split-rename kind inference. The startup fixture explicitly verifies delivery after Starting becomes Ready; rename regressions distinguish tracked pairs from unrelated tracker-less operations. The final narrow review found no remaining concrete blocker. Candidate `a5d5ad9` passed 15 focused release/dev-tools tests: nine path/ignore/rename cases, one bounded queue/lifecycle case, one manager root/restart case, three framed protocol cases, and the real watcher to registered fake-server case. The owning crate entry points were refreshed after another worktree used the shared cache, and the new test names and fixture behavior were observed. The initial compile caught a mistaken extra Tauri-state access on an already cloned Arc; it was corrected before the passing rerun. The dependency lock adds only the existing ignore and globset edges, with no version changes. A later source check found that deduplicating a whole batch by URI and event kind could erase recreate/redelete transitions. Both mapper and client now track each path's latest kind, including transitions filtered by visibility or registration masks. Two additional mapper/wire regressions and an extended mask regression cover that case. Hosted CI also exposed a race between the queue assertion and Tauri's independent consumer thread. The regression now holds the production state mutex while enqueueing and inspecting bounds; its lifecycle assertions remain. PathBuf keys also avoid the original URI interior-mutability Clippy warning. The narrow independent reviews are clear, and execution of the corrected 17-case candidate remains a hosted CI gate.

Reproduction commands, run from the repository root:

```sh
cargo test --release --locked -p span-lsp -p span-desktop --features span-desktop/dev-tools --lib --test protocol_regression --test manager watched
cargo test --release --locked -p span-lsp -p span-desktop --features span-desktop/dev-tools --lib the_existing_native_watcher_reaches_a_registered_ready_server
```

The backend test build uses the same placeholder frontend bundle seam as hosted CI; no native UI or installed app is exercised. Strict hosted Clippy, full CI and native acceptance remain gates. No production server or multi-root parity claim follows from fixtures.
