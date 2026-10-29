# Git and GitHub completion

The active objective is complete Git integration and GitHub support, including automatic fetching, merge conflicts, worktrees and the earlier GitLens, VS Code and Zed feature comparison. This checklist preserves that breadth. Passing the currently implemented subset does not complete the objective.

## Current implementation and evidence

| Workflow | Current source | Evidence and remaining acceptance |
| --- | --- | --- |
| Repository setup | Exact-folder init, bounded clone into a new reserved directory, remote add/edit/remove and upstream settings. | Disposable repository tests and generated desktop IPC. Setup from the empty welcome screen and first push of a new branch remain open. |
| Automatic fetch | Explicit per-repository session opt-in, interval control, hidden/offline pause, noninteractive transport, error-stop behavior and last-fetch feedback. | Held-response tests prove the editor stays writable, foreground Git work is serialized and old workspace results are dropped. Native scheduled transport acceptance remains separate. |
| Branches/worktrees | Safe rename/delete, new branch/detached worktrees, current-window opening, lock/unlock and reviewed metadata prune. | Disposable repository tests and browser new/lock/prune flow. New-window opening and multi-repository/submodule management remain open. Git prune has no external-process compare-and-swap interface; the reviewed listing is checked immediately before Git's own operation. |
| Merge integration | General pinned merge, cherry-pick/revert and existing rebase controls, real conflict stages, reviewed save and resolved staging, guarded continue/abort. | Seven focused real repository merge tests and browser manual/three-way resolution flows. Binary, rename and add/delete conflict editors are explicitly unavailable. Interactive rebase and richer sequencing remain open. |
| Editor/review | Separate staged and working gutters, exact live blame, full-file blame/heatmap, split/unified diff and bounded word emphasis. | Focused CodeMirror/view tests and browser blame/commit navigation. Arbitrary range staging, added/deleted/renamed-file hunks, line history and CodeLens remain open. |
| GitHub | Existing `gh` credentials, displayed repository binding, PR/issue list and details, default branch metadata, commit-bound file patches/reviews, checks, PR creation and pinned checkout. | Actual read-only core transport acceptance against GitHub, typed response tests, adapter repository-retarget rejection and browser explicit mutation/error/draft tests. Hosted mutations have not been exercised against a live service by these tests. Enterprise and other providers remain open. |

The core suite passed 265 tests with two explicit ignored cases (the existing OS Trash case and opt-in GitHub network acceptance). The latter was separately run and passed. The desktop suite passed 191 tests. Strict workspace Clippy and generated bindings passed. Thirteen explicit-IPC browser workflows passed, including a real status-poll boundary. These browser cases do not execute native Git or hosted writes.

The broad UI run initially exposed a one-second lazy archive import wait under load. The isolated archive suite passed; its exact-content wait is now bounded at three seconds. A later full rerun failed during import with `ENOSPC`, rather than assertion failures. Those failed results are retained, and the subsequent two-worker full rerun passed all 3,042 tests in 271 files. The production UI build also passed. A rebuilt installed native app and exact-head hosted CI remain separate acceptance gates.

## Unfinished scope

- [ ] Complete the remaining rows in [the feature matrix](git-expanded-workflows.md), including init/clone from the welcome screen, first push, richer history/reflog and comparisons, range staging, amend/signing setup, line history, interactive rebase, submodules and multi-repository workflows.
- [ ] Add remaining GitHub workflow controls, including hosted merge, issue actions and review-thread handling, with explicit targets, drafts, stale-state guards and realistic error paths.
- [ ] Exercise the newly built native GitHub, auto-fetch, merge-conflict and worktree UI. Do not substitute the earlier installed review binary's runtime evidence.
- [x] Pass the complete UI suite and production build after machine disk pressure is resolved (3,042 tests, 271 files, two workers).
- [ ] Publish and pass exact-head hosted checks for the new source.
- [ ] Audit completion against every original requirement. Keep the objective active while any requirement is missing or unverified.

Raw supplied design references and machine-specific acceptance artifacts remain local. Earlier runtime provenance and hosted failures remain in [the verification ledger](git-integration-verification.md). No stable release, notarization or full reference-product parity is claimed.
