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

The protocol foundation has framed stdio fixtures for registration, invalid registration atomicity, masks, glob forms, unregister, multiple roots and restart isolation. Independent source review found no concrete blocker in that foundation. The desktop bridge adds nine bounded path/ignore/rename cases, a real filesystem watcher to registered fake-server fixture, a no-implicit-start regression and bounded/generation-scoped pending-work coverage. Source review caught and corrected both startup-event loss and ambiguous split-rename kind inference. The startup fixture explicitly verifies delivery after Starting becomes Ready; rename regressions distinguish tracked pairs from unrelated tracker-less operations. The final narrow review found no remaining concrete blocker. Execution of these tests, strict Clippy, current-main integration and native acceptance remain pending. No production server or multi-root parity claim follows from fixtures.
