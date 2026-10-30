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

The current uncommitted overhaul adds full-lane editor hunk button rails, dashed staged and solid working markers, a keyboard/accessibility CodeMirror bridge with one Tab stop per hunk, retained untouched rails during typing and clearing of touched rails, and a structured preview bounded at 40 rows for index/live content. Its Review saved action preserves the draft and its prefix. Remotes are compact and collapsed, with explicit empty state and checkbox fixes, and the repository path becomes compact after consent. Summary chevron cleanup is still in progress.

The overhaul passed 3,104 UI tests in 279 files (117.68 seconds), TypeScript, the production build and 24 browser workflows (60 seconds). Browser IPC remains mocked; actual rendering checks cover geometry, accessibility, light theme, 20-pixel editor font, wrapping, folding, scrolling and narrow layouts. A locally ad hoc signed test bundle was built, but actual native overhaul and zoom acceptance remain pending. Inspection of the older native UI showed the faint staged marker and remote wall that supported the user's feedback. Issue #210 remains open.

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
- [ ] Complete and obtain acceptance for the visual overhaul in #210, including actual native and zoom checks. Automated passes do not close this issue.
- [ ] Audit completion against every original requirement. Keep the objective active while any requirement is missing or unverified.

Raw supplied design references and machine-specific acceptance artifacts remain local. Earlier runtime provenance and hosted failures remain in [the verification ledger](git-integration-verification.md). No stable release, notarization or full reference-product parity is claimed.
