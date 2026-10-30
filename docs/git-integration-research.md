# Local Git integration: research and selected boundary

The expanded editor Git work in [#186](https://github.com/1kentom/span/issues/186) is specified in [expanded Git workflows](git-expanded-workflows.md). The first-cut boundaries below describe the original delivery, not the final scope of that expansion.

Checked **2026-10-29** for [#110](https://github.com/1kentom/span/issues/110) and its five bounded children. This records primary-source observations and the selected Span contract during implementation. It does **not** establish that this research preceded every earlier change, that the implementation meets the contract, or that the reference editors were exercised locally. Local core/desktop/UI acceptance and independent review now pass at `fc34d6f`; hosted CI/publication and installed Git acceptance remain pending. See the dated verification ledger for exact counts and the preserved earlier parallel timeout failure.

## Primary-source comparison

| Reference | Observed contract | Span selection |
| --- | --- | --- |
| [VS Code staging and commits](https://code.visualstudio.com/docs/sourcecontrol/staging-commits) | Save, stage, local commit and push are distinct. Working and staged versions can coexist. File/range staging is available; some empty-index commit behavior depends on settings. | Separate working/staged review and require explicit whole-file staging. Commit only the reviewed index; never implicitly stage or push. |
| [Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust), [Git package declaration](https://github.com/microsoft/vscode/blob/main/extensions/git/package.json), [repository model](https://github.com/microsoft/vscode/blob/main/extensions/git/src/model.ts) | Restricted Mode limits automatic project execution. The inspected Git package declares `capabilities.untrustedWorkspaces.supported=false`; parent-repository opening defaults to `prompt`. The model requests trust for the common Git directory parent before opening a repository and initial status. | An inline, session-scoped Enable Git action precedes status. Parent/full-repository scope must be explicit. This is Span's chosen boundary, not a claim to reproduce all Workspace Trust behavior. |
| [Zed Git](https://zed.dev/docs/git) | The panel exposes repository/branch, working tree and staging; changes made externally refresh. File/hunk staging and file history are documented. Some panel commit flows automatically stage tracked files. | Keep explicit actions and dedicated read-only review/history views. Do not adopt implicit staging or editable diff excerpts in this cut. |
| [Fleet 1.18, historical](https://blog.jetbrains.com/fleet/2023/05/fleet-preview-update-1-18-is-out-with-prettier-on-save-net-unit-testing-in-tree-test-rerun-safe-quitting-updated-debug-console-git-integration-improvements-and-more/) and [retirement notice](https://blog.jetbrains.com/fleet/2025/12/the-future-of-fleet/) | The 2023 release described partial commits selected in the diff while retaining other changes. The retirement notice ends further Fleet updates and distribution from December 22, 2025. | Span's whole-file scope is narrower than that historical partial-commit feature. No current Fleet, IntelliJ or Air contract is substituted. |

The VS Code source URLs use the moving `main` branch, inspected on the date above; they are not a pinned release guarantee. No reference-product parity or performance benchmark is claimed.

## Selected Span contract

### Consent and exact context before Git

A temporary-repository investigation actually observed a configured clean filter execute during an ungated status operation. A status scan is therefore not treated as inherently free of repository-controlled execution. The decision is an inline **Enable Git for this session** action before status, not automatic Git activation when a folder opens.

Every core Git entry point must enforce the enabled session and exact workspace/repository identity before invoking repository Git operations. Direct IPC calls cannot bypass the UI gate. Workspace/repository replacement or revocation invalidates stale requests and replies; a previous session's enabled bit is not transferable.

The Git context covers the **full repository**, even when the editor opened only a subfolder. Show the actual repository scope before enabling operations; a parent repository and repository-wide/all-entry actions must not be presented as subfolder-only. This consent does not widen the normal editor filesystem boundary.

### Read-only views and explicit index actions

Working changes compare index to disk; staged changes compare HEAD to index. Use dedicated read-only Git views and paged repository/file history. Virtual view identifiers must not become ordinary filesystem buffer paths or acquire Save/Format/edit behavior. Normal editor documents, dirty drafts and undo history must stay unchanged.

Stage/unstage targets whole files or an explicitly disclosed all-entry scope. Do not save editor drafts implicitly, discard working bytes, force ignored files, or expand literal paths into unrelated pathspecs. Unsupported/conflicted states need honest feedback.

### Local commit of the reviewed staged snapshot

The compatibility floor for this Span cut is **Git 2.30**; it is a selected implementation requirement, not a claim about other editors. The private-index review guard must bind the local commit to the reviewed index snapshot and expected repository/HEAD. External index/HEAD changes require a fresh review rather than silently committing different content.

Keep normal Git hooks and signing behavior. Do not bypass them to make a commit succeed. Failures retain the message and editor drafts; never auto-reset the index or working files. Hooks are executable user/repository configuration, so inspect and report resulting state instead of promising to undo arbitrary hook side effects. Hook-induced snapshot changes must not silently widen reviewed content.

There is no implicit push, fetch/pull/sync, discard/reset/clean, amend, branch switch or remote mutation in this first cut. No hunk-staging or complete reference-editor feature claim is added.

## Acceptance still to verify

| Boundary | Required evidence |
| --- | --- |
| Disabled session | Marker/process fixtures show no Git status or other core operation runs before explicit enable, including direct IPC attempts. The existing clean-filter execution observation proves the risk, not a passed gate. |
| Exact repository/workspace | Parent/subfolder, linked-worktree, replacement/revocation and held-response cases preserve identity and disclose full scope. |
| Index actions | Literal special filenames, partial staging, unborn/rename/delete, locks and external changes preserve unrelated index entries and working bytes. |
| Reviewed local commit | Private-index/HEAD race, hook mutation/rejection, missing identity, signing failure and retry preserve the intended snapshot/message without bypasses. |
| Dedicated views | Read-only diff/history/virtual tabs do not call ordinary filesystem save/edit paths or disturb dirty editor history. |
| Delivery | Core/desktop checks, generated IPC, independent review, browser fixtures and exact installed-native Git acceptance, each labeled by source revision. |

The [verification matrix](current-verification.md) records actual evidence separately. No pending test or review is counted as passed here, and no issue is closed by this research record.
