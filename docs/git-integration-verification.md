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

## Continued GitHub and Git workflow implementation

Commit `ef7e607` added GitHub CLI transport and UI, session opt-in background fetch, general merge/cherry-pick/revert controls, a three-way text conflict editor, staged gutter, full-file blame/heatmap, split/word comparison and repository/worktree management. Merge `8361607` preserved main's PR #199 Agents-panel changes alongside the Git toolbar badge. The full integrated UI run passed 3,058 tests in 274 files, and 13 browser Git workflows passed on that merged source. Those browser tests use explicit mocked IPC.

Hosted run `40895716314` at `8502b33` failed because a test-only newline setup edit was accidentally inserted inside assertion macro arguments. It is retained as a failed run. Correction `a65e937` passed local checks, but hosted run `40897558377` exposed real Windows path defects in local cloning and worktree locking. The other platform, language-server, UI and browser jobs passed. These failures are not recorded as green checks.

The follow-up fixes normalize native absolute clone/remote paths for Git without rewriting HTTPS or SCP transport syntax, compare native and Git-reported worktree paths consistently, and identify the main worktree separately from the current linked worktree. Real linked-worktree tests now reject main removal/locking and permit unlocking the current linked worktree. Git's primary documentation guarantees that the main worktree is listed first. Windows-specific DOS and UNC regressions remain dependent on hosted Windows execution.

Further UI regressions bind Mark resolved and integration controls to displayed snapshots, preserve dirty merge drafts, adopt only matching post-save snapshots, retain GitHub state across ordinary status polls and invalidate review confirmation when the displayed head changes. Failed GitHub detail reads no longer display unknown counts as zero. Read retries target the selected item, and bounded CLI diagnostic classification provides guidance without echoing arbitrary credential-bearing output.

Latest local follow-up evidence: 3,063 UI tests across 274 files, 267 core tests passed with two explicit ignores, generated bindings, formatting and strict workspace Clippy. The opt-in actual GitHub core transport acceptance was separately exercised successfully, including repository metadata, PR details, reviews/checks and head-bound paged patches. No hosted mutation was executed by that acceptance test. Latest desktop, production build, browser and published-head checks are tracked on the PR and completion checklist, rather than inferred from an earlier head.

## Installed continuation runtime

A separately identified macOS debug review app was rebuilt from runtime source `8502b33`, installed with bundled UI at `tauri://localhost`, and locally ad hoc signed. Strict signature verification passed. Its executable SHA256 is `75c33a09395e0e770cc53b6d129bf7d6784b12dbd1577fb934c744bc78b7597d`. Later test-only assertion fixes do not alter that runtime, but the subsequent Windows/main-worktree/UI fixes are not included in it.

Actual interaction in a disposable repository verified session enable, one-minute automatic fetch from a local remote, discovery of a newly created remote branch, full native merge conflict inspection, accepting both sides, saving, resolved staging and Continue. Git inspection confirmed the resulting two-parent merge commit `03d87b96`, exact saved result, no unmerged entries and a clean working tree. The clean editor reloaded during the conflict and after the saved resolution. Native worktree creation on a new branch, locking and opening the linked directory also succeeded, and the new workspace required fresh Git consent.

Native GitHub authentication and the actual PR list succeeded. A PR detail request failed with a transport error, while an independent CLI detail request succeeded; the first observation is not counted as successful native PR-detail acceptance. No review or PR was posted during this native check. The native folder picker left Open disabled for the valid temporary fixture, so the fixture was opened through the application's supported CLI startup path. Folder-picker recovery and the rebuilt follow-up GitHub/worktree runtime remain explicit gates. Raw screenshots, manifests, paths and test repositories remain local.

## Phase 3 source and automated evidence

