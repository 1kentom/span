# Expanded Git workflows

## Current published status

The structural Git sidebar source is published in [draft PR #225](https://github.com/1kentom/span/pull/225) at `f24b76a`, following merged PR #195. Earlier unpublished-branch and pending-integration statements below are historical checkpoints. Native testing of the exact `f24b76a` ad hoc review app passed local first push, selected-line staging, staged commit, message-only amend, history/reflog and worktree creation. Separate-process opening is only partially verified; child visual/session restoration and native zoom acceptance remain open. User visual acceptance and #210 completion are not claimed.

Exact-head hosted run [41016639250](https://github.com/1kentom/span/actions/runs/41016639250) passed every job except the Windows check, which exposed two test-fixture defects. Fixture-only corrections now pass both focused macOS tests and strict core Clippy; a complete green hosted rerun remains pending. The broader unfinished Git/GitHub scope remains active.

Research checked 2026-10-29 for [#186](https://github.com/1kentom/span/issues/186). This expands the intentionally bounded first local Git cut in [the original research](git-integration-research.md). Source presence, automated verification, installed acceptance and reference-product parity are distinct.

## Primary-source behavior matrix

| Source | Relevant behavior | Span implementation target and acceptance |
| --- | --- | --- |
| [VS Code source control](https://code.visualstudio.com/docs/sourcecontrol/overview) | Editor changes, review, staging, graph, branch status and conflicts connect to the same repository. | Index-to-live-buffer markers, accessible file/folder/tab badges, separate staged/working review, current branch and explicit remote actions. Unsaved editor changes must never be staged implicitly. |
| [VS Code branches and worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees) | Branches isolate history, stashes save unfinished changes, and worktrees provide separate folders. | Real branch lists and checkout/create, immutable stash identities and linked-worktree operations. Reject dirty buffers before tree changes and reload clean documents afterward. Refuse force removal. |
| [Zed Git](https://zed.dev/docs/git) | Gutter indicators, current-line authorship, panel review and hunk staging provide context near code. | Bounded exact line diffs, changed-line navigation, hunk preview, mapped current-line blame and reviewed hunk staging. Changed lines must not inherit historical authorship. |
| [GitLens core features](https://help.gitkraken.com/gitlens/gitlens-features/) | Blame connects lines to commits; file history and comparison explain changes. | Current-line annotation, file-scoped history and commit file inspection. Keep author/date/subject legible and offer a session toggle. |
| [GitLens graph](https://help.gitkraken.com/gitlens/gl-commit-graph/) | A connected workbench presents topology and repository work. | Render actual commit parent relationships, explicit branches/stashes/worktrees views and revision-bound details. Do not invent graph connections or counts. |
| [Historical Fleet partial commits](https://blog.jetbrains.com/fleet/2023/05/fleet-preview-update-1-18-is-out-with-prettier-on-save-net-unit-testing-in-tree-test-rerun-safe-quitting-updated-debug-console-git-integration-improvements-and-more/) | Selected changes can form a commit while other changes remain. | Hunk operations use a regenerated server patch, expected index revision and current file snapshot. Stale requests fail without changing the index. |

These are documentation observations, not local execution of the reference products. The local supplied archive is visual inspiration only. Its scripts are never executed, and raw inputs are excluded from publication.

## Interaction contract

Use Span's existing compact editor typography, surfaces and supplied Iconsax artwork. Changes, history, branches, stash and worktrees share one repository header. Distinguish actions from metadata; communicate running, empty, unavailable and failed states inline. Use short opacity/color/transform transitions for user-triggered changes, visible keyboard focus and reduced-motion overrides. Directional navigation uses chevrons.

Git remains opt-in for each workspace session. The full repository scope, including a parent repository for a subfolder workspace, remains visible before enable. No network request, checkout, stash or worktree mutation happens because a view was opened. Explicit mutations retain normal Git helper, hook and signing behavior. Errors preserve drafts and do not trigger automatic retries of uncertain side effects.

Working-tree changes reject unsaved native buffers. The frontend checks dirty state before starting and becomes read-only while a Git mutation runs; the backend holds its workspace lock through the dirty check and mutation. After success, the existing external-file reconciliation path reloads clean buffers with revision checks, preserves any new draft and refreshes directory listings. This is required to prevent a later Save from overwriting newly checked-out content.

Stash Apply retains its entry. Destructive stack-index deletion is not exposed unless it can be bound atomically to the reviewed stash identity. External Git activity can shift reflog indices, so a preflight check alone is insufficient.

## Verification and remaining breadth

Record actual results after implementation in the issue and verification ledger. Required regressions cover disabled-session IPC, stale repository/index/file snapshots, hostile literal filenames, temp repositories and local remotes, dirty buffer protection, line diff insert/delete/replace behavior, stale asynchronous responses, keyboard access and reduced motion.

The integration must not be described as complete GitLens, VS Code or Zed parity. Account-backed pull request review, hosted issues, provider-specific AI features, arbitrary history rewriting, signing setup, multi-repository selection, submodule management and complex merge/rebase continuation require their own implemented workflows and evidence. A shell command or an enabled button does not establish any of those features.

## Implemented coverage and remaining parity work

| Area | Present in this implementation | Additional work for literal product parity |
| --- | --- | --- |
| Editor context | Index-to-live-buffer line markers, deletion anchors, change navigation and previews, file/folder/tab badges, exact HEAD-mapped current-line blame, statusbar authorship, a separate staged gutter, full-file blame and an age heatmap. | Function-level authorship CodeLens and expanded line/revision navigation beyond the bounded phase 3 controls. Phase 3 line-history and revision views still need browser/native acceptance. |
| Review and staging | Working/staged unified diffs, whole-file stage/unstage, reviewed hunk staging for ordinary modified text, staged-snapshot commits, preserved failed drafts, split diff layout and bounded word highlighting. Phase 3 adds changed-line selection with Git-normalized text and metadata snapshots, plus exact-HEAD amend with hooks. | Focused partial-staging tests now cover effective core.filemode and owner-executable semantics with real-Git comparisons. Signing configuration UI, broader case acceptance and phase 3 native acceptance remain open. |
| History | Paged repository/file history, loaded-commit filtering, truthful loaded parent lanes, commit metadata and changed-file inspection. File-scoped history does not invent edges across omitted commits. Phase 3 adds all-ref traversal, search, HEAD reflog, revision content/comparison and bounded line history. | Broader ref decorations and comparison/search coverage, guarded history rewriting, and phase 3 browser/native acceptance. Reflog is a read view, not a recovery or rewrite control. |
| Branches and integration | Local/remote branch listing, ahead/behind metadata, create/switch, fast-forward merge, clean-start rebase, saved conflict resolution, reviewed Continue and Abort, branch rename/delete/upstream configuration, general merge, cherry-pick/revert and a three-way text conflict editor. | Interactive rebase, richer commit sequencing and unsupported binary/rename/add-delete conflict editors. |
| Remotes | Redacted configured remote metadata, reviewed configuration fingerprint, explicit fetch, pinned fast-forward pull and explicit non-force upstream push, init/clone, remote add/edit/remove, upstream configuration and session opt-in noninteractive auto-fetch. Phase 3 adds standalone welcome-screen clone and selected-remote operations, including explicit first push/upstream intent. | Phase 3 browser/native clone and first-push acceptance, per-operation progress/cancellation, credential setup and complete multiple-remote workflow acceptance. |
| Stash | Save tracked changes and apply an immutable stash identity while retaining the entry. | Review stash diffs and safe atomic pop/drop. Concurrent reflog-index deletion is deliberately unavailable. |
| Worktrees | List, create from an available local branch and explicitly remove a clean noncurrent unlocked worktree without force, create a new branch/detached worktree, open a worktree in the current window, lock/unlock and reviewed metadata pruning. Phase 3 adds separate-process worktree opening, workspace-scoped SHA256 session keys and startup restoration fixes. | Browser/native verification of separate-process windows and restored workspace sessions, plus multi-repository/submodule selection. |
| Hosted collaboration | GitHub CLI credential reuse, explicit repository selection, PR/issue browsing, PR files/checks/reviews, draft PR creation, commit-bound review submission, hosted links and pinned PR checkout. | GitHub Enterprise and other hosts, issue mutation/review threads, requested reviewers/labels, hosted merge controls, provider-specific AI summaries/commit-message generation and broader hosted-write acceptance. |

The implementation now includes GitHub workflows as well as the expanded local Git workbench. It is not a completed clone of every GitLens, Zed or VS Code feature. See the active [completion checklist](git-completion-checklist.md) for source and verification gates. The outstanding rows remain explicit work under #186. Their acceptance must include real operation/error/cancel evidence, not just controls or transport stubs. Large file decoration work is bounded at 2 MiB and a finite exact-diff budget; expensive comparisons are omitted rather than approximated. Recoverable discard accepts ordinary tracked text up to 1 MiB and leaves the reviewed bytes in private Git metadata. Repository status and normal Git commands can still execute configured helpers after session consent.

## Earlier visual overhaul evidence

The user rejected the phase 3 visual polish published at `d59f982` in [PR #195](https://github.com/1kentom/span/pull/195). [Issue #210](https://github.com/1kentom/span/issues/210) remains open for the complete overhaul. Previously completed checks do not establish user acceptance.

The earlier rail implementation added full-lane hunk button rails, dashed staged versus solid working markers, one keyboard Tab stop per hunk through the CodeMirror accessibility bridge, untouched-rail retention while typing and touched-rail clearing. Structured index/live previews are bounded to 40 rows, and Review saved preserves the current draft and prefix. Remotes are collapsed and compact with an explicit empty state and corrected checkbox behavior; the repository path is compact after consent. That revision was subsequently rejected; the current structural revision is recorded below.

The overhaul has 3,104 passing UI tests in 279 files, a successful TypeScript/production build and 24 passing mocked-IPC browser workflows. Actual browser rendering checks include geometry, accessibility, light theme, 20-pixel editor font, wrapping, folding, scrolling and narrow layouts. The ad hoc native test bundle is built, but actual native and zoom acceptance remain pending. Exact-head hosted verification and the original functional breadth remain separate open gates. Raw visual artifacts stay local and ignored.

## Current structural sidebar revision

The user also rejected the initial rail overhaul at local head `54645eb`, rating the sidebar 0/10. The current structural redesign integrates incoming main revision `83cc464`; that hash identifies incoming main, not a completed integration commit. Neither visual revision has acceptance. #210 remains open.

The current source puts repository basename and branch in the header, provides six icon navigation items with a responsive selected label, and moves repository management into a header popup instead of an idle body band. A 64-pixel two-row composer keeps Amend options collapsed, with concise commit/count feedback, a hint and a neutral disabled state. Changes are collapsible, separate filename from directory, use 14-pixel status indicators and fixed 48-pixel actions shown on hover or focus, and omit empty sections. Narrow overflow at 230 pixels and short-name truncation were caught and corrected. Direct inspection covered 230-pixel dark and 348-pixel light renders.

Twenty-eight Git browser workflows passed in 60 seconds. They use mocked IPC with real rendered CSS/geometry checks at 230, 348 and 500 pixels in dark/light themes, plus menu, draft, focus and safety coverage. This is not native acceptance. The merged core suite passed 311 tests with two ignored in 324.36 seconds. The combined Specta binding export, including checkpoint and Git commands, and TypeScript passed. The final production UI build passed in 3.96 seconds, and strict workspace Clippy passed in 14.40 seconds.

The first merged desktop run passed 199 tests and failed three. These exposed an excluded-path watcher rescan-budget regression, an outdated unsupported Rename Any fixture after main added support, and an asynchronous LSP didOpen log race. After the source corrections, the final desktop rerun passed all 203 tests in 12.72 seconds. The full UI run passed 3,193 tests and failed one outdated closed FailureReason list after main added four reasons. Only that explicit test list was updated; the final full UI rerun passed all 3,194 tests in 286 files in 128.83 seconds.

Integration source excludes private `refs/span` entries from all-ref history. Checkpoint disk mutations share the editor workspace gate and dirty/refresh authority. New desktop dirty-buffer, serialization and partial-reload tests passed in the final 203-test suite. Actual native and exact-head hosted acceptance for this source remain open.

[Issue #222](https://github.com/1kentom/span/issues/222) records a separately reproduced native caret defect at `54645eb`: moving Up from 3:3 reached 2:8 with blame enabled versus 2:3 with blame disabled; Undo restored the blank text but left the caret at 2:37. The issue includes native proof and a source audit. Its fix is outside the authorized current review task and remains open for user review.

No visual acceptance, completed Git/GitHub objective, release readiness or hosted verification is inferred from these results. The remaining hosted merge, issue actions, review threads, signing setup, interactive rebase, submodule and multi-repository scope stays active. Raw native proof, screenshots and machine-specific artifacts remain local.

## Historical branch and integration boundary

[PR #195](https://github.com/1kentom/span/pull/195) merged as `b14e0ca`. Main revision `84767a9` includes ignored-file protection for worktree removal and follow-up fixes through [PR #224](https://github.com/1kentom/span/pull/224). The unpublished `feature/git-ui-overhaul` branch at `d8e7b23` contains the initial rails and second structural sidebar design and is now integrating that incoming main.

The 311 core, 203 desktop, 3,194 UI and 28 browser passing results above belong to `d8e7b23`, before this latest integration. They are not verification of the new merge. Latest-merge automated results are recorded below; exact-head hosted checks remain pending. A separate Sidebar Review native app built from `d8e7b23` is installed; actual native acceptance remains pending. Neither rejected visual revision nor issue #210 is accepted or complete. The separately reported caret issue #222 and the broader unfinished Git/GitHub scope remain open.

## Pre-publication incoming-main verification

The latest integration source passed 3,216 UI tests in 289 files (144.87 seconds), 203 desktop tests (13.81 seconds), and 321 core tests with two ignored (235.63 seconds). The desktop semantic merge restored Show Usage menu handling. Strict workspace Clippy completed successfully in 2 minutes 14 seconds. The final production UI build after authoritative Show Usage binding regeneration passed in 4.18 seconds. These results supersede the earlier pre-integration counts for their respective layers; a final integration commit is still pending.

All 28 Git browser workflows passed in 1.2 minutes with mocked IPC and real rendering checks. The initial run had 27 passes and one timeout and remains a recorded failed run; it is not counted as a pass.

Actual native inspection of the separately installed `d8e7b23` Sidebar Review app exposed spontaneous closing of the outer details-based repository popup. Source now uses an explicit button and a mounted hidden popup, with 14 focused tests passing. A newly built native runtime and acceptance of this correction remain pending. Neither the automated passes nor this identified native defect establishes visual acceptance or completion of #210. Exact-head hosted checks and the broader Git/GitHub completion gates remain open.

## Exact-source native and hosted follow-up

The separate macOS ad hoc Sidebar Review app uses source `f24b76ae91a308370942d363d6b50df95f41b0f6` and binary SHA256 `880f9ee8adf067821f26bbb37d0f29dc007eec219eb5f7668ed172aca2ca8c99`. Actual native interaction and independent repository inspection established:

- First push to a disposable local bare remote sent the exact reviewed SHA and set the explicit upstream, while retaining dirty working files.
- Selecting one removed line changed only the index; the replacement remained unstaged and the working-file hash stayed unchanged.
- A staged commit included the two reviewed staged files and left the README modification and untracked file outside the commit.
- Message-only amend replaced HEAD while retaining its tree and parent and preserving the remaining working files.
- Native history displayed the amended HEAD, initial commit and real branch/remote decorations. HEAD reflog displayed the amend, preceding commit and initial commit.
- New-branch linked-worktree creation succeeded. Open in new window launched a separate process at the correct linked root while retaining the parent. Child visual/session restoration remains unverified because the app binding selected the parent process.

Repository-popup stability now passed native refresh observations after the repository-identity effect fix. Earlier native attempts remain failures: `d8e7b23` closed the details disclosure spontaneously, and `0bfec5c9` still dismissed the popup despite using an explicit button. They are not substituted for the corrected runtime's result.

A one-step native zoom observation showed a stale Worktrees underline while accessibility reported Changes selected. Native zoom acceptance is not established and requires further investigation. User visual acceptance remains pending.

Hosted run [41016639250](https://github.com/1kentom/span/actions/runs/41016639250) at exact source `f24b76a` passed all jobs except Windows. Its first-push fixture compared a canonicalized verbatim URL against a raw path, and a partial-staging fixture used filenames illegal on Windows. These failures are retained. Follow-up changes are restricted to tests, preserving Unix hostile-name cases and adding legal cross-platform cases with target and disk assertions; no production Windows routing change is claimed. The corrected complete hosted run remains pending.

Raw fixture metadata, process identifiers, machine paths and screenshots remain local and ignored. These results do not close #210, #222, child-session/zoom gates or the broader hosted collaboration and Git parity requirements.

The two fixture corrections passed their focused macOS tests: first-push review/upstream in 1.14 seconds and literal-path staging isolation in 9.75 seconds. These local passes do not verify Windows; follow-up strict core Clippy and hosted Windows execution remain pending. Further native interaction stopped when user activity moved the review app to the main workspace; no edits were performed there. Native auto-fetch/merge follow-up remains pending.
