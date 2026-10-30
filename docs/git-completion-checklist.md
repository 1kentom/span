# Git and GitHub completion

The active objective is complete Git integration and GitHub support, including automatic fetching, merge conflicts, worktrees and the earlier GitLens, VS Code and Zed feature comparison. This checklist preserves that breadth. Passing the currently implemented subset does not complete the objective.

## Current implementation and evidence

| Workflow | Current source | Evidence and remaining acceptance |
| --- | --- | --- |
| Repository setup | Exact-folder init, bounded clone into a new reserved directory, remote add/edit/remove and upstream settings. | Disposable repository tests and generated desktop IPC. Phase 3 adds standalone welcome-screen clone and selected-remote first push with explicit upstream intent. Mocked-IPC browser coverage is recorded below; native acceptance remains open. |
| Automatic fetch | Explicit per-repository session opt-in, interval control, hidden/offline pause, noninteractive transport, error-stop behavior and last-fetch feedback. | Held-response tests prove the editor stays writable, foreground Git work is serialized and old workspace results are dropped. Native scheduled transport acceptance remains separate. |
| Branches/worktrees | Safe rename/delete, new branch/detached worktrees, current-window opening, lock/unlock and reviewed metadata prune. | Disposable repository tests and browser new/lock/prune flow. Phase 3 adds separate-process worktree opening and workspace-scoped session persistence. Mocked-IPC browser coverage validates the opening callback; actual native process/session acceptance and multi-repository/submodule management remain open. Git prune has no external-process compare-and-swap interface; the reviewed listing is checked immediately before Git's own operation. |
| Merge integration | General pinned merge, cherry-pick/revert and existing rebase controls, real conflict stages, reviewed save and resolved staging, guarded continue/abort. | Seven focused real repository merge tests and browser manual/three-way resolution flows. Binary, rename and add/delete conflict editors are explicitly unavailable. Interactive rebase and richer sequencing remain open. |
| Editor/review | Separate staged and working gutters, exact live blame, full-file blame/heatmap, split/unified diff and bounded word emphasis. | Focused CodeMirror/view tests and browser blame/commit navigation. Phase 3 adds reviewed changed-line selection, normalized text and metadata snapshots, and bounded line history. Partial staging mode handling now follows effective core.filemode and owner-executable semantics, with focused real-Git comparisons passing. Function-level CodeLens remains open. |
| GitHub | Existing `gh` credentials, displayed repository binding, PR/issue list and details, default branch metadata, commit-bound file patches/reviews, checks, PR creation and pinned checkout. | Actual read-only core transport acceptance against GitHub, typed response tests, adapter repository-retarget rejection and browser explicit mutation/error/draft tests. Hosted mutations have not been exercised against a live service by these tests. Enterprise and other providers remain open. |

Phase 3 source adds explicit exact-HEAD amend with hook handling, all-ref history and search, HEAD reflog, revision content/comparison, bounded line history, selected-remote operations and first push, standalone welcome-screen clone, and worktree opening in a separate process. Workspace-scoped SHA256 session keys and startup restoration fixes accompany the new-window workflow. These are source and automated-test claims, not installed acceptance.

The current phase 3 automated run passed 3,087 UI tests in 278 files, 288 core tests with two explicit ignored cases, and 193 desktop tests. TypeScript, the production UI build and strict workspace Clippy passed after the partial-staging correction and authoritative binding regeneration. Ten focused partial-staging tests, including 30 comparisons against real Git stage/unstage behavior, passed. The corrected full core rerun passed in 136.37 seconds. Twenty dedicated Git browser workflows passed with explicit mocked IPC. Phase 3 rebuilt native acceptance remains pending.

The previous phase 2 exact-head hosted run [40905440358](https://github.com/1kentom/span/actions/runs/40905440358) passed all required platform checks at `a578b38`. It does not verify phase 3 source. Earlier browser workflows use explicit mocked IPC, and the installed native evidence has its own runtime provenance in the ledger.

Phase 3 was published as `d59f982` in [PR #195](https://github.com/1kentom/span/pull/195). Exact-head hosted checks have not yet been verified. The user rejected the visual polish and opened [#210](https://github.com/1kentom/span/issues/210) for a complete overhaul. Earlier completed verification checkboxes record executed checks, not visual acceptance.

The earlier rail overhaul added full-lane editor hunk button rails, dashed staged and solid working markers, a keyboard/accessibility CodeMirror bridge with one Tab stop per hunk, retained untouched rails during typing and clearing of touched rails, and a structured preview bounded at 40 rows for index/live content. Its Review saved action preserves the draft and its prefix. Remotes are compact and collapsed, with explicit empty state and checkbox fixes, and the repository path becomes compact after consent. That revision was subsequently rejected; the current structural revision is recorded below.

The earlier rail overhaul passed 3,104 UI tests in 279 files (117.68 seconds), TypeScript, the production build and 24 browser workflows (60 seconds). Browser IPC remains mocked; actual rendering checks cover geometry, accessibility, light theme, 20-pixel editor font, wrapping, folding, scrolling and narrow layouts. A locally ad hoc signed test bundle was built, but actual native overhaul and zoom acceptance remain pending. Inspection of the older native UI showed the faint staged marker and remote wall that supported the user's feedback. Issue #210 remains open.

## Unfinished scope

- [ ] Complete the remaining rows in [the feature matrix](git-expanded-workflows.md), including phase 3 acceptance for welcome-screen clone, first push, expanded history, selected-line staging, amend, line history and separate-process worktree opening, plus remaining signing setup, interactive rebase, submodules and multi-repository workflows.
- [ ] Add remaining GitHub workflow controls, including hosted merge, issue actions and review-thread handling, with explicit targets, drafts, stale-state guards and realistic error paths.
- [ ] Exercise the newly built native GitHub, auto-fetch, merge-conflict and worktree UI. Do not substitute the earlier installed review binary's runtime evidence.
- [ ] Verify the follow-up native main/current-worktree controls and GitHub detail-error recovery. Runtime `8502b33` verified actual auto-fetch, a two-parent resolved merge, worktree creation/locking/opening and GitHub auth/list; native PR details and folder-picker recovery remain unverified.
- [x] Pass the phase 3 complete UI suite (3,087 tests, 278 files).
- [x] Correct partial-staging mode handling and pass focused tests, final TypeScript/strict Clippy and production UI build.
- [x] Complete the corrected full core rerun (288 passed, two ignored).
- [x] Exercise phase 3 browser workflows with explicit IPC fixtures (20 passed), recorded separately from native operation.
- [ ] Exercise phase 3 rebuilt native clone, first push, amend, selected-line staging, history and separate-process worktree/session restoration paths.
- [ ] Pass exact-head hosted checks for published phase 3 `d59f982`, then publish and verify the current overhaul.
- [ ] Complete and obtain acceptance for the current structural sidebar redesign in #210, including actual native and zoom checks. Both earlier visual revisions were rejected.
- [x] Pass final merged desktop (203 tests), full UI (3,194 tests in 286 files), strict Clippy and the final production UI rebuild after the recorded corrections.
- [ ] Keep the separately reported native caret defect #222 open for user review; its fix is outside the current authorized review task.
- [ ] Audit completion against every original requirement. Keep the objective active while any requirement is missing or unverified.

Raw supplied design references and machine-specific acceptance artifacts remain local. Earlier runtime provenance and hosted failures remain in [the verification ledger](git-integration-verification.md). No stable release, notarization or full reference-product parity is claimed.

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