The prior phase 2 published-head run [40905440358](https://github.com/1kentom/span/actions/runs/40905440358) passed all required checks at `a578b38`, including platform checks. This is phase 2 evidence only. Phase 3 was subsequently published as `d59f982` in PR #195 and has not inherited that hosted verification.

Phase 3 adds reviewed selected-line staging with Git-normalized text and metadata snapshots, exact-HEAD amend with hook handling, all-ref history/search, HEAD reflog, revision content/comparison, bounded line history, selected-remote operations and first push with explicit upstream intent, standalone welcome-screen clone, and worktree opening in a separate process. Workspace-scoped SHA256 session keys and startup restoration fixes support independent workspace restoration. Source presence does not establish native correctness or full reference-product parity. Partial-staging mode handling was corrected to follow effective core.filemode and owner-executable semantics. Ten focused tests passed, including 30 real-Git stage/unstage comparisons (95.97 seconds). The corrected full core rerun passed 288 tests with two ignored cases in 136.37 seconds, including the 30 mode comparisons.

| Layer | Current phase 3 result and boundary |
| --- | --- |
| Frontend | 3,087 tests passed across 278 files. TypeScript and the production UI build passed after authoritative binding regeneration. |
| Rust core | The initial phase 3 run passed 287 tests with two explicit ignored cases. After the mode correction, the final rerun passed 288 with two ignored in 136.37 seconds, including 30 mode comparisons. These are local automated results, not hosted platform acceptance. |
| Desktop library | 193 passed. Adapter/process/session tests do not replace installed window/startup acceptance. |
| Rust quality | Strict workspace Clippy passed again after the partial-staging correction and the development binding-export guard fix. |
| Browser | 20 dedicated Git Playwright workflows passed in 45.8 seconds on an isolated server, with explicit mocked IPC. The six added workflows cover first-push review invalidation, selected IDs and failed-selection retention, stale-HEAD amend, advanced history filters/reflog/revision, welcome clone retry/open, and validated new-window callbacks. These do not execute native Git or window creation. |
| Native | Phase 3 rebuilt app acceptance pending. Earlier installed runtime observations remain limited to the separately identified binaries above. |
| Hosted | Phase 3 is published as `d59f982` in PR #195. Exact-head hosted checks have not yet been verified. The green phase 2 run is not substituted. |

The active completion checklist retains both the new acceptance gates and the broader unfinished Git/GitHub scope. No hosted write, native phase 3 operation, signing/notarization, release channel or full GitLens/VS Code/Zed parity is claimed by these automated results. Local logs and raw acceptance artifacts remain outside publication.

During phase 3 verification, launching an older installed debug runtime overwrote the generated bindings through its startup exporter. The authoritative bindings were regenerated and verified, and the startup export guard now uses `#[cfg(dev)]` instead of `debug_assertions`, so bundled debug apps do not export source bindings on launch. TypeScript, production build and strict workspace Clippy passed after this correction. The native bundle built; no actual phase 3 native mutation is counted yet.

## Rejected polish and earlier rail overhaul

The user rejected the visual polish published in phase 3 commit `d59f982` in [PR #195](https://github.com/1kentom/span/pull/195), and [issue #210](https://github.com/1kentom/span/issues/210) remains open for a complete overhaul. Earlier completed checkboxes represent checks that ran, not accepted visual quality. Inspection of the older native UI showed a faint staged marker and an expanded wall of remote controls, supporting the user's feedback.

The earlier rail overhaul added full-lane hunk button rails, dashed staged and solid working markers, a keyboard/accessibility CodeMirror bridge with one Tab stop per hunk, retained untouched rails while typing and cleared touched rails, and structured 40-row index/live previews. Review saved preserves the current draft and prefix. Remotes are compact and collapsed with an explicit empty state and checkbox correction; the repository path is compact after consent. Remote summaries use the project Iconsax chevrons.

The full overhaul UI run passed 3,104 tests across 279 files in 117.68 seconds. TypeScript and the production build passed. Twenty-four dedicated browser workflows passed in 60 seconds with mocked IPC. These include actual rendered geometry and accessibility checks, light theme, 20-pixel editor font, wrapping, folding, scrolling and narrow layouts. They do not establish native Git behavior or installed acceptance.

A locally ad hoc signed native overhaul test bundle was built. Actual native overhaul and zoom acceptance are pending, as are exact-head hosted checks and the broader functional completion gates. Issue #210 is not complete. Raw screenshots, visual artifacts and local logs remain ignored and outside publication.

## Current structural sidebar revision

The user also rejected the initial rail overhaul at local head `54645eb`, rating the sidebar 0/10. The current structural redesign integrates incoming main revision `83cc464`; that hash identifies incoming main, not a completed integration commit. Neither visual revision has acceptance. #210 remains open.

The current source puts repository basename and branch in the header, provides six icon navigation items with a responsive selected label, and moves repository management into a header popup instead of an idle body band. A 64-pixel two-row composer keeps Amend options collapsed, with concise commit/count feedback, a hint and a neutral disabled state. Changes are collapsible, separate filename from directory, use 14-pixel status indicators and fixed 48-pixel actions shown on hover or focus, and omit empty sections. Narrow overflow at 230 pixels and short-name truncation were caught and corrected. Direct inspection covered 230-pixel dark and 348-pixel light renders.

Twenty-eight Git browser workflows passed in 60 seconds. They use mocked IPC with real rendered CSS/geometry checks at 230, 348 and 500 pixels in dark/light themes, plus menu, draft, focus and safety coverage. This is not native acceptance. The merged core suite passed 311 tests with two ignored in 324.36 seconds. The combined Specta binding export, including checkpoint and Git commands, and TypeScript passed. The final production UI build passed in 3.96 seconds, and strict workspace Clippy passed in 14.40 seconds.

The first merged desktop run passed 199 tests and failed three. These exposed an excluded-path watcher rescan-budget regression, an outdated unsupported Rename Any fixture after main added support, and an asynchronous LSP didOpen log race. After the source corrections, the final desktop rerun passed all 203 tests in 12.72 seconds. The full UI run passed 3,193 tests and failed one outdated closed FailureReason list after main added four reasons. Only that explicit test list was updated; the final full UI rerun passed all 3,194 tests in 286 files in 128.83 seconds.

Integration source excludes private `refs/span` entries from all-ref history. Checkpoint disk mutations share the editor workspace gate and dirty/refresh authority. New desktop dirty-buffer, serialization and partial-reload tests passed in the final 203-test suite. Actual native and exact-head hosted acceptance for this source remain open.

[Issue #222](https://github.com/1kentom/span/issues/222) records a separately reproduced native caret defect at `54645eb`: moving Up from 3:3 reached 2:8 with blame enabled versus 2:3 with blame disabled; Undo restored the blank text but left the caret at 2:37. The issue includes native proof and a source audit. Its fix is outside the authorized current review task and remains open for user review.

No visual acceptance, completed Git/GitHub objective, release readiness or hosted verification is inferred from these results. The remaining hosted merge, issue actions, review threads, signing setup, interactive rebase, submodule and multi-repository scope stays active. Raw native proof, screenshots and machine-specific artifacts remain local.

## Current branch and integration boundary

[PR #195](https://github.com/1kentom/span/pull/195) merged as `b14e0ca`. Main revision `84767a9` includes ignored-file protection for worktree removal and follow-up fixes through [PR #224](https://github.com/1kentom/span/pull/224). The unpublished `feature/git-ui-overhaul` branch at `d8e7b23` contains the initial rails and second structural sidebar design and is now integrating that incoming main.

The 311 core, 203 desktop, 3,194 UI and 28 browser passing results above belong to `d8e7b23`, before this latest integration. They are not verification of the new merge. Latest-merge automated results are recorded below; exact-head hosted checks remain pending. A separate Sidebar Review native app built from `d8e7b23` is installed; actual native acceptance remains pending. Neither rejected visual revision nor issue #210 is accepted or complete. The separately reported caret issue #222 and the broader unfinished Git/GitHub scope remain open.

## Latest incoming-main verification

The latest integration source passed 3,216 UI tests in 289 files (144.87 seconds), 203 desktop tests (13.81 seconds), and 321 core tests with two ignored (235.63 seconds). The desktop semantic merge restored Show Usage menu handling. Strict workspace Clippy completed successfully in 2 minutes 14 seconds. The final production UI build after authoritative Show Usage binding regeneration passed in 4.18 seconds. These results supersede the earlier pre-integration counts for their respective layers; a final integration commit is still pending.

All 28 Git browser workflows passed in 1.2 minutes with mocked IPC and real rendering checks. The initial run had 27 passes and one timeout and remains a recorded failed run; it is not counted as a pass.

Actual native inspection of the separately installed `d8e7b23` Sidebar Review app exposed spontaneous closing of the outer details-based repository popup. Source now uses an explicit button and a mounted hidden popup, with 14 focused tests passing. A newly built native runtime and acceptance of this correction remain pending. Neither the automated passes nor this identified native defect establishes visual acceptance or completion of #210. Exact-head hosted checks and the broader Git/GitHub completion gates remain open.

### Native repository actions refresh correction

The separate native review build at `0bfec5c` confirmed that replacing the outer disclosure alone did not stop the popup from closing. Source investigation found that the repository-context effect closed it on every context refresh, including new context objects with the same repository ID. The corrected callback compares the current and previous IDs. A focused regression replaces context and status objects for the same repository, verifies the open popup and remote/commit drafts survive, then changes repository identity and verifies dismissal. All 15 Source Control tests passed. Rebuilt native acceptance for this additional correction remains pending.
