# Expanded Git verification record

Checked 2026-10-29 for [#186](https://github.com/1kentom/span/issues/186). The behavior and remaining parity work are specified in [expanded Git workflows](git-expanded-workflows.md).

## Source and review

Implementation commits are `29fa3f1`, `e925be4` and `bcc7fc3`. Merge `a36e304` preserves current main through `f2e260d`, including Usage and delegated-agent lifecycle/trust changes. `e6742ad` repairs native menu ownership for Usage after that integration. Final pinned merge `6bfd558` includes main through `98d3d62`, preserving Usage import, wide Agents layouts and the smaller panel grips. Native polish `d547970` keeps reviewed actions available during background polling and collapses verbose successful stash output; `8da4900` updates browser assertions for that presentation. All work is isolated on `feature/git-complete`; existing changes in the main checkout were preserved.

An independent Claude Sonnet CLI audit reviewed the original boundaries without edits. Its refresh race, stale history, dirty-buffer and process outcome findings informed the implementation. A separate independent review of the expanded implementation reproduced two concrete defects in temporary repositories: custom diff prefixes could stage the wrong file, and repository protocol configuration could bypass the intended remote restriction. Both were fixed with real-repository regressions. Re-review reported no remaining confirmed blocking finding in the reviewed scope. The browser reviewer did not implement the product UI and inspected the resulting screenshots, keyboard flows, errors and narrow layouts.

An OpenCode read-only audit was attempted but its configured provider rejected the request under the existing privacy policy. No privacy setting was changed, and no OpenCode review is counted as completed.

## Automated evidence

| Layer | Actual result and boundary |
| --- | --- |
| Rust core library | 235 passed, one existing OS Trash case ignored. Includes settings command/schema checks and real temporary Git repositories/remotes. |
| Git-specific core suite | 42 passed, including 13 advanced-operation regressions, reviewed index/HEAD/file snapshots, custom diff prefixes, protocol restrictions and ignored-file preservation. |
| Desktop library | 188 passed after the watcher and native menu fixes. Includes native draft rejection, held workspace mutex, clean-buffer reload and watcher loss/scoping checks. |
| Rust quality | `cargo fmt --all -- --check` and strict `cargo clippy --workspace --all-targets -- -D warnings` passed. |
| IPC | Regenerated through the actual Specta exporter after integration. No duplicated handwritten IPC contracts. |
| Frontend | 2,914 tests passed across 258 files on `d547970`. TypeScript and the production Vite build passed. Existing chunk-size and ineffective dynamic-import warnings remain. |
| Browser | Nine Git flows passed on `d547970` at isolated port 1421, including the compact stash notice and collapsed diagnostic output. These use explicit mocked IPC, not real Git. Consent, live line decorations, keyboard views, hunk staging, remote failures/configuration changes, stash/worktree controls, rebase resolution and Agents-to-Git navigation are covered. |

The final native install is recorded in the completion addendum below after its last verification. Passing browser fixtures is not native process evidence. Actual native remote fetch/push tests use disposable local remotes in backend tests; no hosted credential/provider flow was exercised.

Earlier failures remain part of the record: the first broad UI run exposed three fixture storage leaks and missing Git native menu entries; a subsequent merged run exposed main's missing Usage menu ownership. The final reruns followed those fixes. An initial browser run reused an existing main-checkout server, so it is excluded from feature evidence. The subsequent runs use an isolated server rooted in the feature worktree.

## Native observation before the final install

A separately identified local review app was installed and opened with bundled UI at `tauri://localhost`. In a disposable repository, native interaction verified session enable, actual status, working/staged review, reviewed hunk staging, local commit and history. The later standalone build also showed the live modified-line gutter, current-line blame, change navigation and index/current-buffer preview. Stash Save reloaded a clean open editor from version 2 to version 1; applying the reviewed stash restored version 2 while retaining both stash entries. Branch creation switched to the new branch and updated the repository header.

A stash Apply attempted over saved local changes was refused by Git without overwriting the file. The configured Auto Save mode had saved the test draft on focus change, so that observation is not counted as a native unsaved-buffer rejection. Unsaved rejection is separately covered by the desktop adapter and browser regressions.

Native testing exposed a false lost-filesystem-notification warning. macOS FSEvents reports Git metadata renames with an unclassified rename kind; the watcher marked those incomplete before excluding Git metadata. A failing-first regression reproduced the defect. The fix ignores only endpoints proved excluded or outside scope, while retaining warnings for genuine global loss, pathless/visible/ambiguous events and delivery limits. All 13 watcher tests and all 188 desktop library tests passed afterward.

The review build is local debug software with an ad hoc signature. It is not a production replacement, Developer ID signature, notarized release, updater-channel verification, performance certification or Windows/Linux native acceptance. Raw screenshots, installation manifests, logs and design references stay local.

## Completion addendum

The final review installation uses runtime source `d547970` (plus the browser-only assertions in `8da4900`) on macOS 27.0 arm64. Its bundled UI opens at `tauri://localhost`, independently of the browser development server. The executable SHA256 after local ad hoc signing is `46a5eefca6445c5eeefd920518a1f3f7e10464379fad7d77d24f932b57ca4b21`. Strict on-disk signature verification passed. The production Span installation was preserved.

Direct interaction with that installation verified a reviewed hunk stage against the actual index and a local reviewed-index commit (`ce271f78` in the disposable test repository). It also verified stash Save/Apply, immediate clean-buffer reconciliation, retained stash identities, compact success feedback and expand/collapse of complete command output. No new lost-filesystem-notification warning appeared during the final Save/Apply cycle, and TypeScript remained ready. The app is left showing live line decoration, mapped blame and the compact stash result. This does not imply that every native error/cancel/platform path was exercised.

The final automated frontend result is 2,914 passes in 258 files, plus a successful TypeScript/production UI build. The final browser result is nine passing explicit-IPC workflows. Rust source is unchanged by the last frontend polish: 235 core passes, one existing ignored Trash case, 188 desktop passes and strict formatting/Clippy remain the final local Rust evidence. The held-status-response regression confirms that a background refresh does not disable valid reviewed actions or overwrite a newer mutation result.

Publication and hosted checks are tracked in [draft PR #195](https://github.com/1kentom/span/pull/195). Hosted CI is separate from this local evidence; no cross-platform pass is inferred from the macOS installation. #186 remains open for the explicit feature parity gaps in the matrix. No website, stable release or updater channel was changed by this work.

## Hosted test fixture corrections

The first exact-head hosted run [40873204940](https://github.com/1kentom/span/actions/runs/40873204940) failed and is preserved as a failed run. It exposed stale panel-grip expectations after the approved 1.03 hover-size change, Windows fixture assumptions about LF checkout bytes and Unix-only filenames, and platform/asynchronous real-language-server fixture defects. It is not counted as a green hosted verification.

The corrections preserve the product behavior and the assertions: temporary Git repositories explicitly set their local newline policy, Windows uses a valid leading-dash/bracket filename, and dedicated CRLF coverage remains. Twelve panel-handle browser regressions pass with the smaller intended transform. The 42 Git core and five desktop Git regressions pass after fixture isolation.

Protocol trace review showed rust-analyzer publishing cached ranges with a new document version before asynchronous recomputation. The real-server wait now requires the correctly shifted full ranges, while retaining its final UTF-16 assertion, original timing bounds and recovery nudges. Windows server checks now use native process enumeration/cleanup and ordinary drive/UNC fixture paths for Node. Three focused regressions and feature compilation pass; no production LSP logic was changed. The published-head rerun in PR #195 remains the authority for Windows and real-server results.

## Explorer integration after the green hosted run

Exact-head run [40876533551](https://github.com/1kentom/span/actions/runs/40876533551) passed all required checks at `bb8ceb7`, including the corrected Windows/ARM real-server cases and the full browser suite; `meta` was skipped. Main then gained Explorer transfer and keyboard-focus work in PR #196. Merge `0ed0ce0` preserves its filesystem exports and focused tree rows alongside the expanded Git types and status decorations.

The integrated frontend has 2,922 passing tests in 259 files, a successful TypeScript/production build, and 11 passing focused browser cases (nine Git workflows and two Explorer keyboard flows). The separate native artifact retains the explicitly recorded runtime provenance above; it is not substituted for native acceptance of the unrelated new Explorer features. PR #195's published-head checks remain the authority for the final merged source, rather than inheriting the earlier head's green status.
