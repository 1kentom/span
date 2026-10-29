# Expanded Git workflows

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
| Editor context | Index-to-live-buffer line markers, deletion anchors, change navigation and previews, file/folder/tab badges, exact HEAD-mapped current-line blame and statusbar authorship. | Separate staged gutter lane, full-file blame, age heatmap, function-level authorship CodeLens, line history and revision navigation. |
| Review and staging | Working/staged unified diffs, whole-file stage/unstage, reviewed hunk staging for ordinary modified text, staged-snapshot commits and preserved failed drafts. | Split diff layout, word-level highlighting, arbitrary line-range selection, hunk operations for add/delete/rename/mode changes, amend and signing configuration UI. |
| History | Paged repository/file history, loaded-commit filtering, truthful loaded parent lanes, commit metadata and changed-file inspection. File-scoped history does not invent edges across omitted commits. | All-ref graph traversal, ref decorations and comparisons, structured commit search, reflog, cherry-pick/revert and guarded history rewriting. |
| Branches and integration | Local/remote branch listing, ahead/behind metadata, create/switch, fast-forward merge, clean-start rebase, saved conflict resolution, reviewed Continue and Abort. | Branch rename/delete, upstream configuration, general merge initiation/continuation, a three-way merge editor, interactive rebase and commit sequencing. |
| Remotes | Redacted configured remote metadata, reviewed configuration fingerprint, explicit fetch, pinned fast-forward pull and explicit non-force upstream push. | Init/clone, remote add/edit/remove, first push/upstream setup, per-operation progress/cancellation, credential setup and multiple remote selection. |
| Stash | Save tracked changes and apply an immutable stash identity while retaining the entry. | Review stash diffs and safe atomic pop/drop. Concurrent reflog-index deletion is deliberately unavailable. |
| Worktrees | List, create from an available local branch and explicitly remove a clean noncurrent unlocked worktree without force. | Open another worktree in a new window, lock/unlock, prune and multi-repository/submodule selection. |
| Hosted collaboration | No new account-backed hosting integration is claimed. | Pull request and issue browsing/review, checks, provider authentication, hosted links and provider-specific AI summaries/commit-message generation. |

This is an expanded local Git workbench, not a completed clone of every GitLens, Zed or VS Code feature. The outstanding rows remain explicit work under #186. Their acceptance must include real operation/error/cancel evidence, not just controls or transport stubs. Large file decoration work is bounded at 2 MiB and a finite exact-diff budget; expensive comparisons are omitted rather than approximated. Recoverable discard accepts ordinary tracked text up to 1 MiB and leaves the reviewed bytes in private Git metadata. Repository status and normal Git commands can still execute configured helpers after session consent.
